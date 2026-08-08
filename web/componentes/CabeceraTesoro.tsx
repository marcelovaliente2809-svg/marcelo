import Link from 'next/link'
import type { ReactNode } from 'react'

/**
 * La cabecera del Tesoro, compartida por la vista del mes y la del año.
 *
 * El título lo pone quien la usa —el mes con sus flechas, o el desplegable de
 * años— porque es lo único que cambia entre las dos. El resto (el ojal, el
 * conmutador, la promesa de que sólo lee) tiene que decir lo mismo siempre.
 *
 * El conmutador son enlaces y no botones: así la página entera sigue siendo
 * server component y el año se puede recargar y compartir.
 */
export function CabeceraTesoro({
  vista,
  children,
}: {
  vista: 'mes' | 'anio'
  children: ReactNode
}) {
  return (
    <div className="cabecera" data-anim>
      <p className="ojal">tesoro</p>

      <div className="cabecera__fila">
        {children}

        <div className="conmutador" role="group" aria-label="Cómo ver el tesoro">
          <Link
            className="conmutador__op" href="/tesoro"
            aria-current={vista === 'mes' ? 'page' : undefined}
          >
            mes
          </Link>
          <Link
            className="conmutador__op" href="/tesoro?vista=anio"
            aria-current={vista === 'anio' ? 'page' : undefined}
          >
            año
          </Link>
        </div>
      </div>

      <p className="subtitular">
        Lo que leyó en tus correos del banco. Sólo lee y anota: nunca mueve plata.
      </p>
    </div>
  )
}
