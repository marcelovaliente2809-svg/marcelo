import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { migrar } from '../src/db/migrar.ts'
import { crearBaseDePrueba } from './ayuda/db.ts'
import { crearRepoCuentasPorPagar, crearRepoMovimientos } from '../src/repos/movimientos.ts'
import { crearServicioTesoro } from '../src/servicios/tesoro.ts'
import { RelojFalso } from '../src/puertos/reloj.ts'
import type { BaseDatos } from '../src/db/base-datos.ts'
import type { CorreoCrudo } from '../src/dominio/tipos.ts'
import type { HechoFinanzas } from '../src/pipeline/extractor-finanzas.ts'

let db: BaseDatos

// viernes 7 de agosto de 2026, 10:00 am en Bogotá
const reloj = new RelojFalso('2026-08-07T10:00:00')

const correo: CorreoCrudo = {
  cuentaId: 1, messageId: 'm1', threadId: null,
  remitente: 'alertas@bancolombia.com.co',
  asunto: 'Compra aprobada',
  cuerpo: 'Compra por $89.900 en RAPPI',
  recibidoEn: '2026-08-07T09:55:00-05:00',
  etiquetas: [],
}

const hecho = (p: Partial<HechoFinanzas> = {}): HechoFinanzas => ({
  clase: 'movimiento',
  tipo: 'egreso',
  montoTexto: '$89.900',
  moneda: 'COP',
  referente: { tipo: 'hoy' },
  contraparte: 'RAPPI',
  concepto: 'Compra',
  categoria: null,
  confianza: 'alta',
  ...p,
})

before(async () => { db = await crearBaseDePrueba(); await migrar(db) })
after(async () => { await db.cerrar() })
beforeEach(async () => {
  await db.ejecutar('TRUNCATE movimientos, cuentas_por_pagar RESTART IDENTITY CASCADE')
})

const armar = () => crearServicioTesoro({
  reloj,
  repoMovimientos: crearRepoMovimientos(db),
  repoCuentas: crearRepoCuentasPorPagar(db),
})

// ── registrar ───────────────────────────────────────────────────

test('un aviso del banco se vuelve una fila del libro', async () => {
  const t = armar()

  const r = await t.registrar(hecho(), correo, null)

  assert.equal(r.estado, 'registrado')
  if (r.estado !== 'registrado') return
  assert.equal(r.movimiento.monto, '$89.900')
  assert.equal(r.movimiento.contraparte, 'RAPPI')
  assert.equal(r.movimiento.categoria, 'Restaurantes',
    'la contraparte manda: Rappi es comida, no «otros»')
})

test('el mismo correo tres veces deja UN movimiento', async () => {
  // El banco reenvía, Marcelo reenvía, o la recuperación tras un apagón
  // reprocesa el rango. Sin el hash, el libro cuenta tres veces lo mismo y
  // queda mintiendo en silencio.
  const t = armar()

  const uno = await t.registrar(hecho(), correo, null)
  const dos = await t.registrar(hecho(), correo, null)
  const tres = await t.registrar(hecho(), correo, null)

  assert.equal(uno.estado, 'registrado')
  assert.equal(dos.estado, 'repetido')
  assert.equal(tres.estado, 'repetido')

  const b = await t.balance()
  assert.equal(b.movimientos.length, 1)
  assert.equal(b.egresos, 8_990_000)
})

test('el mismo aviso con el nombre escrito distinto tampoco entra dos veces', async () => {
  const t = armar()
  await t.registrar(hecho({ contraparte: 'RAPPI S.A.S.' }), correo, null)

  const otra = await t.registrar(hecho({ contraparte: 'Rappi SAS' }), correo, null)

  assert.equal(otra.estado, 'repetido')
})

test('un correo que menciona plata pero no es una transacción no entra', async () => {
  // Es el caso tramposo obligatorio del spec, y el más común de todos:
  // promociones, extractos, avisos de seguridad, cupos aprobados.
  const t = armar()

  const r = await t.registrar(hecho({ clase: 'ninguno' }), correo, null)

  assert.equal(r.estado, 'descartado')
  assert.equal((await t.balance()).movimientos.length, 0)
})

