import type { BaseDatos } from '../db/base-datos.ts'
import type { Categoria } from '../dominio/categorias.ts'
import type { Moneda } from '../dominio/dinero.ts'

export interface NuevoMovimiento {
  fecha: string
  tipo: 'ingreso' | 'egreso'
  /** En la unidad menor, entero y positivo. El signo lo lleva `tipo`. */
  monto: number
  moneda: Moneda
  montoCop: number | null
  trm: number | null
  trmAprox?: boolean
  contraparte: string
  concepto: string | null
  categoria: Categoria
  correoId: number | null
  hashDedup: string
}

export interface Movimiento extends Omit<NuevoMovimiento, 'trmAprox'> {
  id: number
  trmAprox: boolean
  estado: 'registrado' | 'anulado'
  creadoEn: Date
  /** El nombre del local, puesto a mano. Nunca lo pone el modelo. */
  local: string | null
}

interface Fila {
  id: string | number
  fecha: Date | string
  tipo: 'ingreso' | 'egreso'
  monto: string | number
  moneda: string
  monto_cop: string | number | null
  trm: string | number | null
  trm_aprox: boolean
  contraparte: string
  concepto: string | null
  categoria: string
  correo_id: string | number | null
  hash_dedup: string
  estado: 'registrado' | 'anulado'
  creado_en: Date
  local: string | null
}

const COLUMNAS = `id, fecha, tipo, monto, moneda, monto_cop, trm, trm_aprox,
  contraparte, concepto, categoria, correo_id, hash_dedup, estado, creado_en, local`

/** Postgres devuelve BIGINT como texto: pasarlo a número es obligatorio. */
const num = (v: string | number | null): number | null =>
  v === null ? null : Number(v)

const soloFecha = (f: Date | string): string =>
  typeof f === 'string' ? f.slice(0, 10) : f.toISOString().slice(0, 10)

const aDominio = (f: Fila): Movimiento => ({
  id: Number(f.id),
  fecha: soloFecha(f.fecha),
  tipo: f.tipo,
  monto: Number(f.monto),
  moneda: f.moneda,
  montoCop: num(f.monto_cop),
  trm: num(f.trm),
  trmAprox: f.trm_aprox,
  contraparte: f.contraparte,
  concepto: f.concepto,
  categoria: f.categoria as Categoria,
  correoId: num(f.correo_id),
  hashDedup: f.hash_dedup,
  estado: f.estado,
  creadoEn: f.creado_en,
  local: f.local,
})

export function crearRepoMovimientos(db: BaseDatos) {
  return {
    /**
     * Registra si su huella no existe todavía.
     *
     * La unicidad la garantiza el constraint, no una consulta previa: eso
     * lo hace seguro ante dos avisos del mismo movimiento llegando a la
     * vez, que es exactamente lo que pasa cuando el banco reenvía.
     */
    async registrarSiEsNuevo(m: NuevoMovimiento): Promise<{ id: number; nuevo: boolean }> {
      const insertado = await db.query<{ id: string | number }>(
        `INSERT INTO movimientos
           (fecha, tipo, monto, moneda, monto_cop, trm, trm_aprox,
            contraparte, concepto, categoria, correo_id, hash_dedup)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (hash_dedup) DO NOTHING
         RETURNING id`,
        [m.fecha, m.tipo, m.monto, m.moneda, m.montoCop, m.trm, m.trmAprox ?? false,
         m.contraparte, m.concepto, m.categoria, m.correoId, m.hashDedup])

      if (insertado.rows[0]) return { id: Number(insertado.rows[0].id), nuevo: true }

      const existente = await db.query<{ id: string | number }>(
        'SELECT id FROM movimientos WHERE hash_dedup = $1', [m.hashDedup])
      return { id: Number(existente.rows[0]!.id), nuevo: false }
    },

    /** La inversa de registrar es anular, no borrar: el rastro se queda. */
    async anular(id: number): Promise<boolean> {
      const { rows } = await db.query<{ id: string | number }>(
        `UPDATE movimientos SET estado = 'anulado', anulado_en = now()
          WHERE id = $1 AND estado = 'registrado' RETURNING id`, [id])
      return rows.length > 0
    },

    async desanular(id: number): Promise<void> {
      await db.query(
        `UPDATE movimientos SET estado = 'registrado', anulado_en = NULL WHERE id = $1`,
        [id])
    },

    /**
     * El nombre del local, puesto a mano.
     *
     * `contraparte` es lo que dijo el correo del banco; a veces es una
     * cuenta comercial que no se parece al local de verdad. `local` en
     * blanco (`null`) vuelve a mostrar sólo la contraparte.
     */
    async ponerLocal(id: number, local: string | null): Promise<Movimiento | null> {
      const { rows } = await db.query<Fila>(
        `UPDATE movimientos SET local = $2 WHERE id = $1 RETURNING ${COLUMNAS}`,
        [id, local])
      return rows[0] ? aDominio(rows[0]) : null
    },

    async porId(id: number): Promise<Movimiento | null> {
      const { rows } = await db.query<Fila>(
        `SELECT ${COLUMNAS} FROM movimientos WHERE id = $1`, [id])
      return rows[0] ? aDominio(rows[0]) : null
    },

    async entre(desde: string, hasta: string, limite = 500): Promise<Movimiento[]> {
      const { rows } = await db.query<Fila>(
        `SELECT ${COLUMNAS} FROM movimientos
          WHERE estado = 'registrado' AND fecha >= $1 AND fecha <= $2
          ORDER BY fecha DESC, id DESC LIMIT $3`, [desde, hasta, limite])
      return rows.map(aDominio)
    },

    /**
     * Cobros repetidos: mismo comercio, mismo monto, días distintos.
     *
     * No es lo mismo que la deduplicación —eso son avisos repetidos del
     * mismo movimiento— sino dos cobros de verdad que parecen uno de más.
     */
    async posiblesDuplicados(desde: string, hasta: string): Promise<Array<{
      contraparte: string; monto: number; veces: number
    }>> {
      const { rows } = await db.query<{
        contraparte: string; monto: string | number; veces: string | number
      }>(
        `SELECT contraparte, monto, count(*) AS veces
           FROM movimientos
          WHERE estado = 'registrado' AND tipo = 'egreso'
            AND fecha >= $1 AND fecha <= $2
          GROUP BY contraparte, monto
         HAVING count(*) > 1
          ORDER BY count(*) DESC, monto DESC
          LIMIT 10`, [desde, hasta])
      return rows.map((r) => ({
        contraparte: r.contraparte, monto: Number(r.monto), veces: Number(r.veces),
      }))
    },
  }
}

