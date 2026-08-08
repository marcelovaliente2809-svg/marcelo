/**
 * Escribir plata como la escribe un colombiano.
 *
 * Es una copia deliberada de `enPalabras` del backend, no un import: la app
 * se despliega sola en Vercel y no comparte build con la laptop. Si cambia
 * allá, esto es lo que hay que cambiar aquí — igual que los tipos.
 */

const DECIMALES = 2

export function pesos(centavos: number, moneda = 'COP'): string {
  const signo = centavos < 0 ? '−' : ''
  const abs = Math.abs(centavos)
  const enteros = Math.floor(abs / 10 ** DECIMALES)
  const resto = abs % 10 ** DECIMALES

  const miles = enteros.toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.')
  const simbolo = moneda === 'COP' ? '$' : moneda === 'USD' ? 'US$' : '€'

  // Los pesos casi nunca llevan centavos y ponerlos en cero ensucia.
  const cola = moneda === 'COP' && resto === 0
    ? ''
    : `,${String(resto).padStart(DECIMALES, '0')}`

  return `${signo}${simbolo}${miles}${cola}`
}

/** Para las barras: qué proporción del mayor representa. */
export const proporcion = (valor: number, mayor: number): number =>
  mayor <= 0 ? 0 : Math.max(0.04, valor / mayor)

/** «vence en 2 días», «venció hace 3 días», «vence hoy». */
export function vencimiento(dias: number): { texto: string; tono: string } {
  if (dias < 0) {
    const d = Math.abs(dias)
    return { texto: `venció hace ${d} día${d === 1 ? '' : 's'}`, tono: 'urgente' }
  }
  if (dias === 0) return { texto: 'vence hoy', tono: 'urgente' }
  if (dias === 1) return { texto: 'vence mañana', tono: 'urgente' }
  if (dias <= 5) return { texto: `vence en ${dias} días`, tono: 'alta' }
  return { texto: `vence en ${dias} días`, tono: '' }
}

const MESES = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
]

/** «2026-08-07» → «7 de agosto». Cortando la cadena, sin tocar zonas. */
export function diaLegible(iso: string): string {
  const [, mes, dia] = iso.slice(0, 10).split('-')
  return `${Number(dia)} de ${MESES[Number(mes) - 1] ?? ''}`
}

export const mesLegible = (iso: string): string => {
  const [anio, mes] = iso.slice(0, 10).split('-')
  return `${MESES[Number(mes) - 1] ?? ''} de ${anio}`
}

/** Para el eje del año: 1 → «Ene». */
export const mesCorto = (mes: number): string =>
  (MESES[mes - 1] ?? '').slice(0, 3).replace(/^./, (c) => c.toUpperCase())
