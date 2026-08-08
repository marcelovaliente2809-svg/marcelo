import { timingSafeEqual } from 'node:crypto'
import { DateTime } from 'luxon'
import { z } from 'zod'
import type { FastifyInstance } from 'fastify'
import type { BaseDatos } from '../db/base-datos.ts'
import type { Reloj } from '../puertos/reloj.ts'
import type { RepoCompromisos } from '../repos/compromisos.ts'
import type { RepoIntenciones } from '../repos/intenciones.ts'
import type { RepoAcciones } from '../repos/acciones.ts'
import type { ServicioJornada } from '../servicios/jornada.ts'
import type { ServicioCronica } from '../servicios/cronica.ts'
import type { ServicioAgenda } from '../servicios/agendar.ts'
import type { ServicioDeshacer } from '../servicios/deshacer.ts'
import type { ServicioInstruccion } from '../servicios/instruccion.ts'
import type { ServicioTesoro } from '../servicios/tesoro.ts'
import type { ServicioPropuestas } from '../servicios/propuestas.ts'
import type { ServicioAcceso } from '../servicios/acceso.ts'
import type { ServicioAMano } from '../servicios/a-mano.ts'
import { medirGraduacion } from '../dominio/graduacion.ts'
import type { Transcriptor } from '../puertos/transcriptor.ts'
import { esDeVoz, firmarVoz } from '../dominio/firma-voz.ts'
import { CATEGORIAS } from '../dominio/categorias.ts'
import { DURACIONES, calcularPrioridad, redondearDuracion } from '../dominio/intenciones.ts'

export interface DepsApi {
  /** Sin token no se abre nada: la app enseña movimientos bancarios. */
  token: string
  db: BaseDatos
  reloj: Reloj
  modoSombra: boolean
  jornada: ServicioJornada
  cronica: ServicioCronica
  agenda: ServicioAgenda
  deshacer: ServicioDeshacer
  instruccion: ServicioInstruccion
  /** Si falta, la app no puede mandar audio y lo dice. */
  transcriptor?: Transcriptor
  /** Con esto se firma lo que salió del transcriptor. */
  secretoVoz: string
  repoIntenciones: RepoIntenciones
  repoCompromisos: RepoCompromisos
  /** El libro contable. Sin él, la pantalla Tesoro lo dice en vez de mentir. */
  tesoro?: ServicioTesoro
  /** Lo que ella metería en los huecos, si se lo dejaran. */
  propuestas?: ServicioPropuestas
  repoAcciones: RepoAcciones
  /** El código de un solo uso. Sin Telegram, la app cae al código fijo. */
  acceso?: ServicioAcceso
  /**
   * Hacer las cosas a mano, sin modelo de por medio.
   *
   * Es lo que mantiene la app usable el día que la IA no está: se puede
   * enseñar un compromiso y cancelar un bloque con un formulario. Mismo
   * actuador, misma inversa antes de aplicar, misma auditoría.
   */
  aMano?: ServicioAMano
}

const Mes = z.object({ mes: z.string().regex(/^\d{4}-\d{2}$/).optional() })
const Anio = z.object({ anio: z.string().regex(/^\d{4}$/).optional() })
const Fecha = z.object({ fecha: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() })
const Dias = z.object({ dias: z.coerce.number().int().min(1).max(90).default(14) })
const Id = z.object({ id: z.coerce.number().int().positive() })

const NuevaIntencion = z.object({
  titulo: z.string().min(1).max(200),
  detalle: z.string().max(2000).nullish(),
  prioridad: z.enum(['urgente', 'alta', 'normal', 'baja']).default('normal'),
  duracionMin: z.coerce.number().int().positive().default(30),
  venceEl: z.string().datetime({ offset: true }).nullish(),
  origen: z.enum(['voz', 'texto']).default('texto'),
})

const Agendar = z.object({
  inicio: z.string().min(1),
  origen: z.enum(['voz', 'texto']).default('texto'),
})

const Cerrar = z.object({ estado: z.enum(['hecha', 'descartada']) })

