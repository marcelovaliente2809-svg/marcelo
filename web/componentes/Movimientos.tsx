'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useApp } from './contexto'
import { diaLegible, pesos } from '@/lib/plata'
import type { Movimiento } from '@/lib/tipos'

/**
 * La lista de movimientos, con edición del nombre del local.
 *
 * `contraparte` es lo que dijo el correo del banco — a veces una cuenta
 * comercial («UNIMEDE4») que no dice nada de en qué se gastó. `local` es lo
 * que Marcelo pone a mano cuando eso pasa: se ve más chico, debajo, porque
 * la contraparte sigue siendo el dato de verdad y el local es una
 * aclaración suya, no algo que la asistente dedujo.
 */

const LAPIZ = (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
  </svg>
)

function Fila({ m, i }: { m: Movimiento; i: number }) {
  const router = useRouter()
  const { tostar } = useApp()
  const [editando, setEditando] = useState(false)
  const [valor, setValor] = useState(m.local ?? '')
  const [guardando, setGuardando] = useState(false)

  function alternar() {
    setValor(m.local ?? '')
    setEditando((v) => !v)
  }

  async function guardar(e: React.FormEvent) {
    e.preventDefault()
    if (guardando) return
    setGuardando(true)
    try {
      const r = await fetch(`/api/tesoro/movimientos/${m.id}/local`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ local: valor.trim() }),
      })
      if (!r.ok) {
        const c = (await r.json().catch(() => ({}))) as { error?: string }
        tostar(c.error ?? 'No se pudo guardar')
        return
      }
      setEditando(false)
      tostar(valor.trim() ? 'Local guardado' : 'Local borrado')
      router.refresh()
    } catch {
      tostar('No se pudo llegar a la asistente')
    } finally {
      setGuardando(false)
    }
  }

  return (
    <article
      className="tarjeta movimiento" data-anim data-tipo={m.tipo}
      style={{ '--i': Math.min(i, 12) } as React.CSSProperties}
    >
      <div className="movimiento__cuerpo">
        <div className="movimiento__nombre">
          <h3 className="movimiento__quien">{m.contraparte}</h3>
          <button
            type="button" className="movimiento__editar" aria-expanded={editando}
            aria-label={editando ? 'Cancelar' : 'Ponerle nombre al local'}
            onClick={alternar}
          >
            {LAPIZ}
          </button>
        </div>
        {m.local && !editando && <span className="movimiento__local">{m.local}</span>}
        <span className="movimiento__meta">
          {diaLegible(m.fecha)}
          {m.concepto ? ` · ${m.concepto}` : ''}
        </span>
        {editando && (
          <form className="movimiento__forma" onSubmit={guardar}>
            <input
              className="movimiento__campo" value={valor} autoFocus
              onChange={(e) => setValor(e.target.value)}
              placeholder="¿Cuál es el local de verdad? p. ej. Dollar City"
              maxLength={120} autoComplete="off"
            />
            <button className="btn btn--principal" type="submit" disabled={guardando}>
              {guardando ? 'Guardando…' : 'Guardar'}
            </button>
          </form>
        )}
      </div>
      <div className="movimiento__cifras">
        <span className="movimiento__monto mono">
          {m.tipo === 'ingreso' ? '+' : '−'}{pesos(m.monto, m.moneda)}
        </span>
        {m.moneda !== 'COP' && (
          <span className="movimiento__nota">sin convertir</span>
        )}
      </div>
    </article>
  )
}

export function Movimientos({ movimientos }: { movimientos: Movimiento[] }) {
  return (
    <div className="movimientos">
      {movimientos.map((m, i) => <Fila key={m.id} m={m} i={i} />)}
    </div>
  )
}
