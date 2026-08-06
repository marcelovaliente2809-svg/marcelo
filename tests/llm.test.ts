import { test } from 'node:test'
import assert from 'node:assert/strict'
import { esRuidoObvio } from '../src/pipeline/prefiltro.ts'
import { crearClasificador } from '../src/pipeline/clasificador.ts'
import { crearExtractor } from '../src/pipeline/extractor.ts'
import { crearDesempate } from '../src/pipeline/desempate.ts'
import { LlmFalso } from './fakes/llm-falso.ts'
import type { CorreoCrudo, Compromiso } from '../src/dominio/tipos.ts'
import { z } from 'zod'
import { ProveedorGroq } from '../src/adaptadores/groq.ts'
import type { ErrorLLM } from '../src/puertos/proveedor-llm.ts'
import type { Candidato } from '../src/dominio/resolutor.ts'

const correo = (over: Partial<CorreoCrudo> = {}): CorreoCrudo => ({
  cuentaId: 1, messageId: 'm1', threadId: null,
  remitente: 'ramirez@uni.edu.co', asunto: 'Clase de hoy',
  cuerpo: 'No, no, la clase de hoy se cancela',
  recibidoEn: '2026-08-04T14:14:00-05:00', etiquetas: ['INBOX'],
  ...over,
})

// ── prefiltro ───────────────────────────────────────────────────

test('descarta promociones de Gmail sin gastar un token', () => {
  assert.equal(esRuidoObvio(correo({ etiquetas: ['CATEGORY_PROMOTIONS'] }), 'gmail', []), true)
})

test('descarta la carpeta de correo no deseado de Outlook', () => {
  assert.equal(esRuidoObvio(correo({ etiquetas: ['junkemail'] }), 'outlook', []), true)
})

test('cada proveedor usa sus propias etiquetas de ruido', () => {
  // Una etiqueta de Gmail no significa nada en Outlook y viceversa.
  assert.equal(esRuidoObvio(correo({ etiquetas: ['CATEGORY_PROMOTIONS'] }), 'outlook', []), false)
  assert.equal(esRuidoObvio(correo({ etiquetas: ['junkemail'] }), 'gmail', []), false)
})

test('descarta remitentes que él pidió ignorar', () => {
  assert.equal(
    esRuidoObvio(correo({ remitente: 'Notificaciones <no-reply@banco.com>' }), 'gmail',
      ['no-reply@banco.com']), true)
})

test('el emparejamiento de remitente ignora mayúsculas y nombre visible', () => {
  assert.equal(
    esRuidoObvio(correo({ remitente: 'Banco <NO-REPLY@Banco.com>' }), 'gmail',
      ['no-reply@banco.com']), true)
})

test('deja pasar un correo normal de la bandeja', () => {
  assert.equal(esRuidoObvio(correo(), 'gmail', []), false)
})

// ── clasificador ────────────────────────────────────────────────

test('devuelve la clasificación validada del modelo', async () => {
  const llm = new LlmFalso([{ clasificacion: 'agenda', confianza: 'alta' }])
  const r = await crearClasificador(llm, 'modelo-x').clasificar(correo())
  assert.equal(r.clasificacion, 'agenda')
  assert.equal(r.confianza, 'alta')
})

test('el cuerpo se recorta antes de mandarlo al modelo', async () => {
  const llm = new LlmFalso([{ clasificacion: 'ruido', confianza: 'alta' }])
  await crearClasificador(llm, 'm').clasificar(correo({ cuerpo: 'x'.repeat(10_000) }))
  assert.ok(llm.peticiones[0]!.usuario.length < 4_000)
})

test('una clasificación fuera del enum revienta la validación', async () => {
  const llm = new LlmFalso([{ clasificacion: 'inventada', confianza: 'alta' }])
  await assert.rejects(() => crearClasificador(llm, 'm').clasificar(correo()))
})

// ── extractor ───────────────────────────────────────────────────