const NuevoPacto = z.object({
  titulo: z.string().min(1).max(200),
  // Lunes es 1, como en Luxon y como en la RRULE.
  dias: z.array(z.coerce.number().int().min(1).max(7)).min(1),
  horaInicio: z.string().regex(/^\d{2}:\d{2}$/),
  horaFin: z.string().regex(/^\d{2}:\d{2}$/),
  alias: z.array(z.string().max(80)).max(10).optional(),
  remitentes: z.array(z.string().max(160)).max(10).optional(),
})
const Veredicto = z.object({ veredicto: z.enum(['acierto', 'error']) })

const Instruccion = z.object({
  texto: z.string().min(1).max(2000),
  // El origen NO lo declara quien llama: se deduce de si el texto viene
  // firmado por el transcriptor. Decir "texto" sobre algo que se dictó
  // saltaría la confirmación que la política le exige a una transcripción.
  boleta: z.string().max(300).optional(),
  canal: z.enum(['web', 'telegram']).default('web'),
})

/** Comparación en tiempo constante: un token no se adivina midiendo respuestas. */
function tokenValido(recibido: string, esperado: string): boolean {
  const a = Buffer.from(recibido)
  const b = Buffer.from(esperado)
  return a.length === b.length && timingSafeEqual(a, b)
}

