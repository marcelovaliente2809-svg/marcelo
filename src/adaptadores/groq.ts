import OpenAI from 'openai'
import { ZodError } from 'zod'
import { ErrorLLM, type CausaLLM, type PeticionJson, type ProveedorLLM } from '../puertos/proveedor-llm.ts'

const REINTENTOS_POR_DEFECTO = 3

/** Un 429 no se arregla en 300 ms. Los otros fallos casi siempre sí. */
const ESPERA_FORMATO_MS = 300
const ESPERA_CUOTA_MS = 4_000

interface FalloHttp {
  status?: number
  headers?: Record<string, string> | { get?(n: string): string | null }
  message?: string
}

function codigoDe(e: unknown): number | undefined {
  return (e as FalloHttp | null)?.status
}

/**
 * Cuánto pide esperar el proveedor.
 *
 * Casi todos mandan `retry-after` en segundos cuando cortan por cuota.
 * Hacerle caso es la diferencia entre esperar lo justo y adivinar.
 */
function esperaPedida(e: unknown): number | undefined {
  const cabeceras = (e as FalloHttp | null)?.headers
  if (!cabeceras) return undefined

  const leer = typeof (cabeceras as { get?: unknown }).get === 'function'
    ? (n: string) => (cabeceras as { get(n: string): string | null }).get(n)
    : (n: string) => (cabeceras as Record<string, string>)[n]

  const crudo = leer('retry-after') ?? leer('Retry-After')
  const segundos = Number(crudo)
  return Number.isFinite(segundos) && segundos > 0 ? segundos * 1000 : undefined
}

function causaDe(e: unknown): CausaLLM {
  // Primero lo nuestro. Un fallo de esquema o de JSON ocurre DESPUÉS de que
  // el proveedor contestó perfectamente, así que llamarlo «no se pudo
  // llegar al proveedor» —que es lo que pasaba, porque un ZodError no trae
  // código HTTP y caía en el `undefined`— mandaba a mirar la red, la clave
  // y la cuota mientras el problema estaba en la forma de la respuesta.
  if (e instanceof ZodError || e instanceof SyntaxError) return 'formato'

  const codigo = codigoDe(e)
  if (codigo === 429) return 'cuota'
  if (codigo === 404) return 'modelo'
  if (codigo === 401 || codigo === 403) return 'clave'
  if (codigo !== undefined && codigo >= 500) return 'red'
  if (codigo === undefined) return 'red'
  return 'formato'
}

/**
 * Groq expone una API compatible con OpenAI, así que este mismo adaptador
 * sirve para cualquier proveedor compatible cambiando la URL base. Eso
 * convierte "cambiar de cerebro" en una variable de entorno.
 *
 * Requiere Zero Data Retention activado en Data Controls: este sistema le
 * manda al modelo correos bancarios de una persona real.
 */
export class ProveedorGroq implements ProveedorLLM {
  private readonly cliente: OpenAI

  constructor(apiKey: string, baseURL: string) {
    this.cliente = new OpenAI({ apiKey, baseURL })
  }

  async completarJson<T>(p: PeticionJson<T>): Promise<T> {
    const intentos = p.reintentos ?? REINTENTOS_POR_DEFECTO
    let ultima = ''
    let ultimoFallo: unknown
    let causa: CausaLLM = 'formato'
    let esperar: number | undefined

    for (let i = 0; i < intentos; i++) {
      try {
        const respuesta = await this.cliente.chat.completions.create({
          model: p.modelo,
          temperature: 0,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: p.sistema },
            { role: 'user', content: p.usuario },
          ],
        })
        ultima = respuesta.choices[0]?.message?.content ?? ''
        return p.esquema.parse(JSON.parse(limpiarFences(ultima)))
      } catch (e) {
        ultimoFallo = e
        causa = causaDe(e)
        esperar = esperaPedida(e)

        // Un modelo que no existe y una clave que no vale no cambian por
        // insistir. Reintentarlos tres veces sólo retrasa el aviso y
        // esconde la causa detrás de «no produjo JSON válido».
        if (causa === 'modelo' || causa === 'clave') break

        if (i < intentos - 1) {
          const base = causa === 'cuota' ? ESPERA_CUOTA_MS : ESPERA_FORMATO_MS
          await new Promise((r) => setTimeout(r, esperar ?? base * 2 ** i))
        }
      }
    }

    throw new ErrorLLM(explicar(causa, p.modelo, ultimoFallo, intentos), ultima, causa, esperar)
  }
}

/**
 * `response_format: json_object` no siempre alcanza: algunos modelos igual
 * envuelven la respuesta en un bloque de markdown (` ```json ... ``` `).
 * Sin esto, `JSON.parse` truena con «Unexpected token '`'» delante de un
 * JSON por lo demás perfecto, y el hecho se pierde tras los reintentos.
 */
function limpiarFences(texto: string): string {
  const limpio = texto.trim()
  const conFences = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(limpio)
  return conFences ? conFences[1]!.trim() : limpio
}

/** El mensaje que va al log tiene que decir qué hacer, no sólo qué pasó. */
function explicar(
  causa: CausaLLM, modelo: string, fallo: unknown, intentos: number
): string {
  if (causa === 'modelo') {
    return `El proveedor no conoce el modelo «${modelo}». `
      + 'Abre el asistente de configuración y dale a Probar en «El cerebro»: '
      + 'vuelve a elegir del catálogo de hoy.'
  }
  if (causa === 'clave') {
    return 'El proveedor no acepta la clave. Genera otra y ponla en el asistente.'
  }
  if (causa === 'cuota') {
    return `Sin cuota en el proveedor (429) con «${modelo}». `
      + 'Se reintenta más tarde: no se pierde nada.'
  }
  if (causa === 'red') return `No se pudo llegar al proveedor: ${String(fallo)}`
  // Se nombra el campo que falló: «no produjo JSON válido» delante de un
  // JSON impecable al que sólo le sobra un decimal no ayuda a nadie.
  if (fallo instanceof ZodError) {
    const donde = fallo.issues
      .map((i) => `${i.path.join('.') || 'la raíz'} (${i.message})`)
      .join('; ')
    return `«${modelo}» contestó, pero su respuesta no encaja en ${intentos} intentos: ${donde}`
  }
  return `El modelo no produjo JSON válido en ${intentos} intentos: ${String(fallo)}`
}