test('con confianza baja no se apunta nada', async () => {
  // En el libro no se escribe a medias: un número mal puesto no se nota
  // hasta que alguien mira el mes y no le cuadra.
  const t = armar()

  const r = await t.registrar(hecho({ confianza: 'baja' }), correo, null)

  assert.equal(r.estado, 'descartado')
  assert.match(r.estado === 'descartado' ? r.motivo : '', /Confianza baja/)
})

test('un monto ilegible se descarta diciendo cuál era', async () => {
  const t = armar()

  const r = await t.registrar(hecho({ montoTexto: 'varios miles' }), correo, null)

  assert.equal(r.estado, 'descartado')
  assert.match(r.estado === 'descartado' ? r.motivo : '', /varios miles/)
})

test('sin fecha se usa la del correo: la plata ya se movió', async () => {
  const t = armar()

  await t.registrar(hecho({ referente: { tipo: 'desconocido' } }), correo, null)

  const b = await t.balance()
  assert.equal(b.movimientos[0]!.fecha, '2026-08-07')
})

test('lo que está en otra moneda no se suma a los pesos', async () => {
  // Mezclarlas daría un número que no significa nada. Mientras no haya
  // TRM, sólo los pesos entran al balance; lo demás se ve en la lista.
  const t = armar()
  await t.registrar(hecho(), correo, null)
  await t.registrar(hecho({
    montoTexto: '45.99', moneda: 'USD', contraparte: 'OpenAI',
  }), correo, null)

  const b = await t.balance()

  assert.equal(b.movimientos.length, 2)
  assert.equal(b.egresos, 8_990_000, 'sólo el cargo en pesos')
  assert.equal(b.movimientos.find((m) => m.moneda === 'USD')!.montoCop, null,
    'fingir una conversión sería peor que dejarlo vacío')
})

// ── el balance del mes ──────────────────────────────────────────

test('el balance suma, resta y dice dónde se fue la plata', async () => {
  const t = armar()
  await t.registrar(hecho({
    tipo: 'ingreso', montoTexto: '$1.240.000', contraparte: 'Nómina', categoria: null,
  }), correo, null)
  await t.registrar(hecho(), correo, null)
  await t.registrar(hecho({ montoTexto: '$45.000', contraparte: 'CLARO' }), correo, null)

  const b = await t.balance()

  assert.equal(b.ingresos, 124_000_000)
  assert.equal(b.egresos, 8_990_000 + 4_500_000)
  assert.equal(b.neto, 124_000_000 - 13_490_000)
  assert.deepEqual(b.porCategoria.map((c) => c.nombre), ['Restaurantes', 'Servicios'])
})

test('anular no borra: el rastro se queda', async () => {
  const t = armar()
  const repo = crearRepoMovimientos(db)
  const r = await t.registrar(hecho(), correo, null)
  const id = r.estado === 'registrado' ? r.id : 0

  await repo.anular(id)

  assert.equal((await t.balance()).movimientos.length, 0, 'sale del balance')
  assert.equal((await repo.porId(id))?.estado, 'anulado', 'pero la fila sigue ahí')
})

test('cobros repetidos del mismo comercio se señalan', async () => {
  // No es lo mismo que la deduplicación: son dos cobros de verdad, en días
  // distintos, que parecen uno de más.
  const t = armar()
  await t.registrar(hecho(), correo, null)
  await t.registrar(hecho({ referente: { tipo: 'fecha', iso: '2026-08-05' } }), correo, null)

  const b = await t.balance()

  assert.equal(b.sospechas.length, 1)
  assert.equal(b.sospechas[0]!.contraparte, 'RAPPI')
  assert.equal(b.sospechas[0]!.veces, 2)
})

// ── cuentas por pagar ───────────────────────────────────────────

