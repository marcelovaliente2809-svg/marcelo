import { DateTime } from 'luxon'
import type { Reloj } from '../puertos/reloj.ts'
import type { CorreoCrudo } from '../dominio/tipos.ts'
import type { HechoFinanzas } from '../pipeline/extractor-finanzas.ts'
import type {
  Movimiento, RepoCuentasPorPagar, RepoMovimientos,
} from '../repos/movimientos.ts'
import { decidirCategoria, NOMBRES, type Categoria } from '../dominio/categorias.ts'
import { enPalabras, hashDedup, monedaDe, parsearMonto } from '../dominio/dinero.ts'
import { resolverReferente } from '../dominio/fechas.ts'

/**
 * El libro contable.
 *
 * **La asistente nunca mueve dinero. Sólo lee y registra.** No existe
 * ningún camino en el código por el que pueda pagar, transferir ni
 * autorizar nada — riesgo cero por diseño, no por cuidado.
 *
 * Aquí es donde el hecho que sacó el modelo se vuelve una fila: el código
 * parsea el monto, resuelve la fecha, normaliza la contraparte, calcula la
 * huella y decide la categoría. El modelo sólo leyó.
 */

export interface DepsTesoro {
  reloj: Reloj
  repoMovimientos: RepoMovimientos
  repoCuentas: RepoCuentasPorPagar
}

export type ResultadoRegistro =
  | { estado: 'registrado'; id: number; movimiento: ResumenMovimiento }
  | { estado: 'repetido'; id: number }
  | { estado: 'por_pagar'; id: number; nueva: boolean }
  | { estado: 'descartado'; motivo: string }

export interface ResumenMovimiento {
  tipo: 'ingreso' | 'egreso'
  monto: string
  contraparte: string
  categoria: string
}

export interface Balance {
  desde: string
  hasta: string
  ingresos: number
  egresos: number
  /** Ingresos menos egresos. Puede ser negativo, y eso hay que poder verlo. */
  neto: number
  porCategoria: Array<{ categoria: Categoria; nombre: string; total: number }>
  movimientos: Movimiento[]
  cuentasPorPagar: Array<{
    id: number; acreedor: string; monto: number; moneda: string
    venceEl: string; diasRestantes: number
  }>
  /** Cobros repetidos: mismo comercio, mismo monto, más de una vez. */
  sospechas: Array<{ contraparte: string; monto: number; veces: number }>
  moneda: string
}

