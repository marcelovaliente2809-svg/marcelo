'use client'

import { useRouter } from 'next/navigation'

/**
 * El año, elegido donde iría el título.
 *
 * Es lo único de la vista anual que necesita cliente: cambiar de año es
 * navegar, y un `<select>` no navega solo.
 *
 * Sólo se ofrecen los años que tienen algo anotado. Ofrecer un año vacío es
 * prometer datos que no existen, y quien lo elija va a pensar que se perdieron.
 */
export function SelectorAnio({ anio, anios }: { anio: number; anios: number[] }) {
  const router = useRouter()

  // El año que se está viendo va siempre, aunque no tenga nada: si no, el
  // desplegable no diría dónde estás parado.
  const opciones = anios.includes(anio) ? anios : [anio, ...anios].sort((a, b) => b - a)

  return (
    <div className="anual__anio">
      <select
        className="anual__selector"
        value={anio}
        aria-label="Año"
        onChange={(e) => router.push(`/tesoro?vista=anio&anio=${e.target.value}`)}
      >
        {opciones.map((a) => <option key={a} value={a}>{a}</option>)}
      </select>
    </div>
  )
}
