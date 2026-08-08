import { z } from 'zod'
import type { Confianza } from './tipos.ts'

/**
 * El referente se captura tal como lo dijo el correo. Convertirlo a una
 * fecha concreta es trabajo de resolverReferente() con Luxon: el modelo no
 * calcula fechas porque es justo lo que peor hace.
 *
 * Nótese que no existe ningún campo donde el modelo pueda meter una fecha
 * ya calculada. Si lo intenta, el esquema lo rechaza.
 */
export const EsquemaReferente = z.discriminatedUnion('tipo', [
  z.object({ tipo: z.literal('hoy') }),
  z.object({ tipo: z.literal('manana') }),
  // Algunos modelos devuelven un datetime completo (con hora y offset) en
  // vez de sólo la fecha, a pesar de que se les pide lo contrario. Se
  // acepta esa forma para no perder el correo por un detalle de formato,
  // pero resolverReferente() sólo usa la fecha: la hora que el modelo haya
  // puesto se descarta igual, así que nunca es el modelo quien decide el
  // momento exacto.
  z.object({
    tipo: z.literal('fecha'),
    iso: z.string().regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?)?$/),
  }),
  z.object({
    tipo: z.literal('dia_semana'),
    dia: z.number().int().min(1).max(7),
    modificador: z.enum(['este', 'proximo']),
  }),
  z.object({ tipo: z.literal('desconocido') }),
])

/**
 * La confianza, dicha como quiera decirla el modelo.
 *
 * Se le pide «alta», «media» o «baja» y muchos contestan `0.9`, que es la
 * forma natural de un modelo de expresar certeza. Rechazar eso paraba la
 * lectura de correo ENTERA: cada correo daba error de formato, se
 * reintentaba tres veces, quemaba cuota y volvía a fallar — con el modelo
 * respondiendo perfectamente y el sentido intacto.
 *
 * Traducir un número a una casilla es una decisión, y las decisiones son
 * del código. Aquí se hace una sola vez, en el borde, y de ahí para dentro
 * el dominio sigue viendo tres valores y nada más.
 *
 * Ser estricto con la forma y flexible con el envoltorio no es una
 * concesión: el esquema sigue rechazando lo que no significa nada.
 */
// El tipo se declara a mano para que de aquí salgan tres valores y nada
// más. Sin eso, TypeScript propaga el `string | number` que este esquema
// ACEPTA por todo el dominio, y la tolerancia del borde —que es lo único
// que se quería— acabaría contaminando hasta la política.
// El tercer parámetro es lo que ACEPTA; el primero, lo que SALE. No puede
// ser `unknown`: `unknown` incluye `undefined`, y entonces `z.object` da el
// campo por opcional y `confianza` se vuelve `Confianza | undefined` en
// todo el dominio — justo el tipo que la política no sabe leer.
export const EsquemaConfianza: z.ZodType<Confianza, z.ZodTypeDef, string | number> = z
  .union([z.string(), z.number()])
  .transform(normalizar)
  .pipe(z.enum(['alta', 'media', 'baja']))

function normalizar(v: string | number): string {
  if (typeof v === 'number') return aCasilla(v)
  const s = v.trim().toLowerCase()
  if (s === 'alta' || s === 'media' || s === 'baja') return s
  // Los modelos en inglés son mayoría, y traducen la etiqueta antes que el
  // contenido. Aceptarlas sale más barato que un reintento.
  if (s === 'high') return 'alta'
  if (s === 'medium' || s === 'moderate') return 'media'
  if (s === 'low') return 'baja'
  const n = Number(s)
  // Lo que no significa nada se deja pasar tal cual para que el enum lo
  // rechace: tolerar la forma no es tragarse cualquier cosa.
  return Number.isFinite(n) && s !== '' ? aCasilla(n) : s
}

/**
 * Los cortes son deliberadamente severos por el lado de arriba: «alta» es
 * lo que la política deja actuar sin preguntar, así que un 0.8 —que un
 * modelo suelta con bastante alegría— tiene que quedarse en «media» y
 * pasar por confirmación.
 */
function aCasilla(n: number): string {
  // Algunos responden en porcentaje. 90 y 0.9 quieren decir lo mismo.
  const p = n > 1 ? n / 100 : n
  if (!Number.isFinite(p) || p < 0) return 'baja'
  if (p >= 0.85) return 'alta'
  if (p >= 0.5) return 'media'
  return 'baja'
}

export const EsquemaClasificacion = z.object({
  clasificacion: z.enum(['agenda', 'finanzas', 'ruido']),
  confianza: EsquemaConfianza,
})

export const EsquemaHechoAgenda = z.object({
  intencion: z.enum(['cancelar', 'mover', 'crear', 'ninguna']),
  referente: EsquemaReferente,
  nuevoInicio: z.string().regex(/^\d{2}:\d{2}$/).nullable(),
  nuevoFin: z.string().regex(/^\d{2}:\d{2}$/).nullable(),
  menciones: z.array(z.string()),
  confianza: EsquemaConfianza,
})

export const EsquemaEleccion = z.object({
  compromisoId: z.number().int().nullable(),
  justificacion: z.string(),
})

export type HechoAgenda = z.infer<typeof EsquemaHechoAgenda>
export type ResultadoClasificacion = z.infer<typeof EsquemaClasificacion>
