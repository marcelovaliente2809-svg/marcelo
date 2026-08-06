import type { Config } from './config.ts'
import { createHmac } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import cron from 'node-cron'
import pino from 'pino'
import { fuentesConfiguradas } from './config.ts'
import { crearPoolPostgres, desdePostgres } from './db/base-datos.ts'
import { migrar } from './db/migrar.ts'
import { RelojReal } from './puertos/reloj.ts'
import { crearClienteGoogle } from './adaptadores/google-auth.ts'
import { FuenteGmail } from './adaptadores/gmail.ts'
import { FuenteOutlook } from './adaptadores/outlook.ts'
import { CalendarioGoogle } from './adaptadores/google-calendar.ts'
import { CalendarioSombra } from './adaptadores/calendario-sombra.ts'
import { ProveedorGroq } from './adaptadores/groq.ts'
import { ErrorLLM } from './puertos/proveedor-llm.ts'
import { CorreoInalcanzable } from './dominio/tipos.ts'
import { TranscriptorGroq } from './adaptadores/groq-whisper.ts'
import { crearRepoCompromisos } from './repos/compromisos.ts'
import { crearRepoCorreos, crearRepoCuentas } from './repos/correos.ts'
import { crearRepoAcciones } from './repos/acciones.ts'
import { crearRepoCola } from './repos/cola.ts'
import { crearRepoIntenciones } from './repos/intenciones.ts'
import { crearRepoReglas } from './repos/reglas.ts'
import { crearRepoCuentasPorPagar, crearRepoMovimientos } from './repos/movimientos.ts'
import { crearExtractorFinanzas } from './pipeline/extractor-finanzas.ts'
import { crearServicioTesoro } from './servicios/tesoro.ts'
import { crearServicioPropuestas } from './servicios/propuestas.ts'
import { crearServicioAcceso } from './servicios/acceso.ts'
import { crearInterprete } from './pipeline/interprete.ts'
import { crearServicioJornada } from './servicios/jornada.ts'
import { crearServicioCronica } from './servicios/cronica.ts'
import { crearServicioAgenda } from './servicios/agendar.ts'
import { crearServicioDeshacer } from './servicios/deshacer.ts'
import { crearServicioInstruccion } from './servicios/instruccion.ts'
import { crearServicioResumen } from './servicios/resumen.ts'
import { crearServicioConversacion } from './servicios/conversacion.ts'
import { crearServicioAMano } from './servicios/a-mano.ts'
import { redondearDuracion } from './dominio/intenciones.ts'
import { crearCanalTelegram } from './adaptadores/telegram.ts'
import { crearEnlacePublico } from './configuracion/enlace.ts'
import { probarCadena } from './configuracion/cadena.ts'
import { arrancarConfigurador } from './configuracion/servidor.ts'
import { crearServicioRespaldo, volcarConComando } from './servicios/respaldo.ts'
import { escribirEnv } from './configuracion/archivo-env.ts'
import { crearClasificador } from './pipeline/clasificador.ts'
import { crearExtractor } from './pipeline/extractor.ts'
import { crearDesempate } from './pipeline/desempate.ts'
import { crearProcesador } from './pipeline/procesar-correo.ts'
import { crearSincronizacion, type CuentaConectada } from './servicios/sincronizacion.ts'
import { crearServidor } from './http/servidor.ts'
import type { SumideroCalendario } from './puertos/sumidero-calendario.ts'


/**
 * Arrancar la asistente de verdad.
 *
 * Vive aparte de `index.ts` desde que existe el asistente de configuracion:
 * el arranque tiene dos caminos —configurar o trabajar— y meterlos en el
 * mismo modulo obligaria a ejecutar todo esto para descubrir que falta un
 * token.
 */
