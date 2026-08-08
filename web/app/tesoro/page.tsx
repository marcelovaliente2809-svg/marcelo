import Link from 'next/link'
import { SinConexion } from '@/componentes/SinConexion'
import { Movimientos } from '@/componentes/Movimientos'
import { CabeceraTesoro } from '@/componentes/CabeceraTesoro'
import { VistaAnio } from '@/componentes/VistaAnio'
import { pedir } from '@/lib/api'
import { exigirSesion } from '@/lib/sesion'
import { diaLegible, mesLegible, pesos, proporcion, vencimiento } from '@/lib/plata'
import { masMeses, mesActual } from '@/lib/tiempo'
import type { Tesoro, TesoroAnual } from '@/lib/tipos'

export const dynamic = 'force-dynamic'

/**
 * El Tesoro: en qué se le va la plata.
 *
 * Lo primero que se ve es el saldo del mes, porque es la única cifra que
 * alguien mira todos los días. Después lo que hay que pagar —lo único
 * accionable de esta pantalla— y sólo entonces el detalle.
 *
 * Nada aquí se inventa. Si la asistente todavía no lleva cuentas, lo dice:
 * un tesoro con cifras de mentira es peor que uno vacío, porque en
 * contabilidad mentir en silencio es la peor forma de fallar.
 */

const ESCUDO = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M12 3 4 6.5v5c0 4.5 3.2 8.4 8 9.5 4.8-1.1 8-5 8-9.5v-5z" /></svg>
)

const sinLibro = (motivo?: string) => (
  <section className="vista">
    <div className="cabecera" data-anim>
      <p className="ojal">tesoro</p>
      <h1 className="titular titular--corto">Aún no lleva tus cuentas</h1>
    </div>
    <div className="bloque">
      <div className="tarjeta vacio" data-anim>
        <strong>El libro contable no está conectado</strong>
        {motivo ?? 'Falta terminar de configurarla.'}
      </div>
    </div>
  </section>
)