const hecho = (over: Record<string, unknown> = {}) => ({
  intencion: 'cancelar', referente: { tipo: 'hoy' },
  nuevoInicio: null, nuevoFin: null, menciones: ['clase'], confianza: 'alta',
  ...over,
})

test('extrae la intención con el referente en crudo', async () => {
  const llm = new LlmFalso([hecho()])
  const r = await crearExtractor(llm, 'm').extraer(correo(), correo().recibidoEn)
  assert.equal(r.intencion, 'cancelar')
  assert.deepEqual(r.referente, { tipo: 'hoy' })
})

test('la fecha de recepción se le entrega al modelo como contexto', async () => {
  const llm = new LlmFalso([hecho({ intencion: 'ninguna', referente: { tipo: 'desconocido' } })])
  await crearExtractor(llm, 'm').extraer(correo(), '2026-08-04T14:14:00-05:00')
  assert.ok(llm.peticiones[0]!.usuario.includes('2026-08-04'))
})

test('rechaza una fecha que el modelo intentó calcular en prosa', async () => {
  // El esquema no admite texto libre en iso: si el modelo devuelve
  // "el miércoles" en vez de una fecha, no valida y se reintenta.
  const llm = new LlmFalso([hecho({ referente: { tipo: 'fecha', iso: 'el miércoles' } })])
  await assert.rejects(() => crearExtractor(llm, 'm').extraer(correo(), correo().recibidoEn))
})

test('acepta un día de la semana con modificador', async () => {
  const llm = new LlmFalso([
    hecho({ referente: { tipo: 'dia_semana', dia: 3, modificador: 'proximo' } })])
  const r = await crearExtractor(llm, 'm').extraer(correo(), correo().recibidoEn)
  assert.equal(r.referente.tipo, 'dia_semana')
})

test('un cambio de horario trae inicio y fin nuevos', async () => {
  const llm = new LlmFalso([
    hecho({ intencion: 'mover', referente: { tipo: 'manana' },
            nuevoInicio: '18:00', nuevoFin: '19:00' })])
  const r = await crearExtractor(llm, 'm').extraer(correo(), correo().recibidoEn)
  assert.equal(r.intencion, 'mover')
  assert.equal(r.nuevoInicio, '18:00')
})

test('rechaza una hora con formato inválido', async () => {
  const llm = new LlmFalso([hecho({ intencion: 'mover', nuevoInicio: '6pm', nuevoFin: '7pm' })])
  await assert.rejects(() => crearExtractor(llm, 'm').extraer(correo(), correo().recibidoEn))
})

// ── desempate ───────────────────────────────────────────────────

const compromisoBase = {
  rrule: null, horaInicio: '16:00', horaFin: '17:00', tz: 'America/Bogota',
  googleCalendarId: 'primary', googleEventId: 'e', activo: true,
  remitentesVinculados: [], alias: [] as string[],
}
const cand = (id: number, titulo: string): Candidato => ({
  compromiso: { ...compromisoBase, id, titulo } as Compromiso,
  puntaje: 50, senales: ['remitente_vinculado'],
})

test('elige el candidato que devuelve el modelo', async () => {
  const llm = new LlmFalso([{ compromisoId: 3, justificacion: 'menciona taller' }])
  const r = await crearDesempate(llm, 'm').elegir(
    [cand(1, 'Cálculo'), cand(3, 'Taller de Cálculo')], 'El taller de hoy se cancela')
  assert.equal(r?.compromiso.id, 3)
})

test('si el modelo inventa un id fuera de la lista, devuelve null', async () => {
  // La garantía estructural: una alucinación se vuelve pregunta, jamás
  // un borrado. No depende de que el modelo sea bueno.
  const llm = new LlmFalso([{ compromisoId: 99, justificacion: 'inventado' }])
  const r = await crearDesempate(llm, 'm').elegir([cand(1, 'Cálculo'), cand(3, 'Taller')], 'algo')
  assert.equal(r, null)
})

