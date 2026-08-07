/**
 * Lo que devuelve la asistente.
 *
 * Se copian aquí en vez de importarlos del backend porque la app se despliega
 * sola en Vercel y no comparte build con la laptop. Son la frontera del
 * contrato: si cambia el backend, esto es lo que hay que cambiar.
 */

export type Confianza = 'alta' | 'media' | 'baja'
export type Origen = 'correo' | 'voz' | 'texto'
export type Prioridad = 'urgente' | 'alta' | 'normal' | 'baja'
export type EstadoIntencion = 'pendiente' | 'agendada' | 'hecha' | 'descartada'

export interface Marca {
  accionId: number
  tipo: string
  origen: Origen
  confianza: Confianza
  cuando: string
  /** La hizo sola, sin que nadie se lo pidiera. */
  porElla: boolean
  /** Modo sombra: lo habría hecho, pero no tocó nada. */
  ensayo: boolean
  deshecha: boolean
  desdeInicio: string | null
}

export interface EventoJornada {
  id: string
  eventoId: string
  titulo: string
  inicio: string
  fin: string
  todoElDia: boolean
  estado: 'confirmado' | 'cancelado'
  momento: 'pasado' | 'ahora' | 'futuro'
  marca: Marca | null
}

export interface Hueco {
  inicio: string
  fin: string
  minutos: number
}

export interface Jornada {
  fecha: string
  zonaHoraria: string
  ahora: string
  esHoy: boolean
  ventana: { inicio: string; fin: string }
  eventos: EventoJornada[]
  huecos: Hueco[]
  cambiosDeElla: number
  modoSombra: boolean
}

/** Una llamada a herramienta ya ejecutada, o esperando que él confirme. */
export interface ResultadoOrden {
  herramienta: string
  estado: 'hecho' | 'confirma' | 'pregunta' | 'respuesta' | 'nada'
  /** Lo que entendió, en palabras. Se devuelve siempre, incluso al fallar. */
  entendido: string
  respuesta: string
  confirmaId?: number
  accionId?: number
  ensayo?: boolean
}

export interface RespuestaInstruccion {
  texto: string
  resultados: ResultadoOrden[]
}

export interface EntradaCronica {
  /** El ✓ o el ✗ que le puso Marcelo. Sólo en lo que hizo sola. */
  veredicto: 'acierto' | 'error' | null
  id: number
  tipo: string
  origen: Origen
  confianza: Confianza
  estado: 'aplicada' | 'deshecha' | 'sombra' | 'pendiente' | 'descartada'
  resumen: string | null
  creadaEn: string
  deshechaEn: string | null
  porElla: boolean
  ensayo: boolean
  titulo: string
  objetivo: { inicio: string; fin: string; desdeInicio: string | null } | null
  compromiso: { id: number; titulo: string } | null
  correo: { remitente: string; asunto: string | null; recibidoEn: string } | null
}

export interface Intencion {
  id: number
  titulo: string
  detalle: string | null
  prioridad: Prioridad
  duracionMin: number
  venceEl: string | null
  estado: EstadoIntencion
  origen: Origen
  googleEventId: string | null
}

export interface Bandeja {
  fecha: string
  huecos: Hueco[]
  intenciones: Intencion[]
}

export interface Compromiso {
  id: number
  titulo: string
  alias: string[]
  rrule: string | null
  horaInicio: string
  horaFin: string
  tz: string
  googleCalendarId: string
  googleEventId: string | null
  remitentesVinculados: string[]
  activo: boolean
}

export interface Estado {
  ok: boolean
  modoSombra: boolean
  zonaHoraria: string | null
  ahora: string | null
  ultimoLatido: string | null
}

// ── el tesoro ───────────────────────────────────────────────────

export const CATEGORIAS = [
  'arriendo', 'servicios', 'mercado', 'transporte', 'salud', 'educacion',
  'restaurantes', 'compras', 'suscripciones', 'transferencia', 'retiro',
  'impuestos', 'ingreso', 'otros',
] as const

export type Categoria = (typeof CATEGORIAS)[number]

/** Para pintarlas sin que nadie tenga que leer un identificador. */
export const NOMBRES_CATEGORIA: Record<Categoria, string> = {
  arriendo: 'Arriendo',
  servicios: 'Servicios',
  mercado: 'Mercado',
  transporte: 'Transporte',
  salud: 'Salud',
  educacion: 'Educación',
  restaurantes: 'Restaurantes',
  compras: 'Compras',
  suscripciones: 'Suscripciones',
  transferencia: 'Transferencias',
  retiro: 'Retiros',
  impuestos: 'Impuestos',
  ingreso: 'Ingresos',
  otros: 'Otros',
}

export interface Movimiento {
  id: number
  fecha: string
  tipo: 'ingreso' | 'egreso'
  /** En la unidad menor: $1.240.000 son 124000000. */
  monto: number
  moneda: string
  montoCop: number | null
  contraparte: string
  concepto: string | null
  categoria: Categoria
  correoId: number | null
  estado: 'registrado' | 'anulado'
  /** El nombre del local, puesto a mano. Nunca lo pone el modelo. */
  local: string | null
}

export interface CuentaPorPagar {
  id: number
  acreedor: string
  monto: number
  moneda: string
  venceEl: string
  diasRestantes: number
}

export interface Tesoro {
  disponible: boolean
  motivo?: string
  desde: string
  hasta: string
  ingresos: number
  egresos: number
  neto: number
  porCategoria: Array<{ categoria: Categoria; nombre: string; total: number }>
  movimientos: Movimiento[]
  cuentasPorPagar: CuentaPorPagar[]
  /** Cobros repetidos: mismo comercio, mismo monto, días distintos. */
  sospechas: Array<{ contraparte: string; monto: number; veces: number }>
  moneda: string
}

export interface Graduacion {
  modoSombra: boolean
  dias: Array<{
    fecha: string
    aciertos: number
    errores: number
    sinJuzgar: number
    precision: number | null
    cumple: boolean
  }>
  rachaActual: number
  rachaNecesaria: number
  precisionNecesaria: number
  puedeGraduarse: boolean
  totalJuzgadas: number
  sinJuzgar: number
  dictamen: string
}
