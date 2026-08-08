import { CabeceraTesoro } from './CabeceraTesoro'
import { SelectorAnio } from './SelectorAnio'
import { mesCorto, pesos, proporcion } from '@/lib/plata'
import type { TesoroAnual } from '@/lib/tipos'

/**
 * El año entero, para comparar meses de un vistazo.
 *
 * Cuatro bloques y en este orden: primero el total —la cifra que se busca al
 * abrir—, después la forma del año, después los números exactos, y sólo al
 * final en qué se fue. Es la misma escalera que la vista del mes: lo que se
 * mira a diario arriba, el detalle abajo.
 *
 * Las barras son verde y rojo porque aquí eso es polaridad, no identidad: una
 * es lo que entró y otra lo que salió. El violeta de la asistente no aparece,
 * que es la regla que ordena toda la paleta.
 */
/** Un mes en cero no es ni bueno ni malo: se queda sin color. */
const signo = (neto: number): 'mas' | 'menos' | undefined =>
  neto === 0 ? undefined : neto < 0 ? 'menos' : 'mas'

export function VistaAnio({ a }: { a: TesoroAnual }) {
  // Una sola escala para las dos series: con dos ejes las alturas dejarían de
  // ser comparables, que es lo único que este gráfico tiene que hacer bien.
  const mayor = Math.max(0, ...a.meses.flatMap((m) => [m.ingresos, m.egresos]))
  const alto = (valor: number) => (mayor > 0 ? valor / mayor : 0)

  const mayorCategoria = a.porCategoria[0]?.total ?? 0
  const hayAlgo = a.ingresos > 0 || a.egresos > 0

  return (
    <section className="vista">
      <CabeceraTesoro vista="anio">
        <SelectorAnio anio={a.anio} anios={a.anios} />
      </CabeceraTesoro>

      {!hayAlgo ? (
        <div className="bloque">
          <div className="tarjeta vacio" data-anim>
            <strong>En {a.anio} no hay nada anotado</strong>
            Ese año no le llegó ningún correo del banco, o todavía no estaba
            leyéndolos. Prueba con otro año.
          </div>
        </div>
      ) : (
        <>
          {/* ── el total del año ── */}
          <div className="bloque">
            <div className="saldos">
              <article className="tarjeta saldo" data-anim>
                <span className="saldo__rotulo">te quedó en {a.anio}</span>
                <p className="saldo__cifra" data-signo={a.neto < 0 ? 'menos' : 'mas'}>
                  {pesos(a.neto)}
                </p>
              </article>
              <div className="saldos__par">
                <article
                  className="tarjeta saldo saldo--chico" data-anim
                  style={{ '--i': 1 } as React.CSSProperties}
                >
                  <span className="saldo__rotulo">entró</span>
                  <p className="saldo__cifra saldo__cifra--chica" data-signo="mas">
                    {pesos(a.ingresos)}
                  </p>
                </article>
                <article
                  className="tarjeta saldo saldo--chico" data-anim
                  style={{ '--i': 2 } as React.CSSProperties}
                >
                  <span className="saldo__rotulo">salió</span>
                  <p className="saldo__cifra saldo__cifra--chica" data-signo="menos">
                    {pesos(a.egresos)}
                  </p>
                </article>
              </div>
            </div>
          </div>

          {/* ── la forma del año ── */}
          <div className="bloque">
            <div className="seccion">
              <h2 className="seccion__titulo">El año mes a mes</h2>
            </div>
            <div className="tarjeta anual__grafico" data-anim>
              <div className="anual__leyenda">
                <span className="anual__clave">
                  <i data-serie="entro" aria-hidden="true" />entró
                </span>
                <span className="anual__clave">
                  <i data-serie="salio" aria-hidden="true" />salió
                </span>
              </div>

              <div className="anual__barras">
                {a.meses.map((m) => (
                  <div className="anual__mes" key={m.mes}>
                    <div className="anual__par">
                      <span
                        className="anual__barra" data-serie="entro"
                        style={{ '--parte': alto(m.ingresos) } as React.CSSProperties}
                        title={`${mesCorto(m.mes)}: entró ${pesos(m.ingresos)}`}
                      />
                      <span
                        className="anual__barra" data-serie="salio"
                        style={{ '--parte': alto(m.egresos) } as React.CSSProperties}
                        title={`${mesCorto(m.mes)}: salió ${pesos(m.egresos)}`}
                      />
                    </div>
                    <span className="anual__eje">{mesCorto(m.mes)}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* ── los números exactos, que el gráfico no da ── */}
          <div className="bloque">
            <div className="seccion">
              <h2 className="seccion__titulo">Mes a mes, en números</h2>
            </div>
            <div className="tarjeta anual__caja" data-anim>
              <table className="anual__tabla">
                <thead>
                  <tr>
                    <th scope="col">Mes</th>
                    <th scope="col">Ingresos</th>
                    <th scope="col">Gastos</th>
                    <th scope="col">Balance</th>
                  </tr>
                </thead>
                <tbody>
                  {a.meses.map((m) => (
                    <tr key={m.mes}>
                      <th scope="row">{mesCorto(m.mes)}</th>
                      <td className="mono">{pesos(m.ingresos)}</td>
                      <td className="mono">{pesos(m.egresos)}</td>
                      <td className="mono" data-signo={signo(m.neto)}>
                        {pesos(m.neto)}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <th scope="row">Total</th>
                    <td className="mono">{pesos(a.ingresos)}</td>
                    <td className="mono">{pesos(a.egresos)}</td>
                    <td className="mono" data-signo={signo(a.neto)}>
                      {pesos(a.neto)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>

          {/* ── en qué se fue, el año entero ── */}
          {a.porCategoria.length > 0 && (
            <div className="bloque">
              <div className="seccion">
                <h2 className="seccion__titulo">En qué se fue</h2>
              </div>
              <div className="tarjeta gastos" data-anim>
                {a.porCategoria.map((c, i) => (
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

          <p className="pie" data-anim>
            Los totales del año los suma la base de datos, no la lista de la
            pantalla: por muchos movimientos que haya, ninguno se queda fuera de
            la cuenta.
          </p>
        </>
      )}
    </section>
  )
}