export default async function Pagina({
  searchParams,
}: {
  searchParams: Promise<{ mes?: string; vista?: string; anio?: string }>
}) {
  await exigirSesion()
  const { mes, vista, anio } = await searchParams

  if (vista === 'anio') {
    const ra = await pedir<TesoroAnual>(
      anio ? `/tesoro/anio?anio=${encodeURIComponent(anio)}` : '/tesoro/anio')
    if (!ra.ok) return <SinConexion error={ra.error} que="tu tesoro" />
    return ra.datos.disponible
      ? <VistaAnio a={ra.datos} />
      : sinLibro(ra.datos.motivo)
  }

  const r = await pedir<Tesoro>(
    mes ? `/tesoro?mes=${encodeURIComponent(mes)}` : '/tesoro')
  if (!r.ok) return <SinConexion error={r.error} que="tu tesoro" />

  const t = r.datos

  if (!t.disponible) return sinLibro(t.motivo)

  const mayorCategoria = t.porCategoria[0]?.total ?? 0

  // El mes que se está viendo sale de la respuesta, no del query: así el
  // título y las flechas siempre hablan del mismo mes que las cifras.
  const mesVisto = t.desde.slice(0, 7)
  const esMesActual = mesVisto >= mesActual()

  // Lo que está por pagar no tiene mes: es lo que se debe hoy. Enseñarlo
  // mientras se mira marzo diría que aquel marzo se debía esto, que es falso.
  const porPagar = esMesActual ? t.cuentasPorPagar : []
  const hayAlgo = t.movimientos.length > 0 || porPagar.length > 0

  return (
    <section className="vista">
      <CabeceraTesoro vista="mes">
        <div className="mesnav">
          <Link
            className="mesnav__flecha" aria-label="Mes anterior"
            href={`/tesoro?mes=${masMeses(mesVisto, -1)}`}
          >
            ‹
          </Link>
          <h1 className="titular titular--corto">{mesLegible(t.desde)}</h1>
          {esMesActual ? (
            <span className="mesnav__flecha" aria-disabled="true" aria-hidden="true">›</span>
          ) : (
            <Link
              className="mesnav__flecha" aria-label="Mes siguiente"
              href={`/tesoro?mes=${masMeses(mesVisto, 1)}`}
            >
              ›
            </Link>
          )}
        </div>
      </CabeceraTesoro>

      {!hayAlgo ? (
        <div className="bloque">
          <div className="tarjeta vacio" data-anim>
            {esMesActual ? (
              <>
                <strong>Este mes no ha anotado nada todavía</strong>
                Cuando llegue un correo del banco lo va a leer, sacar el monto y
                la contraparte, y anotarlo aquí. Un aviso repetido no cuenta dos
                veces.
              </>
            ) : (
              <>
                <strong>En {mesLegible(t.desde)} no anotó nada</strong>
                Ese mes no le llegó ningún correo del banco. Con las flechas de
                arriba puedes seguir mirando otros meses.
              </>
            )}
          </div>
          <div className="aviso" data-anim style={{ marginTop: 18 }}>
            {ESCUDO}
            <span>
              Sólo lee y anota. Nunca mueve plata ni paga nada por su cuenta:
              riesgo cero por diseño.
            </span>
          </div>
        </div>
      ) : (
        <>
          {/* ── el saldo: la única cifra que se mira a diario ── */}
          <div className="bloque">
            <div className="saldos">
              <article className="tarjeta saldo" data-anim>
                <span className="saldo__rotulo">
                  {esMesActual ? 'te queda este mes' : 'te quedó'}
                </span>
                <p className="saldo__cifra" data-signo={t.neto < 0 ? 'menos' : 'mas'}>
                  {pesos(t.neto)}
                </p>
              </article>
              <div className="saldos__par">
                <article
                  className="tarjeta saldo saldo--chico" data-anim
                  style={{ '--i': 1 } as React.CSSProperties}
                >
                  <span className="saldo__rotulo">entró</span>
                  <p className="saldo__cifra saldo__cifra--chica" data-signo="mas">
                    {pesos(t.ingresos)}
                  </p>
                </article>
                <article
                  className="tarjeta saldo saldo--chico" data-anim
                  style={{ '--i': 2 } as React.CSSProperties}
                >
                  <span className="saldo__rotulo">salió</span>
                  <p className="saldo__cifra saldo__cifra--chica" data-signo="menos">
                    {pesos(t.egresos)}
                  </p>
                </article>
              </div>
            </div>
          </div>

          {/* ── lo único accionable, y por eso va arriba ── */}
          {porPagar.length > 0 && (
            <div className="bloque">
              <div className="seccion">
                <h2 className="seccion__titulo">Por pagar</h2>
                <span className="contador">{porPagar.length}</span>
              </div>
              <div className="pactos">
                {porPagar.map((c, i) => {
                  const v = vencimiento(c.diasRestantes)
                  return (
                    <article
                      key={c.id} className="tarjeta pacto deuda" data-anim
                      data-tono={v.tono || undefined}
                      style={{ '--i': i } as React.CSSProperties}
                    >
                      <div className="deuda__fila">
                        <h3 className="pacto__titulo">{c.acreedor}</h3>
                        <span className="deuda__monto mono">{pesos(c.monto, c.moneda)}</span>
                      </div>
                      <div className="pacto__pie">
                        <span className="etiqueta" data-tono={v.tono || undefined}>
                          {v.texto}
                        </span>
                        <span className="pacto__horario">{diaLegible(c.venceEl)}</span>
                      </div>
                    </article>
                  )
                })}
              </div>
            </div>
          )}

          {/* ── en qué se fue ── */}
          {t.porCategoria.length > 0 && (
            <div className="bloque">
              <div className="seccion">
                <h2 className="seccion__titulo">En qué se fue</h2>
              </div>
              <div className="tarjeta gastos" data-anim>
                {t.porCategoria.map((c, i) => (
                  <div
                    className="gasto" key={c.categoria}
                    style={{ '--i': i } as React.CSSProperties}
                  >
                    <span className="gasto__nombre">{c.nombre}</span>
                    <span className="gasto__cifra mono">{pesos(c.total)}</span>
                    <span
                      className="gasto__barra"
                      style={{ '--parte': proporcion(c.total, mayorCategoria) } as React.CSSProperties}
                      aria-hidden="true"
                    />
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── cobros que parecen de más ── */}
          {t.sospechas.length > 0 && (
            <div className="bloque">
              <div className="aviso aviso--lumen" data-anim>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M12 8.5v4.5M12 16.5h.01" /><path d="M10.3 3.9 2.6 17.4A1.9 1.9 0 0 0 4.3 20.3h15.4a1.9 1.9 0 0 0 1.7-2.9L13.7 3.9a1.9 1.9 0 0 0-3.4 0z" /></svg>
                <span>
                  {t.sospechas.map((s) => (
                    <span key={`${s.contraparte}-${s.monto}`} className="sospecha">
                      <strong>{s.contraparte}</strong> te cobró {pesos(s.monto)} {s.veces} veces
                      este mes.
                    </span>
                  ))}
                </span>
              </div>
            </div>
          )}

          {/* ── el detalle ── */}
          {t.movimientos.length > 0 && (
            <div className="bloque">
              <div className="seccion">
                <h2 className="seccion__titulo">Movimientos</h2>
                <span className="contador">{t.movimientos.length}</span>
              </div>
              <Movimientos movimientos={t.movimientos} />
            </div>
          )}

          <p className="pie" data-anim>
            Todo esto salió de tus correos. Un aviso reenviado no cuenta dos
            veces: cada movimiento lleva una huella hecha con la fecha, el monto
            y a quién se le pagó, y esa huella sólo puede existir una vez.
          </p>
        </>
      )}
    </section>
  )
}