test('si el modelo dice que no puede decidir, devuelve null', async () => {
  const llm = new LlmFalso([{ compromisoId: null, justificacion: 'ambiguo' }])
  const r = await crearDesempate(llm, 'm').elegir([cand(1, 'Cálculo'), cand(3, 'Taller')], 'algo')
  assert.equal(r, null)
})

test('sólo se le muestran al modelo los candidatos reales', async () => {
  const llm = new LlmFalso([{ compromisoId: 1, justificacion: 'ok' }])
  await crearDesempate(llm, 'm').elegir([cand(1, 'Cálculo'), cand(3, 'Taller')], 'algo')
  const enviado = llm.peticiones[0]!.usuario
  assert.ok(enviado.includes('id 1'))
  assert.ok(enviado.includes('Cálculo'))
  assert.ok(!enviado.includes('id 99'))
})

test('con un solo candidato ni consulta al modelo', async () => {
  const llm = new LlmFalso([])
  const r = await crearDesempate(llm, 'm').elegir([cand(1, 'Cálculo')], 'algo')
  assert.equal(r?.compromiso.id, 1)
  assert.equal(llm.peticiones.length, 0)
})

test('sin candidatos devuelve null sin consultar', async () => {
  const llm = new LlmFalso([])
  assert.equal(await crearDesempate(llm, 'm').elegir([], 'algo'), null)
  assert.equal(llm.peticiones.length, 0)
})

// ── por qué falló, que no es lo mismo que que falló ─────────────

test('un modelo que no existe no se reintenta tres veces', async () => {
  // Insistirle a un 404 sólo retrasa el aviso y esconde la causa detrás de
  // «no produjo JSON válido».
  let llamadas = 0
  const cliente = {
    chat: { completions: { create: async () => {
      llamadas++
      throw Object.assign(new Error('404'), { status: 404 })
    } } },
  }
  const llm = new ProveedorGroq('k', 'https://x.test/v1')
  ;(llm as unknown as { cliente: unknown }).cliente = cliente

  await assert.rejects(
    () => llm.completarJson({
      modelo: 'modelo-fantasma', sistema: 's', usuario: 'u',
      esquema: z.object({ a: z.string() }),
    }),
    (e: ErrorLLM) => {
      assert.equal(e.causa, 'modelo')
      assert.match(e.message, /modelo-fantasma/, 'el log tiene que decir cuál')
      assert.match(e.message, /asistente de configuración/, 'y qué hacer')
      assert.equal(e.pasajero, false)
      return true
    })

  assert.equal(llamadas, 1, 'una sola vez')
})

test('sin cuota se marca como pasajero: eso no se pierde, se reintenta', async () => {
  const cliente = {
    chat: { completions: { create: async () => {
      throw Object.assign(new Error('429'), {
        status: 429, headers: { 'retry-after': '7' },
      })
    } } },
  }
  const llm = new ProveedorGroq('k', 'https://x.test/v1')
  ;(llm as unknown as { cliente: unknown }).cliente = cliente

  await assert.rejects(
    () => llm.completarJson({
      modelo: 'm', sistema: 's', usuario: 'u',
      esquema: z.object({ a: z.string() }), reintentos: 1,
    }),
    (e: ErrorLLM) => {
      assert.equal(e.causa, 'cuota')
      assert.equal(e.pasajero, true)
      assert.equal(e.esperar, 7000, 'se le hace caso al retry-after del proveedor')
      assert.match(e.message, /no se pierde nada/)
      return true
    })
})

test('una clave mala tampoco se reintenta', async () => {
  let llamadas = 0
  const cliente = {
    chat: { completions: { create: async () => {
      llamadas++
      throw Object.assign(new Error('401'), { status: 401 })
    } } },
  }
  const llm = new ProveedorGroq('mala', 'https://x.test/v1')
  ;(llm as unknown as { cliente: unknown }).cliente = cliente

  await assert.rejects(() => llm.completarJson({
    modelo: 'm', sistema: 's', usuario: 'u', esquema: z.object({ a: z.string() }),
  }), (e: ErrorLLM) => {
    assert.equal(e.causa, 'clave')
    assert.equal(e.pasajero, false)
    return true
  })
  assert.equal(llamadas, 1)
})