export function crearServicioTesoro(d: DepsTesoro) {
  const zona = () => d.reloj.ahora().zoneName ?? 'America/Bogota'

  /**
   * Un hecho leído se vuelve una fila del libro.
   *
   * Devuelve por qué NO se registró cuando no se registra: un correo que
   * menciona dinero y no es una transacción es el caso más común, y
   * meterlo al libro lo ensucia de una forma que después nadie deshace.
   */
  async function registrar(
    hecho: HechoFinanzas,
    correo: CorreoCrudo,
    correoId: number | null
  ): Promise<ResultadoRegistro> {
    if (hecho.clase === 'ninguno') {
      return { estado: 'descartado', motivo: 'Menciona dinero pero no es una transacción' }
    }
    if (hecho.confianza === 'baja') {
      // En el libro no se apunta nada dudoso: un número mal puesto no se
      // nota hasta que alguien mira el mes y no le cuadra.
      return { estado: 'descartado', motivo: 'Confianza baja: no se apunta a medias' }
    }
    if (!hecho.montoTexto) {
      return { estado: 'descartado', motivo: 'Sin monto no hay nada que anotar' }
    }

    const moneda = monedaDe(hecho.moneda ?? hecho.montoTexto, 'COP')
    const monto = parsearMonto(hecho.montoTexto, moneda)
    if (monto === null || monto === 0) {
      return { estado: 'descartado', motivo: `No pude leer el monto «${hecho.montoTexto}»` }
    }

    const ahora = d.reloj.ahora()
    const resuelto = resolverReferente(hecho.referente, ahora)
    const contraparte = (hecho.contraparte ?? correo.remitente).trim() || correo.remitente

    if (hecho.clase === 'cuenta_por_pagar') {
      // Sin fecha límite no es una cuenta por pagar: es un cobro suelto, y
      // avisar de un vencimiento que nadie sabe cuándo es no sirve de nada.
      if (!resuelto) {
        return { estado: 'descartado', motivo: 'Un cobro futuro sin fecha no se puede avisar' }
      }
      const venceEl = resuelto.intervalo.inicio.toISODate()!
      const { id, nueva } = await d.repoCuentas.registrarSiEsNueva({
        acreedor: contraparte,
        concepto: hecho.concepto,
        monto: Math.abs(monto),
        moneda,
        venceEl,
        correoId,
        hashDedup: hashDedup({
          fecha: venceEl, centavos: Math.abs(monto), moneda, contraparte,
        }),
      })
      return { estado: 'por_pagar', id, nueva }
    }

    // Un movimiento sin fecha se apunta con la del correo: la plata ya se
    // movió, y perderlo por no saber el día sería peor que aproximarlo.
    const fecha = (resuelto?.intervalo.inicio
      ?? DateTime.fromISO(correo.recibidoEn, { zone: zona() })).toISODate()!

    const tipo = hecho.tipo ?? (monto < 0 ? 'egreso' : 'ingreso')
    const absoluto = Math.abs(monto)

    const categoria = decidirCategoria({
      propuesta: hecho.categoria ?? '',
      contraparte,
      concepto: hecho.concepto ?? '',
      tipo,
    })

    const { id, nuevo } = await d.repoMovimientos.registrarSiEsNuevo({
      fecha,
      tipo,
      monto: absoluto,
      moneda,
      // Moneda extranjera es caso borde: mientras no haya TRM, sólo los
      // pesos tienen equivalente en pesos. Fingir una conversión sería
      // peor que dejarlo en null.
      montoCop: moneda === 'COP' ? absoluto : null,
      trm: null,
      contraparte,
      concepto: hecho.concepto,
      categoria,
      correoId,
      hashDedup: hashDedup({ fecha, centavos: absoluto, moneda, contraparte }),
    })

    if (!nuevo) return { estado: 'repetido', id }

    return {
      estado: 'registrado',
      id,
      movimiento: {
        tipo,
        monto: enPalabras(absoluto, moneda),
        contraparte,
        categoria: NOMBRES[categoria],
      },
    }
  }

  async function balance(mesIso?: string): Promise<Balance> {
    const ahora = d.reloj.ahora()
    const base = mesIso
      ? DateTime.fromISO(mesIso, { zone: zona() })
      : ahora
    const desde = base.startOf('month')
    const hasta = base.endOf('month')

    const [movimientos, cuentas, sospechas] = await Promise.all([
      d.repoMovimientos.entre(desde.toISODate()!, hasta.toISODate()!),
      d.repoCuentas.pendientes(),
      d.repoMovimientos.posiblesDuplicados(desde.toISODate()!, hasta.toISODate()!),
    ])

    // Sólo pesos en las sumas: mezclar monedas daría un número que no
    // significa nada. Lo demás se ve en la lista, con su moneda.
    const enPesos = movimientos.filter((m) => m.moneda === 'COP')
    const ingresos = enPesos.filter((m) => m.tipo === 'ingreso')
      .reduce((t, m) => t + m.monto, 0)
    const egresos = enPesos.filter((m) => m.tipo === 'egreso')
      .reduce((t, m) => t + m.monto, 0)

    const acumulado = new Map<Categoria, number>()
    for (const m of enPesos) {
      if (m.tipo !== 'egreso') continue
      acumulado.set(m.categoria, (acumulado.get(m.categoria) ?? 0) + m.monto)
    }

    return {
      desde: desde.toISODate()!,
      hasta: hasta.toISODate()!,
      ingresos,
      egresos,
      neto: ingresos - egresos,
      porCategoria: [...acumulado]
        .map(([categoria, total]) => ({ categoria, nombre: NOMBRES[categoria], total }))
        .sort((a, b) => b.total - a.total),
      movimientos,
      cuentasPorPagar: cuentas.map((c) => ({
        id: c.id,
        acreedor: c.acreedor,
        monto: c.monto,
        moneda: c.moneda,
        venceEl: c.venceEl,
        diasRestantes: Math.ceil(
          DateTime.fromISO(c.venceEl, { zone: zona() })
            .diff(ahora.startOf('day'), 'days').days),
      })),
      sospechas,
      moneda: 'COP',
    }
  }

  return {
    registrar,
    balance,

    /**
     * Ponerle nombre al local a mano, cuando la contraparte del correo del
     * banco no se parece al comercio de verdad. Vacío borra el nombre y
     * vuelve a mostrar sólo la contraparte.
     */
    async ponerLocal(id: number, local: string | null) {
      const limpio = local?.trim() || null
      return d.repoMovimientos.ponerLocal(id, limpio)
    },

    /**
     * Lo que hay que avisar hoy: vence pronto y no se ha avisado.
     *
     * Se marca como avisada al devolverla, para que el mismo vencimiento
     * no salga en el resumen tres noches seguidas.
     */
    async porVencer(dias = 3) {
      const ahora = d.reloj.ahora()
      const limite = ahora.plus({ days: dias }).toISODate()!
      const cuentas = await d.repoCuentas.pendientes(limite)

      const nuevas = cuentas.filter((c) => {
        if (!c.avisadoEn) return true
        // Una al día como mucho, y si ya venció se vuelve a decir.
        return DateTime.fromJSDate(c.avisadoEn, { zone: zona() })
          .startOf('day') < ahora.startOf('day')
      })
      for (const c of nuevas) await d.repoCuentas.marcarAvisada(c.id, ahora.toISO()!)

      return nuevas.map((c) => ({
        id: c.id,
        acreedor: c.acreedor,
        monto: enPalabras(c.monto, c.moneda),
        venceEl: c.venceEl,
        diasRestantes: Math.ceil(
          DateTime.fromISO(c.venceEl, { zone: zona() })
            .diff(ahora.startOf('day'), 'days').days),
      }))
    },

    /** Lo del día, para el resumen de las 21:00. */
    async delDia(fechaIso?: string) {
      const dia = fechaIso ?? d.reloj.ahora().toISODate()!
      const movimientos = await d.repoMovimientos.entre(dia, dia)
      const enPesos = movimientos.filter((m) => m.moneda === 'COP')
      return {
        cuantos: movimientos.length,
        ingresos: enPesos.filter((m) => m.tipo === 'ingreso').reduce((t, m) => t + m.monto, 0),
        egresos: enPesos.filter((m) => m.tipo === 'egreso').reduce((t, m) => t + m.monto, 0),
        movimientos,
      }
    },
  }
}

export type ServicioTesoro = ReturnType<typeof crearServicioTesoro>
