/**
 * Horas y fechas leídas de la cadena ISO, no del reloj del navegador.
 *
 * El backend emite todo con el desfase de Bogotá dentro de la cadena
 * (`2026-08-04T16:00:00-05:00`). Si aquí se usara `new Date().getHours()`,
 * un celular con la zona en otro país movería la clase de hora. Cortar la
 * cadena es exacto y no depende de dónde esté el teléfono.
 */

const DIAS = [
  'domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado',
] as const

const MESES = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
] as const

/** '2026-08-04T16:00:00-05:00' → '16:00' */
export function hora(iso: string): string {
  return iso.length >= 16 ? iso.slice(11, 16) : ''
}

/** '2026-08-04T16:00:00-05:00' → '4:00 pm' */
export function hora12(iso: string): string {
  const hhmm = hora(iso)
  if (!hhmm) return ''
  const h = Number(hhmm.slice(0, 2))
  const m = hhmm.slice(3, 5)
  const tarde = h >= 12
  const h12 = h % 12 === 0 ? 12 : h % 12
  return `${h12}:${m} ${tarde ? 'pm' : 'am'}`
}

/** Minutos absolutos entre dos instantes ISO. */
export function minutosEntre(desdeIso: string, hastaIso: string): number {
  return Math.round((Date.parse(hastaIso) - Date.parse(desdeIso)) / 60000)
}

/** 90 → '1 h 30'. Para durar y para huecos. */
export function duracion(minutos: number): string {
  if (minutos < 60) return `${minutos} min`
  const h = Math.floor(minutos / 60)
  const m = minutos % 60
  return m === 0 ? `${h} h` : `${h} h ${m}`
}

function partes(iso: string): { anio: number; mes: number; dia: number } {
  return {
    anio: Number(iso.slice(0, 4)),
    mes: Number(iso.slice(5, 7)),
    dia: Number(iso.slice(8, 10)),
  }
}

/** '2026-07-30' → 'jueves 30 de julio' */
export function fechaLarga(iso: string): string {
  const { anio, mes, dia } = partes(iso)
  // Date.UTC evita que el desfase local corra la fecha un día.
  const nombre = DIAS[new Date(Date.UTC(anio, mes - 1, dia)).getUTCDay()]
  return `${nombre} ${dia} de ${MESES[mes - 1]}`
}

/** '2026-07-30' → 'JUE 30' */
export function fechaCorta(iso: string): string {
  const { anio, mes, dia } = partes(iso)
  const nombre = DIAS[new Date(Date.UTC(anio, mes - 1, dia)).getUTCDay()] ?? ''
  return `${nombre.slice(0, 3).toUpperCase()} ${dia}`
}

/** Suma días a una fecha 'YYYY-MM-DD' sin salirse de la fecha civil. */
export function masDias(fechaIso: string, dias: number): string {
  const { anio, mes, dia } = partes(fechaIso)
  const d = new Date(Date.UTC(anio, mes - 1, dia + dias))
  return d.toISOString().slice(0, 10)
}

/**
 * El mes corriente en Bogotá, 'YYYY-MM'.
 *
 * Va con zona explícita porque esto se sirve desde Vercel, que corre en UTC:
 * un 31 a las 7 de la tarde en Bogotá ya es el mes siguiente en UTC, y la
 * flecha de «mes siguiente» se abriría hacia un mes que aún no empieza.
 */
export const mesActual = (): string =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Bogota', year: 'numeric', month: '2-digit',
  }).format(new Date())

/** Suma meses a un 'YYYY-MM'. Cuenta meses corridos para no pasarse de año. */
export function masMeses(mesIso: string, meses: number): string {
  const corrido = Number(mesIso.slice(0, 4)) * 12 + (Number(mesIso.slice(5, 7)) - 1) + meses
  const anio = Math.floor(corrido / 12)
  const mes = (corrido % 12) + 1
  return `${anio}-${String(mes).padStart(2, '0')}`
}

/** 'hoy', 'ayer', 'mañana' o la fecha larga. */
export function relativa(fechaIso: string, hoyIso: string): string {
  if (fechaIso === hoyIso) return 'hoy'
  if (fechaIso === masDias(hoyIso, 1)) return 'mañana'
  if (fechaIso === masDias(hoyIso, -1)) return 'ayer'
  return fechaLarga(fechaIso)
}

/** Días entre dos fechas civiles. Negativo si ya pasó. */
export function diasHasta(fechaIso: string, hoyIso: string): number {
  const a = partes(fechaIso)
  const b = partes(hoyIso)
  return Math.round(
    (Date.UTC(a.anio, a.mes - 1, a.dia) - Date.UTC(b.anio, b.mes - 1, b.dia)) / 86400000)
}

/** 1240000 → '$1.240.000'. Sin decimales: en pesos no aportan nada. */
export function pesos(monto: number): string {
  const signo = monto < 0 ? '−' : ''
  const entero = Math.abs(Math.round(monto)).toString()
  const conPuntos = entero.replace(/\B(?=(\d{3})+(?!\d))/g, '.')
  return `${signo}$${conPuntos}`
}