export async function arrancarAsistente(config: Config): Promise<void> {
  const log = pino({ level: config.nivelLog })

  // ── La guía, ANTES que nada ───────────────────────────────────
  //
  // Va primero a propósito. Es la herramienta con la que se arregla una
  // configuración rota, así que no puede esperar detrás de lo que está
  // roto: si el modelo no existe y hay cien correos atascados, abrir
  // localhost:3210 y encontrar que nadie escucha es justo el momento en
  // que alguien se rinde.
  //
  // No necesita ni base de datos ni credenciales: sólo el .env.
  try {
    const guia = await arrancarConfigurador({ registro: log, rutaEnv: config.rutaEnv })
    log.info({ url: guia.url }, 'asistente de configuración disponible')
  } catch (e) {
    log.warn({ err: e }, 'no se pudo abrir el asistente de configuración')
  }

  const db = desdePostgres(crearPoolPostgres(config.urlBaseDatos))
  await migrar(db)

  const fuentes = fuentesConfiguradas(config)
  if (fuentes.length === 0) {
    log.error('No hay ninguna fuente de correo configurada. Revisa el .env.')
    process.exit(1)
  }

  // ── Calendario ────────────────────────────────────────────────
  // El modo sombra se activa envolviendo el sumidero, no con una bandera
  // aparte: así es imposible que el pipeline crea que ensaya mientras
  // escribe de verdad.
  const auth = crearClienteGoogle(
    config.google.clientId, config.google.clientSecret, config.google.refreshToken)

  const calendarioReal = new CalendarioGoogle(auth, config.zonaHoraria)
  const calendario: SumideroCalendario = config.modoSombra
    ? new CalendarioSombra(calendarioReal)
    : calendarioReal

  // ── Cuentas de correo ─────────────────────────────────────────
  const repoCuentas = crearRepoCuentas(db)
  const conectadas: CuentaConectada[] = []

  if (fuentes.includes('gmail')) {
    const cuenta = await repoCuentas.registrar('gmail', 'gmail')
    const gmail = new FuenteGmail(auth, cuenta.id)
    conectadas.push({
      cuentaId: cuenta.id, proveedor: 'gmail',
      fuente: {
        idsDesde: (c) => gmail.idsDesde(c),
        mensajeCompleto: (id) => gmail.mensajeCompleto(id),
        arrancarDesdeCero: () => gmail.idsRecientes(),
      },
    })
  }

  if (fuentes.includes('outlook')) {
    const cuenta = await repoCuentas.registrar('outlook', 'outlook')
    const outlook = new FuenteOutlook(config.microsoft, cuenta.id)
    conectadas.push({
      cuentaId: cuenta.id, proveedor: 'outlook',
      fuente: {
        idsDesde: (c) => outlook.idsDesde(c),
        mensajeCompleto: (id) => outlook.mensajeCompleto(id),
        arrancarDesdeCero: () => outlook.iniciarDelta(),
      },
    })
  }

  // ── Pipeline ──────────────────────────────────────────────────
  const llm = new ProveedorGroq(config.groq.apiKey, config.groq.baseUrl)
  const cola = crearRepoCola(db)
  const reloj = new RelojReal(config.zonaHoraria)

  // Uno solo para los dos canales: la app y Telegram oyen con el mismo oído.
  // El oído puede venir de otro proveedor que el cerebro: hay servicios
  // buenísimos leyendo que no transcriben, y Groq da Whisper grande gratis.
  const transcriptor = config.voz.modelo
    ? new TranscriptorGroq(
        config.voz.apiKey, config.voz.baseUrl, config.voz.modelo, config.ffmpeg)
    : undefined

  const repoCompromisos = crearRepoCompromisos(db)
  const repoAcciones = crearRepoAcciones(db)
  const repoIntenciones = crearRepoIntenciones(db)
  const repoReglas = crearRepoReglas(db)

  // Las reglas que él dicta ("de Bancolombia no me avises") viven en la base y
  // se releen en cada tanda: el procesador lee estos arreglos en cada correo,
  // así que actualizarlos en sitio hace que una regla nueva valga sin
  // reiniciar el servicio.
  const remitentesIgnorados: string[] = []
  const remitentesSilenciados: string[] = []

  async function recargarReglas(): Promise<void> {
    const [ignorar, silenciar] = await Promise.all([
      repoReglas.porTipo('ignorar_remitente'),
      repoReglas.porTipo('silenciar_remitente'),
    ])
    remitentesIgnorados.splice(0, remitentesIgnorados.length, ...ignorar)
    remitentesSilenciados.splice(0, remitentesSilenciados.length, ...silenciar)
  }

  // ── El libro contable ─────────────────────────────────────────
  // Registrar es lectura: no hay ningún camino por el que pueda pagar,
  // transferir ni autorizar nada. Riesgo cero por diseño.
  const tesoro = crearServicioTesoro({
    reloj,
    repoMovimientos: crearRepoMovimientos(db),
    repoCuentas: crearRepoCuentasPorPagar(db),
  })

  const procesador = crearProcesador({
    reloj,
    repoCompromisos,
    repoCorreos: crearRepoCorreos(db),
    repoAcciones,
    clasificador: crearClasificador(llm, config.groq.modeloClasificador),
    extractor: crearExtractor(llm, config.groq.modeloExtractor),
    desempate: crearDesempate(llm, config.groq.modeloExtractor),
    calendario,
    remitentesIgnorados,
    remitentesSilenciados,
    extractorFinanzas: crearExtractorFinanzas(llm, config.groq.modeloExtractor),
    tesoro,
  })

  const sync = crearSincronizacion(db, cola)
  const porCuenta = new Map(conectadas.map((c) => [c.cuentaId, c]))

  // ── El canal de control ───────────────────────────────────────
  // Se arma antes de drenar la cola porque el pipeline ya puede tener algo
  // que avisar en la primera tanda, y porque el bot se construye en dos
  // tiempos: primero por dónde hablar, y al final con qué contestar.
  const cronica = crearServicioCronica(db, config.zonaHoraria)

  const canal = config.telegram.token
    ? crearCanalTelegram({
        token: config.telegram.token,
        chatId: config.telegram.chatId,
        registro: log,
      })
    : null

  const resumen = canal
    ? crearServicioResumen({
        reloj, cronica, notificador: canal.notificador, urlApp: config.urlApp, tesoro,
      })
    : null

  async function drenarCola(): Promise<void> {
    // Sin cerebro no hay con qué entender un correo. Se deja la cola
    // QUIETA en vez de vaciarla: los correos siguen ahí, y el día que se
    // configure un modelo se procesan. Sacarlos y descartarlos sería
    // perderlos por no tener algo que es opcional.
    if (!config.hayCerebro) return

    await recargarReglas()
    for (const item of await cola.tomarPendientes(10)) {
      const cuenta = porCuenta.get(item.cuentaId)
      if (!cuenta) {
        await cola.marcarError(item.id, 'La cuenta ya no está conectada')
        continue
      }
      try {
        const correo = await cuenta.fuente.mensajeCompleto(item.messageId)
        const r = await procesador.procesar(correo, cuenta.proveedor)
        log.info({ messageId: item.messageId, proveedor: cuenta.proveedor, ...r },
          'correo procesado')

        // La otra mitad de la política: lo que decidió «actuar y avisar»
        // sale ahora mismo, y lo que decidió «actuar callada» espera al
        // resumen de las 21:00. Que el aviso falle no puede desandar lo
        // que ya se hizo ni dejar el correo sin marcar.
        if (resumen && r.decision === 'actuar_y_avisar' && r.accionId !== null) {
          await resumen.avisar(r.accionId)
            .catch((e) => log.error({ err: e, accionId: r.accionId }, 'no se pudo avisar'))
        }

        await cola.marcarListo(item.id)
      } catch (e) {
        // Sin cuota no es un fallo del correo: es el proveedor diciendo
        // «ahora no». Seguir con los otros nueve sólo consigue nueve
        // rechazos más y quemar lo que quede del cupo, así que se corta la
        // tanda y se vuelve en el siguiente minuto. El correo se queda sin
        // marcar, y por eso no se pierde.
        if (e instanceof ErrorLLM && e.causa === 'cuota') {
          log.warn({ messageId: item.messageId, esperar: e.esperar },
            'sin cuota en el proveedor: dejo la tanda para el próximo minuto')
          return
        }

        // Un correo que ya no está no se arregla insistiendo: da el mismo
        // 404 las tres veces. Se anota en una línea y se cierra, en vez de
        // tres trazas de Google por cada uno. Con 22 encolados de una
        // cuenta vieja, eso era una pantalla de rojo que no significaba
        // nada y tapaba los errores de verdad.
        if (e instanceof CorreoInalcanzable) {
          log.info({ messageId: item.messageId, proveedor: cuenta.proveedor },
            'ese correo ya no está en el buzón: lo doy por cerrado')
          await cola.marcarError(item.id, e.message, true)
          continue
        }

        log.error({ err: e, messageId: item.messageId }, 'fallo procesando')

        // Un modelo que no existe o una clave mala tampoco son culpa del
        // correo, y no se arreglan reintentando. Se corta igual, pero
        // gritando: esto necesita que alguien toque la configuración.
        if (e instanceof ErrorLLM && (e.causa === 'modelo' || e.causa === 'clave')) {
          log.error({ causa: e.causa },
            'HAY QUE ARREGLAR LA CONFIGURACIÓN: abre el asistente, bloque «El cerebro»')
          return
        }

        await cola.marcarError(item.id, String(e))
      }
    }
  }

  async function ponerseAlDiaTodas(): Promise<void> {
    // Sin cerebro no se avanza el cursor. Si se avanzara, los correos de
    // hoy quedarian por vistos sin que nadie los haya leido, y no habria
    // forma de recuperarlos cuando se configure un modelo.
    if (!config.hayCerebro) return

    for (const cuenta of conectadas) {
      try {
        const n = await sync.ponerseAlDia(cuenta)
        if (n > 0) log.info({ proveedor: cuenta.proveedor, encolados: n }, 'puesta al día')
        await sync.latido(cuenta.cuentaId)
      } catch (e) {
        log.error({ err: e, proveedor: cuenta.proveedor }, 'fallo sincronizando')
      }
    }
  }

  // Recuperación al arrancar: la laptop pudo estar apagada.
  //
  // Sin `await`: cien correos atrasados tardan minutos, y esperarlos aquí
  // dejaba la API y la guía sin levantar todo ese rato. Nada se pierde por
  // hacerlo de fondo — la cola vive en Postgres y el cron de cada minuto
  // recoge lo que quede.
  void ponerseAlDiaTodas()
    .then(() => drenarCola())
    .catch((e) => log.error({ err: e }, 'fallo en la puesta al día del arranque'))

  // ── Lo que consume la app ─────────────────────────────────────
  const jornada = crearServicioJornada({
    reloj,
    calendario,
    repoAcciones,
    calendarId: config.google.calendarId,
    desde: config.jornada.desde,
    hasta: config.jornada.hasta,
  })

  const deshacer = crearServicioDeshacer(repoAcciones, calendario, repoIntenciones)

  // Ver el hueco y ver lo que cabe en el es la misma operacion.
  const propuestas = crearServicioPropuestas({ reloj, jornada, repoIntenciones })
  const agenda = crearServicioAgenda({
    reloj, calendario, repoAcciones, repoIntenciones,
    calendarId: config.google.calendarId,
  })

  // El canal de instrucciones: el LLM entiende, y de ahí en adelante decide y
  // actúa el mismo código que atiende los correos.
  const instruccion = crearServicioInstruccion({
    reloj,
    interprete: crearInterprete(llm, config.groq.modeloExtractor),
    desempate: crearDesempate(llm, config.groq.modeloExtractor),
    calendario,
    repoCompromisos,
    repoAcciones,
    repoIntenciones,
    repoReglas,
    jornada,
    deshacer,
    calendarId: config.google.calendarId,
    tesoro,
  })

  // Telegram y la app son dos entradas del mismo intérprete: lo único que
  // cambia es por dónde vuelve la respuesta.
  /**
   * Todo lo que se puede hacer sin que nadie tenga que entender nada.
   *
   * Mismo actuador, misma inversa antes de aplicar, misma auditoría. Lo
   * único que se salta es la parte de interpretar, porque cuando él escribe
   * «/clase martes 10:00 12:00 Laboratorio» no queda nada que adivinar.
   */
  const aMano = crearServicioAMano({
    reloj, calendario, repoCompromisos, repoAcciones,
    calendarId: config.google.calendarId,
  })

  canal?.conectar(crearServicioConversacion({
    instruccion, deshacer, transcriptor, resumen: resumen ?? undefined,
    propuestas, agenda, aMano,
    // Apuntar algo no necesita ningún modelo, y es lo que más se hace.
    intenciones: {
      // La duración cae a una de las cuatro casillas que la bandeja
      // conoce: quien escribe «45m» quiere decir «como media hora», no
      // que le rechacen la nota por no saberse el catálogo.
      crear: (i) => repoIntenciones.crear({
        ...i, detalle: null, prioridad: 'normal', venceEl: null,
        duracionMin: redondearDuracion(i.duracionMin),
      }),
    },
    // Cuál es la dirección de AHORA: la pregunta que no se puede contestar
    // desde la app justo cuando la app no funciona.
    enlacePublico: () => enlace?.url() ?? config.tunel.url,
    // Por Telegram y no por la app, a propósito: es el único canal que
    // sigue en pie justo cuando la app es la que no funciona.
    revisarCadena: () => probarCadena({
      puertoLocal: config.puerto,
      urlPublica: enlace?.url() ?? config.tunel.url,
      apiToken: config.api.token,
      vercel: config.vercel,
    }),
    canal: 'telegram',
  }))

  const app = crearServidor({
    db,
    modoSombra: config.modoSombra,
    alRecibirAviso: async () => { await ponerseAlDiaTodas(); await drenarCola() },
    api: {
      token: config.api.token,
      db,
      reloj,
      modoSombra: config.modoSombra,
      jornada,
      cronica,
      agenda: crearServicioAgenda({
        reloj, calendario, repoAcciones, repoIntenciones,
        calendarId: config.google.calendarId,
      }),
      deshacer,
      instruccion,
      transcriptor,
      // Derivado del token de servicio: no hace falta otro secreto que
      // alguien tenga que acordarse de poner.
      secretoVoz: createHmac('sha256', config.api.token || 'sin-token')
        .update('firma-de-voz').digest('hex'),
      repoIntenciones,
      repoCompromisos,
      repoAcciones,
      tesoro,
      propuestas,
      acceso: canal ? crearServicioAcceso({ notificador: canal.notificador }) : undefined,
      aMano,
    },
  })

  if (!config.api.token) {
    log.warn('API_TOKEN vacío: la app no podrá conectarse hasta que lo configures')
  }
  if (!canal) {
    log.warn('TELEGRAM_BOT_TOKEN vacío: sin canal de Telegram y sin resumen diario')
  } else if (!config.telegram.chatId) {
    log.warn('TELEGRAM_CHAT_ID vacío: escríbele al bot y te dirá qué número poner')
  }

  cron.schedule('* * * * *', () => { void drenarCola() })
  // Red de seguridad: si el push falla en silencio, esto lo recoge igual.
  // Sin GMAIL_TOPICO_PUBSUB configurado, este es el único camino por el que
  // se entera de correo nuevo, así que un minuto es el piso real de cron
  // (no hay forma de bajar de eso sin dejar de ser un sondeo).
  cron.schedule('* * * * *', () => { void ponerseAlDiaTodas() })

  // El resumen de las 21:00, en hora de Bogotá. Si no hizo nada, no manda
  // nada: una asistente que escribe a diario «hoy no pasó nada» se vuelve
  // ruido en una semana.
  if (resumen) {
    cron.schedule('0 21 * * *', () => {
      void resumen.enviar()
        .then((r) => log.info({ enviado: r.enviado }, 'resumen diario'))
        .catch((e) => log.error({ err: e }, 'no se pudo mandar el resumen'))
    }, { timezone: config.zonaHoraria })
  }

    // ── El respaldo de cada noche ─────────────────────────────────
  // El volumen de Docker aguanta apagones; no aguanta que se muera el
  // disco. Este es el único seguro contra eso, y por eso sale de la
  // laptop: uno que se queda dentro no es un respaldo.
  const respaldo = config.respaldo.clave
    ? crearServicioRespaldo({
        reloj,
        volcar: volcarConComando(config.respaldo.comando, config.urlBaseDatos),
        clave: config.respaldo.clave,
        carpeta: config.respaldo.carpeta,
        retenerDias: config.respaldo.dias,
        enviar: canal?.enviarArchivo,
        registro: log,
      })
    : null

  if (!respaldo) {
    log.warn('RESPALDO_CLAVE vacío: sin respaldo nocturno. Si se muere el disco, se pierde todo')
  } else {
    // A las 3:40, después de renovar el watch y lejos de la hora en que
    // llega correo.
    cron.schedule('40 3 * * *', () => {
      void respaldo.hacer()
        .then((r) => log.info(
          { archivo: r.archivo, bytes: r.bytes, fuera: r.fuera, motivo: r.motivo },
          r.ok ? 'respaldo hecho' : 'respaldo fallido'))
        .catch((e) => log.error({ err: e }, 'FALLÓ EL RESPALDO DE ESTA NOCHE'))
    }, { timezone: config.zonaHoraria })
  }

// El watch de Gmail caduca a los 7 días y la suscripción de Graph a los 3.
  // Si esto falla, el sistema deja de recibir avisos SIN dar ningún error.
  cron.schedule('0 3 * * *', () => {
    if (!config.google.topicoPubsub) return
    const gmail = conectadas.find((c) => c.proveedor === 'gmail')
    if (!gmail) return
    void new FuenteGmail(auth, gmail.cuentaId)
      .renovarWatch(config.google.topicoPubsub)
      .then((r) => sync.guardarCursor(gmail.cuentaId, r.cursor))
      .then(() => log.info('watch de Gmail renovado'))
      .catch((e) => log.error({ err: e }, 'NO SE PUDO RENOVAR EL WATCH DE GMAIL'))
  }, { timezone: config.zonaHoraria })

  await app.listen({ port: config.puerto, host: '0.0.0.0' })

  // Long polling: sale a preguntar en vez de esperar a que le toquen, que es
  // lo único que funciona sin IP pública.
  canal?.arrancar()

  // ── El enlace con la app ──────────────────────────────────────
  // Se rehace al arrancar porque el túnel gratuito estrena dirección cada
  // vez, y sin esto cada apagón dejaría la app llamando a un sitio muerto
  // hasta que alguien lo arreglara a mano.
  const enlace = config.tunel.auto
    ? crearEnlacePublico({
        puertoLocal: config.puerto,
        urlConocida: config.tunel.url,
        nombre: config.tunel.nombre,
        ejecutable: config.tunel.ejecutable,
        vercel: config.vercel,
        registro: log,
        guardar: (url) => escribirEnv(resolve(config.rutaEnv), { URL_PUBLICA: url }, {
          existe: existsSync,
          leer: (r) => readFile(r, 'utf8'),
          escribir: (r, t) => writeFile(r, t, 'utf8'),
          respaldar: (r, destino) => copyFile(r, destino),
        }),
      })
    : null

  if (enlace) {
    try {
      const r = await enlace.encender()
      log.info({ url: r.url, cambio: r.cambio, publicado: r.publicado, motivo: r.motivo },
        r.cambio
          ? 'dirección pública nueva'
          : 'dirección pública sin cambios: no hace falta redesplegar')
      if (r.cambio && !r.publicado) {
        log.warn({ motivo: r.motivo },
          'LA APP SIGUE APUNTANDO A LA DIRECCIÓN VIEJA: no responderá hasta arreglarlo')
      }
    } catch (e) {
      // Sin túnel, la asistente sigue trabajando: lee correo, mueve la
      // agenda y contesta por Telegram. Lo único que se pierde es la app.
      log.error({ err: e }, 'no se pudo abrir el túnel; la app no podrá llegar')
    }
  }

  // Sin `allSettled` esto se cuelga: con `canal` en null, el encadenamiento
  // opcional se lleva por delante también el `.finally`, y nadie sale nunca.
  for (const señal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(señal, () => {
      log.info({ señal }, 'cerrando')
      enlace?.detener()
      void Promise.allSettled([canal?.detener(), app.close()])
        .finally(() => process.exit(0))
    })
  }

  log.info(
    { puerto: config.puerto, modoSombra: config.modoSombra, fuentes },
    config.modoSombra
      ? 'Asistente arriba EN MODO SOMBRA: observa y registra, no toca el calendario'
      : 'Asistente arriba EN MODO REAL: va a modificar el calendario')

  if (!config.hayCerebro) {
    log.warn(
      "SIN CEREBRO: no voy a leer correos ni a entender lo que me digan. "
      + "La agenda, la bandeja, los pactos y el libro funcionan igual, a mano. "
      + "Los correos se quedan en la cola hasta que configures un modelo.")
  }
}
