import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { readFile, writeFile, copyFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import Fastify from 'fastify'
import { Client } from 'pg'
import { escribirEnv, leerEnv } from './archivo-env.ts'
import { nuevaClaveRespaldo } from '../dominio/cifrado.ts'
import { revisar, valoresRecordados, type Revision } from './estado.ts'
import { paginaConfiguracion } from './pagina.ts'
import { esperarChat, probarBase, probarProveedor, probarTelegram } from './verificaciones.ts'
import {
  POR_DEFECTO, PROVEEDORES, precioEnPalabras, proveedorPorId, urlDe,
} from './proveedores.ts'
import { CLAVES, canjearCodigo, urlDeConsentimiento, type Proveedor } from './oauth.ts'
import { abrirTunel, type Tunel } from './tunel.ts'
import { publicarVariables, redesplegar, variablesDeLaApp } from './vercel.ts'
import { probarCadena } from './cadena.ts'
import {
  comandoDeInstalacion, gestorDe, plataformaActual, porId, revisarRequisitos,
  type Ejecutar,
} from './requisitos.ts'
import {
  comandoDeTarea, comandosDeVigilia, enPalabras, revisarVigilia,
} from './vigilia.ts'
import { pasosDeActualizacion, revisarVersion } from './actualizar.ts'

/** Para armar un único comando de shell sin que un espacio parta el argumento en dos. */
const comillarParaShell = (arg: string) =>
  /[\s"]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg

/**
 * El asistente de configuración.
 *
 * **Sólo escucha en 127.0.0.1.** Eso no es un detalle de despliegue: es la
 * autenticación entera. Esta página recoge el secreto de cliente de
 * Google, la clave de Groq y el token del bot; expuesta a internet sería
 * una cosechadora de credenciales, y por eso no puede vivir en Vercel ni
 * colgar del túnel. Quien puede abrirla es quien ya está sentado frente a
 * la laptop, y a ése no hay nada que preguntarle.
 *
 * Va en su propio proceso y su propio puerto, aparte del Fastify que sí
 * sale por el túnel, para que no exista ni la posibilidad de un despiste.
 */

export interface OpcionesConfigurador {
  /** Dónde vive el .env que se va a escribir. */
  rutaEnv?: string
  puerto?: number
  /** El puerto del servicio de verdad, para el túnel. */
  puertoServicio?: number
  registro?: { info(o: object, m?: string): void; error(o: object, m?: string): void }
}

const PUERTO_POR_DEFECTO = 3210

interface EsperaOauth {
  proveedor: Proveedor
  clientId: string
  clientSecret: string
  redirectUri: string
  tenant: string
}

export async function arrancarConfigurador(o: OpcionesConfigurador = {}) {
  const rutaEnv = resolve(o.rutaEnv ?? process.env.RUTA_ENV ?? '.env')
  const puerto = o.puerto ?? Number(process.env.PUERTO_CONFIG || PUERTO_POR_DEFECTO)
  const puertoServicio = o.puertoServicio ?? Number(process.env.PUERTO || 3000)
  const raiz = `http://localhost:${puerto}`

  // El .env manda sobre lo que ya estuviera en el entorno: es el archivo
  // que esta pantalla edita y el que se va a leer al reiniciar.
  const enArchivo = existsSync(rutaEnv) ? leerEnv(await readFile(rutaEnv, 'utf8')) : {}
  const env: Record<string, string> = { ...process.env as Record<string, string>, ...enArchivo }

  const esperas = new Map<string, EsperaOauth>()
  let tunel: Tunel | null = null

  async function guardar(cambios: Record<string, string>): Promise<void> {
    await escribirEnv(rutaEnv, cambios, {
      existe: existsSync,
      leer: (r) => readFile(r, 'utf8'),
      escribir: (r, t) => writeFile(r, t, 'utf8'),
      respaldar: (r, destino) => copyFile(r, destino),
    })
    Object.assign(env, cambios)
    Object.assign(process.env, cambios)
  }

  const estado = (): Revision => revisar(env)

  /**
   * Contarle a Vercel dónde está la laptop, y redesplegar para que se
   * entere. Los dos pasos van juntos siempre: poner las variables sin
   * redesplegar deja la app corriendo con las de antes, que se ve
   * exactamente igual que no haber hecho nada.
   */
  async function publicarYDesplegar(): Promise<{ ok: boolean; mensaje: string }> {
    const variables = variablesDeLaApp(env)
    if (!variables.API_BASE) {
      return { ok: false, mensaje: 'Abre primero el túnel: sin dirección pública la app no sabe a dónde llamar.' }
    }

    const puesta = await publicarVariables(
      { token: env.VERCEL_TOKEN ?? '', proyecto: env.VERCEL_PROYECTO ?? '' }, variables)
    if (!puesta.ok) return puesta

    const gancho = env.VERCEL_GANCHO ?? ''
    if (!gancho) {
      return {
        ok: true,
        mensaje: `${puesta.mensaje} Falta el gancho: redesplega a mano desde Vercel para que se apliquen.`,
      }
    }
    const despliegue = await redesplegar(gancho)
    return { ok: despliegue.ok, mensaje: `${puesta.mensaje} ${despliegue.mensaje}` }
  }

  const app = Fastify({ logger: false })

  /**
   * Los formularios de HTML no mandan JSON.
   *
   * El botón de «Aplicar y arrancar» es un `<form method="post">` —a
   * propósito: tiene que navegar a la respuesta, porque el proceso se va a
   * morir justo después y un `fetch` se quedaría colgado—. Manda
   * `x-www-form-urlencoded`, que Fastify no entiende de fábrica, así que
   * devolvía un 415 en crudo. El único botón que cierra la configuración
   * era el único que no funcionaba.
   */
  app.addContentTypeParser(
    'application/x-www-form-urlencoded', { parseAs: 'string' },
    (_req, cuerpo, hecho) => {
      hecho(null, Object.fromEntries(new URLSearchParams(String(cuerpo))))
    })

  app.get('/', async (_req, res) => {
    res.type('text/html; charset=utf-8')
    return paginaConfiguracion({
      redirecciones: {
        google: `${raiz}/oauth/google`,
        microsoft: `${raiz}/oauth/microsoft`,
      },
      puertoServicio,
      urlPropuestaBase: env.DATABASE_URL
        || 'postgres://asistente:cambiame@localhost:5433/asistente',
    })
  })

  app.get('/api/estado', async () => ({
    ...estado(),
    ...valoresRecordados(env),
    // Para que la pantalla pueda decir a qué dirección volver.
    puerto,
    // Lo que él necesita para abrirla en el celular cuando todo esté listo.
    app: { url: env.APP_URL ?? '', codigo: env.CODIGO_ACCESO ?? '' },
  }))

  // ── requisitos de la máquina ────────────────────────────────

  const plataforma = plataformaActual(process.platform)

  /** Correr un programa y quedarse con lo que diga, sin que nada reviente. */
  /**
   * Correr un programa con reloj.
   *
   * El timeout no es una precaución teórica: `git fetch` sobre HTTPS se
   * queda esperando credenciales, y sin límite la promesa no se resuelve
   * nunca — la petición se cuelga y la página gira para siempre. Un
   * comando que no contesta en 20 segundos no va a contestar.
   */
  const correr = (programa: string, argumentos: string[], limiteMs = 20_000) =>
    new Promise<{ ok: boolean; salida: string }>((cumplir) => {
      const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' }

      // `shell: true` en Windows porque winget, docker y cloudflared se
      // instalan como .cmd y sin shell no se encuentran en el PATH. Node
      // advierte (DEP0190) si a `shell: true` se le pasa además un array de
      // argumentos, así que en Windows se arma un único string de comando
      // en vez de mezclar las dos formas.
      const proceso = plataforma === 'windows'
        ? spawn([programa, ...argumentos].map(comillarParaShell).join(' '), { shell: true, env })
        : spawn(programa, argumentos, { shell: false, env })

      let salida = ''
      let cerrado = false
      const acabar = (ok: boolean) => {
        if (cerrado) return
        cerrado = true
        clearTimeout(reloj)
        cumplir({ ok, salida })
      }

      const reloj = setTimeout(() => {
        proceso.kill()
        salida += `\n(se pasó de ${Math.round(limiteMs / 1000)} s y lo corté)`
        acabar(false)
      }, limiteMs)

      const recoger = (t: Buffer) => { salida += t.toString() }
      proceso.stdout?.on('data', recoger)
      proceso.stderr?.on('data', recoger)
      proceso.on('error', () => acabar(false))
      proceso.on('close', (codigo) => acabar(codigo === 0))
    })

  /**
   * Instalar tarda minutos, así que no se espera dentro de la petición: se
   * lanza, se contesta enseguida y la página va preguntando cómo va.
   */
  const instalaciones = new Map<string, { hecho: boolean; ok: boolean; lineas: string[] }>()

  app.get('/api/requisitos', async () => ({
    ...(await revisarRequisitos(correr, plataforma)),
    plataforma,
    gestor: gestorDe(plataforma),
    instalando: Object.fromEntries(
      [...instalaciones].map(([id, e]) => [id, {
        hecho: e.hecho, ok: e.ok, ultima: e.lineas.at(-1) ?? '',
      }])),
  }))

  app.post('/api/requisitos/instalar', async (req) => {
    const { id = '' } = (req.body ?? {}) as Record<string, string>
    const requisito = porId(id)
    if (!requisito) return { ok: false, mensaje: 'No sé qué es eso.' }

    const comando = comandoDeInstalacion(requisito, plataforma)
    if (!comando) {
      return {
        ok: false,
        mensaje: `En este sistema tengo que pedirte que lo instales tú: ${requisito.manual}`,
      }
    }

    const enCurso = instalaciones.get(id)
    if (enCurso && !enCurso.hecho) {
      return { ok: true, mensaje: `Instalando ${requisito.nombre}… puede tardar varios minutos.` }
    }

    const estado = { hecho: false, ok: false, lineas: [] as string[] }
    instalaciones.set(id, estado)

    const proceso = spawn(comando.programa, comando.argumentos, {
      shell: plataforma === 'windows',
    })
    const anotar = (t: Buffer) => {
      // Sólo el último rato: winget escribe barras de progreso a chorros.
      estado.lineas.push(...t.toString().split(/\r?\n/).filter((l) => l.trim()))
      if (estado.lineas.length > 40) estado.lineas.splice(0, estado.lineas.length - 40)
    }
    proceso.stdout?.on('data', anotar)
    proceso.stderr?.on('data', anotar)
    proceso.on('error', (e) => {
      estado.hecho = true
      estado.lineas.push(String(e))
      o.registro?.error({ err: e, id }, 'no se pudo lanzar el instalador')
    })
    proceso.on('close', (codigo) => {
      estado.hecho = true
      estado.ok = codigo === 0
      o.registro?.info({ id, codigo }, 'instalación terminada')
    })

    return {
      ok: true,
      mensaje: `Instalando ${requisito.nombre}. Tarda varios minutos; te voy diciendo.`,
    }
  })

  // ── actualizarse ────────────────────────────────────────────

  const actualizacion = { corriendo: false, lineas: [] as string[], ok: false, hecho: false }

  app.get('/api/version', async () => ({
    ...(await revisarVersion(correr)),
    corriendo: actualizacion.corriendo,
    ultima: actualizacion.lineas.at(-1) ?? '',
    hecho: actualizacion.hecho,
    ok: actualizacion.ok,
  }))

  app.post('/api/actualizar', async () => {
    if (actualizacion.corriendo) {
      return { ok: true, mensaje: 'Ya estoy actualizándome. Dame un momento.' }
    }

    const estado = await revisarVersion(correr)
    if (!estado.esRepo) {
      return { ok: false, mensaje: 'Esto no se bajó con git, así que no me sé actualizar sola.' }
    }
    if (estado.sucio) {
      return {
        ok: false,
        // Pisarlos sería peor: alguien los puso ahí por algo.
        mensaje: 'Hay archivos cambiados a mano en esta carpeta. No voy a pisarlos: '
          + 'avísale a Jose antes de actualizar.',
      }
    }
    if (!estado.hayQueActualizar) {
      return { ok: true, mensaje: `Ya estás en lo último (${estado.version}).` }
    }

    actualizacion.corriendo = true
    actualizacion.hecho = false
    actualizacion.lineas = []

    void (async () => {
      try {
        for (const paso of pasosDeActualizacion()) {
          actualizacion.lineas.push(`${paso.que}…`)
          const r = await correr(paso.programa, paso.argumentos)
          if (!r.ok && !paso.opcional) {
            actualizacion.lineas.push(`falló al ${paso.que}: ${r.salida.trim().slice(-200)}`)
            actualizacion.ok = false
            actualizacion.hecho = true
            actualizacion.corriendo = false
            return
          }
          if (!r.ok) actualizacion.lineas.push(`aviso: ${paso.que} no terminó bien`)
        }
        actualizacion.lineas.push('listo, reiniciando')
        actualizacion.ok = true
        actualizacion.hecho = true
        actualizacion.corriendo = false
        // El 7 vuelve a arrancarme con el código nuevo. Las migraciones
        // corren solas al arrancar, así que no hay más que hacer.
        setTimeout(() => process.exit(7), 1200)
      } catch (e) {
        actualizacion.lineas.push(String(e))
        actualizacion.hecho = true
        actualizacion.corriendo = false
      }
    })()

    return {
      ok: true,
      mensaje: `Trayendo ${estado.detras} cambio${estado.detras === 1 ? '' : 's'}. `
        + 'Tarda un par de minutos y me reinicio sola al terminar.',
      avisos: ['Tu configuración y tus datos no se tocan: el .env no está en git '
        + 'y la base de datos vive en Docker, fuera del proyecto.'],
    }
  })

  // ── que no se duerma y que vuelva sola ──────────────────────

  const carpeta = process.cwd()

  app.get('/api/vigilia', async () => {
    if (plataforma !== 'windows') {
      return { soportado: false, dichos: ['Esto sólo lo sé arreglar en Windows.'], listo: true }
    }
    const estado = await revisarVigilia(correr)
    return { soportado: true, ...estado, dichos: enPalabras(estado), carpeta }
  })

  app.post('/api/vigilia/despierta', async () => {
    if (plataforma !== 'windows') {
      return { ok: false, mensaje: 'Esto sólo lo sé hacer en Windows.' }
    }
    const fallos: string[] = []
    for (const c of comandosDeVigilia()) {
      const r = await correr(c.programa, c.argumentos)
      // Los opcionales necesitan administrador y el resto funciona sin
      // ellos: contarlos como fallo diría que no se hizo nada cuando sí.
      if (!r.ok && !c.opcional) {
        fallos.push(`${c.argumentos[1] ?? c.argumentos[0]}: ${r.salida.trim().slice(0, 120)}`)
      }
    }
    if (fallos.length > 0) {
      return {
        ok: false,
        mensaje: 'Windows no me dejó cambiar la energía. Cierra y abre ARRANCAR.cmd '
          + 'con «Ejecutar como administrador» y vuelve a intentarlo.',
        avisos: fallos.slice(0, 2),
      }
    }
    return {
      ok: true,
      mensaje: 'Listo: enchufada no se duerme, y puedes cerrar la tapa sin apagarla.',
      avisos: ['La pantalla sí se apaga a los 10 min. Eso no congela nada y cuida el panel.'],
    }
  })

  app.post('/api/vigilia/arrancar-con-windows', async () => {
    if (plataforma !== 'windows') {
      return { ok: false, mensaje: 'Esto sólo lo sé hacer en Windows.' }
    }
    const c = comandoDeTarea(carpeta)
    const r = await correr(c.programa, c.argumentos)
    return r.ok
      ? {
          ok: true,
          mensaje: 'Registrada. Cuando Windows arranque y entres a tu usuario, se abre sola.',
          avisos: ['Para que funcione tras un reinicio de madrugada, Windows tiene que '
            + 'entrar solo a tu usuario. El botón de abajo abre esa configuración.'],
        }
      : { ok: false, mensaje: `No pude registrarla: ${r.salida.trim().slice(0, 200)}` }
  })

  /** Abre el diálogo de Windows donde se activa el inicio de sesión automático. */
  app.post('/api/vigilia/inicio-automatico', async () => {
    if (plataforma !== 'windows') return { ok: false, mensaje: 'Sólo en Windows.' }
    spawn('netplwiz', [], { shell: true, detached: true, stdio: 'ignore' }).unref()
    return {
      ok: true,
      mensaje: 'Te abrí la ventana de Windows. Quita la casilla «Los usuarios deben '
        + 'escribir su nombre y contraseña», dale a Aplicar y escribe tu contraseña.',
    }
  })

  // ── probar cada pieza ───────────────────────────────────────

  /**
   * Levantar el contenedor de Postgres.
   *
   * Antes esto era «abre una terminal y corre docker compose up -d», que es
   * pedirle a alguien que no programa justo lo único que no sabe hacer.
   */
  app.post('/api/base/levantar', async () => {
    const arriba = await correr('docker', ['info'])
    if (!arriba.ok) {
      return {
        ok: false,
        mensaje: 'Docker Desktop no está corriendo. Ábrelo con el botón de arriba, '
          + 'espera a que la ballena deje de moverse, y vuelve.',
      }
    }

    const r = await correr('docker', ['compose', 'up', '-d', 'db'])
    if (!r.ok) {
      return { ok: false, mensaje: `Docker no pudo: ${r.salida.trim().slice(0, 250)}` }
    }
    return {
      ok: true,
      mensaje: 'Base de datos levantada. Dale a Probar conexión.',
      avisos: ['Queda encendida sola cada vez que arranque Docker.'],
    }
  })

  /** Docker instalado pero cerrado es el caso más común de todos. */
  app.post('/api/base/abrir-docker', async () => {
    if (plataforma !== 'windows') {
      return { ok: false, mensaje: 'Ábrelo tú desde tus aplicaciones.' }
    }
    spawn('cmd', ['/c', 'start', '', '"C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe"'],
      { shell: false, detached: true, stdio: 'ignore' }).unref()
    return {
      ok: true,
      mensaje: 'Abriendo Docker Desktop. Tarda como un minuto en estar listo: '
        + 'espera a que el icono de la ballena deje de moverse.',
    }
  })

  app.post('/api/probar/base', async (req) => {
    const { DATABASE_URL = '' } = (req.body ?? {}) as Record<string, string>
    const r = await probarBase(DATABASE_URL, async (url) => {
      const cliente = new Client({ connectionString: url, connectionTimeoutMillis: 6000 })
      await cliente.connect()
      try {
        await cliente.query('SELECT 1')
      } finally {
        await cliente.end()
      }
    })
    if (r.ok && r.guardar) await guardar(r.guardar)
    return r
  })

  // Un campo que llega vacío no borra lo que ya estaba: la página no
  // devuelve los secretos, así que vacío significa «déjalo como está».
  const oLoGuardado = (cuerpo: Record<string, string>, clave: string): string =>
    (cuerpo[clave] ?? '').trim() || (env[clave] ?? '')

  app.get('/api/proveedores', async () => ({
    proveedores: PROVEEDORES.map((p) => ({
      ...p, precioTexto: precioEnPalabras(p),
    })),
    elegido: env.LLM_PROVEEDOR || POR_DEFECTO,
  }))

  app.post('/api/probar/llm', async (req) => {
    const cuerpo = (req.body ?? {}) as Record<string, string>
    const id = (cuerpo.LLM_PROVEEDOR || env.LLM_PROVEEDOR || POR_DEFECTO).trim()
    const proveedor = proveedorPorId(id)

    const r = await probarProveedor(
      oLoGuardado(cuerpo, 'LLM_API_KEY') || env.GROQ_API_KEY || '',
      urlDe(id, cuerpo.LLM_BASE_URL ?? ''),
      { nombre: proveedor?.nombre, preferidos: proveedor?.preferidos })

    if (r.ok && r.guardar) await guardar({ ...r.guardar, LLM_PROVEEDOR: id })
    return r
  })

  /**
   * El oído, por su cuenta.
   *
   * Hay proveedores buenísimos leyendo que no transcriben. Antes que
   * dejarla muda, se le deja el oído en Groq —que da Whisper grande
   * gratis— y el cerebro donde se quiera.
   */
  app.post('/api/probar/voz', async (req) => {
    const cuerpo = (req.body ?? {}) as Record<string, string>
    const r = await probarProveedor(
      oLoGuardado(cuerpo, 'VOZ_API_KEY'),
      urlDe('groq', cuerpo.VOZ_BASE_URL ?? ''),
      { nombre: 'el oído', preferidos: proveedorPorId('groq')?.preferidos })

    if (!r.ok) return r
    if (!r.eleccion?.transcriptor) {
      return { ok: false, mensaje: 'Ahí no hay ningún modelo de voz. Prueba con Groq.' }
    }
    await guardar({
      VOZ_API_KEY: oLoGuardado(cuerpo, 'VOZ_API_KEY'),
      VOZ_BASE_URL: urlDe('groq', cuerpo.VOZ_BASE_URL ?? ''),
      VOZ_MODELO: r.eleccion.transcriptor,
    })
    return { ok: true, mensaje: `Listo, oye con ${r.eleccion.transcriptor}.` }
  })

  app.post('/api/probar/telegram', async (req) => {
    const cuerpo = (req.body ?? {}) as Record<string, string>
    const r = await probarTelegram(oLoGuardado(cuerpo, 'TELEGRAM_BOT_TOKEN'))
    if (r.ok && r.guardar) await guardar(r.guardar)
    return r
  })

  app.post('/api/telegram/emparejar', async (req) => {
    const cuerpo = (req.body ?? {}) as Record<string, string>
    const token = cuerpo.TELEGRAM_BOT_TOKEN || env.TELEGRAM_BOT_TOKEN || ''
    if (!token) return { ok: false, mensaje: 'Primero prueba el token del bot.' }
    const r = await esperarChat(token)
    if (r.ok && r.guardar) await guardar(r.guardar)
    return r
  })

  // ── OAuth: el permiso vuelve a esta misma máquina ───────────

  const arrancarOauth = (proveedor: Proveedor) => async (req: { body?: unknown }) => {
    const cuerpo = (req.body ?? {}) as Record<string, string>
    const clientId = oLoGuardado(
      cuerpo, proveedor === 'google' ? 'GOOGLE_CLIENT_ID' : 'MS_CLIENT_ID')
    const clientSecret = oLoGuardado(
      cuerpo, proveedor === 'google' ? 'GOOGLE_CLIENT_SECRET' : 'MS_CLIENT_SECRET')

    if (!clientId.trim() || !clientSecret.trim()) {
      return { ok: false, mensaje: 'Faltan el ID de cliente o el secreto.' }
    }

    await guardar(proveedor === 'google'
      ? { GOOGLE_CLIENT_ID: clientId.trim(), GOOGLE_CLIENT_SECRET: clientSecret.trim() }
      : { MS_CLIENT_ID: clientId.trim(), MS_CLIENT_SECRET: clientSecret.trim() })

    const estadoOauth = randomBytes(16).toString('hex')
    const redirectUri = `${raiz}/oauth/${proveedor}`
    const tenant = env.MS_TENANT_ID || 'common'
    esperas.set(estadoOauth, {
      proveedor, clientId: clientId.trim(), clientSecret: clientSecret.trim(),
      redirectUri, tenant,
    })

    return {
      ok: true,
      mensaje: 'Te llevo a dar el permiso…',
      ir: urlDeConsentimiento({
        proveedor, clientId: clientId.trim(), redirectUri, estado: estadoOauth, tenant,
      }),
    }
  }

  app.post('/api/oauth/google', arrancarOauth('google'))
  app.post('/api/oauth/microsoft', arrancarOauth('microsoft'))

  const volver = (titulo: string, cuerpo: string) =>
    `<!doctype html><meta charset="utf-8">
     <title>${titulo}</title>
     <body style="font:16px system-ui;padding:48px;max-width:44ch;margin:auto">
     <h2>${titulo}</h2><p>${cuerpo}</p>
     <p><a href="/">Volver al asistente</a></p>
     <script>setTimeout(function(){location.href='/'},2200)</script>`

  app.get('/oauth/:proveedor', async (req, res) => {
    const { state = '', code = '', error = '' } =
      (req.query ?? {}) as Record<string, string>
    res.type('text/html; charset=utf-8')

    if (error) return volver('No se dio el permiso', `Google o Microsoft dijo: ${error}`)

    const espera = esperas.get(state)
    // El `state` es lo que impide que una pestaña cualquiera complete un
    // permiso que este asistente no pidió.
    if (!espera) return volver('Ese permiso no era mío', 'Vuelve a darle a Conectar.')
    esperas.delete(state)

    try {
      const tokens = await canjearCodigo({
        proveedor: espera.proveedor,
        clientId: espera.clientId,
        clientSecret: espera.clientSecret,
        redirectUri: espera.redirectUri,
        tenant: espera.tenant,
        estado: state,
        codigo: code,
      })
      const claves = CLAVES[espera.proveedor]
      await guardar({ [claves.refresh]: tokens.refreshToken, [claves.cuenta]: tokens.cuenta })
      return volver('Conectado', `Ya puedo entrar como ${tokens.cuenta || 'esa cuenta'}.`)
    } catch (e) {
      return volver('No se pudo conectar', e instanceof Error ? e.message : 'sin detalle')
    }
  })

  // ── túnel ───────────────────────────────────────────────────

  app.post('/api/tunel', async (req) => {
    const cuerpo = (req.body ?? {}) as Record<string, string>
    try {
      tunel?.detener()
      tunel = await abrirTunel({
        puertoLocal: puertoServicio,
        nombre: cuerpo.TUNEL_NOMBRE,
        urlFija: cuerpo.URL_PUBLICA,
        ejecutable: env.CLOUDFLARED_RUTA,
      })
      await guardar({
        URL_PUBLICA: tunel.url,
        // Encenderlo aquí y no dejarlo en manos de nadie: `cloudflared` es
        // un proceso HIJO de la asistente, así que se muere con ella. Sin
        // esto, abrir el túnel funcionaba hasta el primer reinicio y
        // después la app decía «sin conexión» apuntando a una dirección
        // que ya no existe. Quien apretó el botón quiere el túnel, y lo
        // quiere también mañana.
        TUNEL_AUTO: 'true',
        ...(cuerpo.TUNEL_NOMBRE?.trim() ? { TUNEL_NOMBRE: cuerpo.TUNEL_NOMBRE.trim() } : {}),
      })
      return {
        ok: true,
        mensaje: `La app te alcanza en ${tunel.url}`,
        rellenar: { URL_PUBLICA: tunel.url },
        avisos: tunel.efimera
          ? ['Esta dirección cambia al reiniciar el túnel. Conecta Vercel abajo y yo la vuelvo a publicar sola.']
          : [],
      }
    } catch (e) {
      return { ok: false, mensaje: e instanceof Error ? e.message : 'no se pudo abrir el túnel' }
    }
  })

  // ── secretos y Vercel ───────────────────────────────────────

  app.post('/api/generar', async () => {
    const nuevos = {
      API_TOKEN: env.API_TOKEN || randomBytes(32).toString('hex'),
      SECRETO_SESION: env.SECRETO_SESION || randomBytes(32).toString('hex'),
      // Corto y legible: lo va a teclear en un teléfono.
      CODIGO_ACCESO: env.CODIGO_ACCESO || randomBytes(4).toString('hex').toUpperCase(),
      // La del respaldo nocturno. Es la única que hay que guardar FUERA de
      // esta laptop: si el disco muere, sin ella el respaldo no se abre.
      RESPALDO_CLAVE: env.RESPALDO_CLAVE || nuevaClaveRespaldo(),
    }
    await guardar(nuevos)
    return {
      ok: true,
      mensaje: `Listo. Tu código para entrar a la app es ${nuevos.CODIGO_ACCESO}.`,
      rellenar: nuevos,
      avisos: ['Ahora copia la clave del respaldo a otro sitio: al gestor de '
        + 'contraseñas o a un papel. Si el disco se muere y se va con él, los '
        + 'respaldos no se pueden abrir.'],
    }
  })

  app.post('/api/vercel', async (req) => {
    const cuerpo = (req.body ?? {}) as Record<string, string>
    // Con `oLoGuardado` y no con `?? ''`: si él vuelve a esta pantalla y
    // guarda con el token de Vercel en blanco, lo de antes tiene que
    // seguir ahí. Blanquearlo dejaría la app sin poder actualizarse sola.
    // RESPALDO_CLAVE va en la lista aunque no tenga nada que ver con
    // Vercel: es un campo editable de este bloque, y era el único que se
    // podía escribir y no se guardaba. Justo el peor — si él pega ahí la
    // clave que tenía apuntada y se descarta en silencio, los respaldos
    // viejos dejan de poder abrirse y nadie se entera hasta que hacen falta.
    await guardar(Object.fromEntries([
      'API_TOKEN', 'CODIGO_ACCESO', 'SECRETO_SESION', 'RESPALDO_CLAVE', 'APP_URL',
      'VERCEL_TOKEN', 'VERCEL_PROYECTO', 'VERCEL_GANCHO',
    ].map((clave) => [clave, oLoGuardado(cuerpo, clave)])))

    return publicarYDesplegar()
  })

  // ── por qué la app dice «sin conexión» ──────────────────────

  app.get('/api/cadena', async () => probarCadena({
    puertoLocal: puertoServicio,
    urlPublica: env.URL_PUBLICA ?? '',
    apiToken: env.API_TOKEN ?? '',
    vercel: {
      token: env.VERCEL_TOKEN ?? '',
      proyecto: env.VERCEL_PROYECTO ?? '',
      gancho: env.VERCEL_GANCHO ?? '',
    },
  }))

  // Reparar es exactamente lo mismo que publicar: volver a contarle a
  // Vercel lo que hay ahora y redesplegar para que lo agarre. Se le da su
  // propio botón porque quien llega aquí no viene a configurar nada —viene
  // de ver la app vacía— y no tiene por qué adivinar que el arreglo está
  // escondido en un formulario tres pasos más arriba.
  app.post('/api/cadena/reparar', async () => publicarYDesplegar())

  app.post('/api/reiniciar', async (_req, res) => {
    res.type('text/html; charset=utf-8')
    // El 7 es la señal para ARRANCAR.cmd: «no te mueras, vuelve a lanzarme».
    // Sin un código aparte, salir para reiniciar y salir por un fallo se
    // verían igual desde fuera, y habría que elegir entre reiniciar siempre
    // —incluso en bucle con algo roto— o no reiniciar nunca.
    setTimeout(() => process.exit(7), 400)
    return volver('Arrancando', 'Vuelvo en unos segundos. No cierres la ventana negra.')
  })

  await app.listen({ port: puerto, host: '127.0.0.1' })

  const r = estado()
  o.registro?.info({ puerto, faltan: r.faltantes }, 'asistente de configuración escuchando')

  return {
    url: raiz,
    estado,
    async cerrar() {
      tunel?.detener()
      await app.close()
    },
  }
}