test('un JSON mal formado sí se reintenta: eso suele arreglarse solo', async () => {
  let llamadas = 0
  const cliente = {
    chat: { completions: { create: async () => {
      llamadas++
      return { choices: [{ message: { content: llamadas < 3 ? 'no soy json' : '{"a":"ok"}' } }] }
    } } },
  }
  const llm = new ProveedorGroq('k', 'https://x.test/v1')
  ;(llm as unknown as { cliente: unknown }).cliente = cliente

  const r = await llm.completarJson({
    modelo: 'm', sistema: 's', usuario: 'u', esquema: z.object({ a: z.string() }),
  })

  assert.deepEqual(r, { a: 'ok' })
  assert.equal(llamadas, 3)
})

/**
 * En la máquina de Marcelo esto pasaba con cada correo bancario: el modelo
 * contestaba un JSON perfecto pero envuelto en ```json ... ```, y
 * `JSON.parse` truena con «Unexpected token '`'». El libro contable se
 * quedaba sin un solo movimiento, siempre por el mismo motivo.
 */
test('el JSON envuelto en fences de markdown se limpia antes de parsear', async () => {
  let llamadas = 0
  const cliente = {
    chat: { completions: { create: async () => {
      llamadas++
      return { choices: [{ message: { content: '```json\n{"a":"ok"}\n```' } }] }
    } } },
  }
  const llm = new ProveedorGroq('k', 'https://x.test/v1')
  ;(llm as unknown as { cliente: unknown }).cliente = cliente

  const r = await llm.completarJson({
    modelo: 'm', sistema: 's', usuario: 'u', esquema: z.object({ a: z.string() }),
  })

  assert.deepEqual(r, { a: 'ok' })
  assert.equal(llamadas, 1, 'no hacía falta reintentar: el JSON estaba bien, sólo envuelto')
})

test('también limpia fences sin la etiqueta "json"', async () => {
  const cliente = {
    chat: { completions: { create: async () => (
      { choices: [{ message: { content: '```\n{"a":"ok"}\n```' } }] }
    ) } },
  }
  const llm = new ProveedorGroq('k', 'https://x.test/v1')
  ;(llm as unknown as { cliente: unknown }).cliente = cliente

  const r = await llm.completarJson({
    modelo: 'm', sistema: 's', usuario: 'u', esquema: z.object({ a: z.string() }),
  })

  assert.deepEqual(r, { a: 'ok' })
})

/**
 * En la máquina de Marcelo esto decía «No se pudo llegar al proveedor» con
 * el proveedor contestando perfectamente: el fallo era del esquema, y un
 * ZodError no trae código HTTP, así que caía en el saco de «red». Mandó a
 * mirar la conexión, la clave y la cuota durante un buen rato mientras el
 * problema estaba en la forma de la respuesta.
 */
test('si el fallo es del esquema, no se dice que fue la red', async () => {
  const cliente = {
    chat: { completions: { create: async () => ({
      choices: [{ message: { content: '{"clasificacion":"ruido","confianza":0.9}' } }],
    }) } },
  }
  const llm = new ProveedorGroq('k', 'https://x.test/v1')
  ;(llm as unknown as { cliente: unknown }).cliente = cliente

  await assert.rejects(() => llm.completarJson({
    modelo: 'llama-3.1-8b', sistema: 's', usuario: 'u', reintentos: 1,
    esquema: z.object({ clasificacion: z.string(), confianza: z.enum(['alta']) }),
  }), (e: ErrorLLM) => {
    assert.equal(e.causa, 'formato', 'el proveedor contestó: la red no tuvo la culpa')
    assert.doesNotMatch(e.message, /no se pudo llegar/i)
    // Y nombra el campo: «no produjo JSON válido» delante de un JSON
    // impecable al que sólo le sobra un decimal no ayuda a nadie.
    assert.match(e.message, /confianza/)
    assert.match(e.message, /llama-3\.1-8b/)
    return true
  })
})