export type RepoMovimientos = ReturnType<typeof crearRepoMovimientos>

// ── cuentas por pagar ──────────────────────────────────────────

export interface NuevaCuenta {
  acreedor: string
  concepto: string | null
  monto: number
  moneda: Moneda
  venceEl: string
  correoId: number | null
  hashDedup: string
}

export interface Cuenta extends NuevaCuenta {
  id: number
  estado: 'pendiente' | 'pagada' | 'descartada'
  avisadoEn: Date | null
}

interface FilaCuenta {
  id: string | number
  acreedor: string
  concepto: string | null
  monto: string | number
  moneda: string
  vence_el: Date | string
  estado: 'pendiente' | 'pagada' | 'descartada'
  correo_id: string | number | null
  hash_dedup: string
  avisado_en: Date | null
}

const aCuenta = (f: FilaCuenta): Cuenta => ({
  id: Number(f.id),
  acreedor: f.acreedor,
  concepto: f.concepto,
  monto: Number(f.monto),
  moneda: f.moneda,
  venceEl: soloFecha(f.vence_el),
  estado: f.estado,
  correoId: num(f.correo_id),
  hashDedup: f.hash_dedup,
  avisadoEn: f.avisado_en,
})

export function crearRepoCuentasPorPagar(db: BaseDatos) {
  return {
    async registrarSiEsNueva(c: NuevaCuenta): Promise<{ id: number; nueva: boolean }> {
      const insertada = await db.query<{ id: string | number }>(
        `INSERT INTO cuentas_por_pagar
           (acreedor, concepto, monto, moneda, vence_el, correo_id, hash_dedup)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (hash_dedup) DO NOTHING RETURNING id`,
        [c.acreedor, c.concepto, c.monto, c.moneda, c.venceEl, c.correoId, c.hashDedup])

      if (insertada.rows[0]) return { id: Number(insertada.rows[0].id), nueva: true }

      const existente = await db.query<{ id: string | number }>(
        'SELECT id FROM cuentas_por_pagar WHERE hash_dedup = $1', [c.hashDedup])
      return { id: Number(existente.rows[0]!.id), nueva: false }
    },

    async pendientes(hasta?: string): Promise<Cuenta[]> {
      const { rows } = await db.query<FilaCuenta>(
        `SELECT id, acreedor, concepto, monto, moneda, vence_el, estado,
                correo_id, hash_dedup, avisado_en
           FROM cuentas_por_pagar
          WHERE estado = 'pendiente' ${hasta ? 'AND vence_el <= $1' : ''}
          ORDER BY vence_el`,
        hasta ? [hasta] : [])
      return rows.map(aCuenta)
    },

    async cerrar(id: number, estado: 'pagada' | 'descartada', movimientoId?: number): Promise<void> {
      await db.query(
        `UPDATE cuentas_por_pagar SET estado = $2, movimiento_id = $3 WHERE id = $1`,
        [id, estado, movimientoId ?? null])
    },

    /**
     * Para no repetir el mismo aviso de vencimiento todos los días.
     *
     * La hora llega por parámetro y no con `now()`: el tiempo entra a este
     * sistema por el Reloj y por ningún otro lado. Con `now()` esto sería
     * el único sitio donde la base decide qué hora es, y dejaría de poder
     * probarse el caso que importa — «ya avisé de esto anoche».
     */
    async marcarAvisada(id: number, cuandoIso: string): Promise<void> {
      await db.query(
        'UPDATE cuentas_por_pagar SET avisado_en = $2 WHERE id = $1', [id, cuandoIso])
    },
  }
}

export type RepoCuentasPorPagar = ReturnType<typeof crearRepoCuentasPorPagar>