export function registrarApi(app: FastifyInstance, d: DepsApi): void {
  app.register(async (api) => {
    api.addHook('onRequest', async (req, res) => {
      if (!d.token) {
        return res.code(503).send({ error: 'La API está sin token configurado' })
      }
      const cabecera = req.headers.authorization ?? ''
      const recibido = cabecera.startsWith('Bearer ') ? cabecera.slice(7) : ''
      if (!tokenValido(recibido, d.token)) {
        return res.code(401).send({ error: 'Token inválido' })
      }
    })

    api.get('/estado', async () => {
      const { rows } = await d.db.query<{ ultimo_latido: Date | null }>(
        'SELECT max(ultimo_latido) AS ultimo_latido FROM sync_cuenta')
      const ahora = d.reloj.ahora()
      return {
        ok: true,
        modoSombra: d.modoSombra,
        zonaHoraria: ahora.zoneName,
        ahora: ahora.toISO(),
        ultimoLatido: rows[0]?.ultimo_latido ?? null,
      }
    })

    api.get('/jornada', async (req) => {
      const { fecha } = Fecha.parse(req.query)
      return d.jornada.del(fecha)
    })

    api.get('/cronica', async (req) => {
      const { dias } = Dias.parse(req.query)
      const ahora = d.reloj.ahora()
      const desde = ahora.minus({ days: dias }).startOf('day')
      return {
        // El "hoy" de la crónica es el de Bogotá, no el del teléfono.
        ahora: ahora.toISO({ suppressMilliseconds: true }),
        desde: desde.toISO({ suppressMilliseconds: true }),
        entradas: await d.cronica.desde(desde.toISO()!),
      }
    })

    api.post('/acciones/:id/deshacer', async (req, res) => {
      const { id } = Id.parse(req.params)
      const r = await d.deshacer.deshacer(id)
      return r.ok ? r : res.code(409).send(r)
    })

    api.get('/bandeja', async () => {
      const jornada = await d.jornada.del()
      return {
        fecha: jornada.fecha,
        huecos: jornada.huecos,
        intenciones: await d.repoIntenciones.bandeja(),
      }
    })

    api.post('/intenciones', async (req) => {
      const cuerpo = NuevaIntencion.parse(req.body)
      const ahora = d.reloj.ahora()
      const vence = cuerpo.venceEl
        ? DateTime.fromISO(cuerpo.venceEl, { zone: ahora.zoneName ?? undefined })
        : null

      // La prioridad la decide el código: una fecha límite cercana manda
      // sobre lo que diga el texto, y sólo puede subirla, nunca bajarla.
      const prioridad = calcularPrioridad(
        cuerpo.prioridad, vence?.isValid ? vence : null, ahora)

      return d.repoIntenciones.crear({
        titulo: cuerpo.titulo,
        detalle: cuerpo.detalle ?? null,
        prioridad,
        duracionMin: DURACIONES.includes(cuerpo.duracionMin as never)
          ? (cuerpo.duracionMin as (typeof DURACIONES)[number])
          : redondearDuracion(cuerpo.duracionMin),
        venceEl: vence?.isValid ? vence.toJSDate() : null,
        origen: cuerpo.origen,
      })
    })

    api.post('/intenciones/:id/agendar', async (req, res) => {
      const { id } = Id.parse(req.params)
      const { inicio, origen } = Agendar.parse(req.body)
      const r = await d.agenda.agendar(id, inicio, origen)
      return r.ok ? r : res.code(409).send(r)
    })

    api.post('/intenciones/:id/cerrar', async (req) => {
      const { id } = Id.parse(req.params)
      const { estado } = Cerrar.parse(req.body)
      await d.repoIntenciones.cerrar(id, estado)
      return { ok: true }
    })

    api.get('/pactos', async () => ({
      compromisos: await d.repoCompromisos.listarActivos(),
    }))

    /**
     * Enseñarle un compromiso escribiéndolo, sin pasar por ningún modelo.
     *
     * Existe porque la IA es un añadido: si se acabó la cuota, si el
     * proveedor está caído o si él prefiere escribirlo exacto, tiene que
     * poder. Va por el mismo actuador, con la inversa guardada antes de
     * aplicar y la misma auditoría — no es una segunda vía de escritura,
     * es la misma sin la parte de adivinar.
     */
    api.post('/pactos', async (req, res) => {
      if (!d.aMano) {
        return res.code(503).send({ error: 'No puedo tocar el calendario ahora mismo' })
      }
      const p = NuevoPacto.parse(req.body)
      const r = await d.aMano.ensenarPacto(p)
      return r.ok ? r : res.code(400).send({ error: r.motivo })
    })

    /** Cancelar un bloque del día tocándolo. Aquí no hay nada que resolver. */
    api.post('/jornada/:instanciaId/cancelar', async (req, res) => {
      if (!d.aMano) {
        return res.code(503).send({ error: 'No puedo tocar el calendario ahora mismo' })
      }
      const { instanciaId } = z.object({ instanciaId: z.string().min(1) }).parse(req.params)
      const { fecha } = Fecha.parse(req.body ?? {})
      const r = await d.aMano.cancelarEvento(instanciaId, fecha)
      return r.ok ? r : res.code(400).send({ error: r.motivo })
    })

    api.post('/acciones/:id/juzgar', async (req, res) => {
      const { id } = Id.parse(req.params)
      const { veredicto } = Veredicto.parse(req.body)
      const ok = await d.repoAcciones.juzgar(id, veredicto, d.reloj.ahora().toISO()!)
      return ok ? { ok } : res.code(404).send({ error: 'Esa acción no es de las que hizo sola' })
    })

    // ── entrar a la app: código de un solo uso por Telegram ────
    //
    // El código NUNCA vuelve por aquí. Sale por Telegram y por ningún
    // otro lado; devolverlo convertiría el token de servicio en la llave
    // entera y haría el segundo factor decorativo.
    api.post('/acceso/pedir', async (_req, res) => {
      if (!d.acceso) {
        return res.code(503).send({ error: 'Sin Telegram no puedo mandarte un código' })
      }
      const r = await d.acceso.pedir()
      return r.enviado ? { enviado: true } : res.code(502).send({ error: r.motivo })
    })

    api.post('/acceso/verificar', async (req, res) => {
      if (!d.acceso) {
        return res.code(503).send({ error: 'Sin Telegram no puedo verificar nada' })
      }
      const { codigo } = z.object({ codigo: z.string().min(1).max(12) }).parse(req.body)
      const r = d.acceso.verificar(codigo)
      return r.ok ? { ok: true } : res.code(401).send({ error: r.motivo })
    })

    api.get('/graduacion', async () => {
      const ahora = d.reloj.ahora()
      return {
        modoSombra: d.modoSombra,
        ...medirGraduacion(
          await d.repoAcciones.juzgadas(ahora.minus({ days: 14 }).startOf('day').toISO()!),
          ahora),
      }
    })

    api.get('/propuestas', async (req) => {
      if (!d.propuestas) return { fecha: null, propuestas: [] }
      const { fecha } = Fecha.parse(req.query)
      return d.propuestas.delDia(fecha)
    })

    api.get('/tesoro', async (req) => {
      if (!d.tesoro) {
        return { disponible: false, motivo: 'El libro contable no está conectado' }
      }
      const { mes } = Mes.parse(req.query)
      return { disponible: true, ...(await d.tesoro.balance(mes)) }
    })

    api.get('/tesoro/anio', async (req) => {
      if (!d.tesoro) {
        return { disponible: false, motivo: 'El libro contable no está conectado' }
      }
      const { anio } = Anio.parse(req.query)
      return { disponible: true, ...(await d.tesoro.balanceAnual(anio)) }
    })

    /**
     * Ponerle nombre al local a mano. `contraparte` es lo que dijo el
     * correo del banco, y a veces no se parece al comercio de verdad.
     */
    api.post('/tesoro/movimientos/:id/local', async (req, res) => {
      if (!d.tesoro) {
        return res.code(503).send({ error: 'El libro contable no está conectado' })
      }
      const { id } = Id.parse(req.params)
      const { local } = z.object({ local: z.string().max(120).nullable() }).parse(req.body)
      const movimiento = await d.tesoro.ponerLocal(id, local)
      if (!movimiento) return res.code(404).send({ error: 'No existe ese movimiento' })
      return movimiento
    })

    /**
     * Corrige la categoría a mano, para cuando la que decidió el código no
     * calzó con lo que fue de verdad.
     */
    api.post('/tesoro/movimientos/:id/categoria', async (req, res) => {
      if (!d.tesoro) {
        return res.code(503).send({ error: 'El libro contable no está conectado' })
      }
      const { id } = Id.parse(req.params)
      const { categoria } = z.object({ categoria: z.enum(CATEGORIAS) }).parse(req.body)
      const movimiento = await d.tesoro.ponerCategoria(id, categoria)
      if (!movimiento) return res.code(404).send({ error: 'No existe ese movimiento' })
      return movimiento
    })

    // ── el canal de instrucciones ──────────────────────────────

    /**
     * Audio crudo en el cuerpo: el navegador manda el Blob del
     * MediaRecorder tal cual, sin multipart ni nada que empaquetar.
     *
     * Devuelve la transcripción firmada y NO ejecuta nada: él ve primero
     * qué se entendió. Sólo entonces manda la orden con su boleta.
     */
    api.post('/transcribir', async (req, res) => {
      if (!d.transcriptor) {
        return res.code(503).send({ error: 'La asistente todavía no sabe oír' })
      }
      const datos = req.body
      if (!Buffer.isBuffer(datos) || datos.length === 0) {
        return res.code(400).send({ error: 'No llegó audio' })
      }

      const transcripcion = await d.transcriptor.transcribir({
        datos,
        tipo: String(req.headers['content-type'] ?? 'audio/webm'),
      })

      return {
        ...transcripcion,
        boleta: firmarVoz(transcripcion.texto, d.secretoVoz, Date.now()),
      }
    })

    api.post('/instruccion', async (req) => {
      const { texto, boleta, canal } = Instruccion.parse(req.body)
      // Si el texto no es exactamente el que salió del transcriptor, la
      // firma no cuadra y deja de ser voz. Corregir a mano una palabra lo
      // vuelve texto escrito, que es justo lo que es.
      const origen = esDeVoz(texto, boleta, d.secretoVoz, Date.now()) ? 'voz' : 'texto'
      return d.instruccion.atender({ texto, origen, canal })
    })

    api.post('/instrucciones/:id/confirmar', async (req) => {
      const { id } = Id.parse(req.params)
      return d.instruccion.confirmar(id)
    })

    api.post('/instrucciones/:id/descartar', async (req) => {
      const { id } = Id.parse(req.params)
      return d.instruccion.descartar(id)
    })
  }, { prefix: '/api' })
}