test('una factura con fecha límite queda como cuenta por pagar', async () => {
  const t = armar()

  const r = await t.registrar(hecho({
    clase: 'cuenta_por_pagar',
    montoTexto: '$1.800.000',
    contraparte: 'Inmobiliaria',
    concepto: 'Arriendo agosto',
    referente: { tipo: 'fecha', iso: '2026-08-10' },
  }), correo, null)

  assert.equal(r.estado, 'por_pagar')
  const b = await t.balance()
  assert.equal(b.cuentasPorPagar[0]!.acreedor, 'Inmobiliaria')
  assert.equal(b.cuentasPorPagar[0]!.diasRestantes, 3)
  assert.equal(b.movimientos.length, 0, 'todavía no se movió la plata')
})

test('un cobro futuro sin fecha no se puede avisar, así que no se anota', async () => {
  const t = armar()

  const r = await t.registrar(hecho({
    clase: 'cuenta_por_pagar', referente: { tipo: 'desconocido' },
  }), correo, null)

  assert.equal(r.estado, 'descartado')
})

test('lo que vence pronto se avisa una vez, no todas las noches', async () => {
  const t = armar()
  await t.registrar(hecho({
    clase: 'cuenta_por_pagar', montoTexto: '$1.800.000', contraparte: 'Arriendo',
    referente: { tipo: 'fecha', iso: '2026-08-09' },
  }), correo, null)

  const primera = await t.porVencer()
  const segunda = await t.porVencer()

  assert.equal(primera.length, 1)
  assert.equal(primera[0]!.monto, '$1.800.000')
  assert.equal(primera[0]!.diasRestantes, 2)
  assert.deepEqual(segunda, [], 'el mismo vencimiento tres noches seguidas es ruido')
})

test('lo que vence lejos todavía no se avisa', async () => {
  const t = armar()
  await t.registrar(hecho({
    clase: 'cuenta_por_pagar', contraparte: 'Impuestos',
    referente: { tipo: 'fecha', iso: '2026-09-30' },
  }), correo, null)

  assert.deepEqual(await t.porVencer(), [])
})

// ── lo del día, para el resumen ─────────────────────────────────

test('el resumen del día cuenta lo de hoy y nada más', async () => {
  const t = armar()
  await t.registrar(hecho(), correo, null)
  await t.registrar(hecho({
    tipo: 'ingreso', montoTexto: '$1.240.000', contraparte: 'Nómina',
  }), correo, null)
  await t.registrar(hecho({
    montoTexto: '$20.000', contraparte: 'Ayer',
    referente: { tipo: 'fecha', iso: '2026-08-06' },
  }), correo, null)

  const dia = await t.delDia()

  assert.equal(dia.cuantos, 2)
  assert.equal(dia.ingresos, 124_000_000)
  assert.equal(dia.egresos, 8_990_000)
})

// ── el nombre del local, puesto a mano ──────────────────────────

test('se le puede poner nombre al local cuando la contraparte no se parece', async () => {
  // «UNIMEDE4» es lo que dijo el correo del banco; el local de verdad es
  // Dollar City. El modelo no lo sabe: sólo Marcelo puede ponerlo.
  const t = armar()
  const r = await t.registrar(hecho({ contraparte: 'UNIMEDE4' }), correo, null)
  assert.equal(r.estado, 'registrado')
  if (r.estado !== 'registrado') return

  const actualizado = await t.ponerLocal(r.id, 'Dollar City')

  assert.equal(actualizado?.local, 'Dollar City')
  assert.equal(actualizado?.contraparte, 'UNIMEDE4', 'la contraparte no se toca')

  const b = await t.balance()
  assert.equal(b.movimientos[0]!.local, 'Dollar City')
})

test('un local en blanco vuelve a mostrar sólo la contraparte', async () => {
  const t = armar()
  const r = await t.registrar(hecho(), correo, null)
  if (r.estado !== 'registrado') return assert.fail()

  await t.ponerLocal(r.id, 'Nombre a medias')
  const limpiado = await t.ponerLocal(r.id, '   ')

  assert.equal(limpiado?.local, null)
})

test('editar el local de un movimiento que no existe no revienta', async () => {
  const t = armar()
  assert.equal(await t.ponerLocal(999_999, 'Lo que sea'), null)
})
