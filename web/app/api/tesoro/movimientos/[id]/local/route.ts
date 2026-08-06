import { NextResponse } from 'next/server'
import { enviar } from '@/lib/api'
import { haySesion } from '@/lib/sesion'

export async function POST(
  peticion: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!(await haySesion())) {
    return NextResponse.json({ error: 'Sin sesión' }, { status: 401 })
  }

  const { id } = await params
  const cuerpo = await peticion.json().catch(() => null)
  if (!cuerpo || typeof cuerpo.local !== 'string') {
    return NextResponse.json({ error: 'Cuerpo inválido' }, { status: 400 })
  }

  const r = await enviar<unknown>(`/tesoro/movimientos/${encodeURIComponent(id)}/local`, {
    local: cuerpo.local,
  })
  return r.ok
    ? NextResponse.json(r.datos)
    : NextResponse.json({ error: r.error, motivo: r.error }, { status: r.estado ?? 502 })
}
