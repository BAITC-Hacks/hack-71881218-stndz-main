import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeGraphPayload } from './graphAdapter.js'
import { localTransactions } from './format.js'

const payer = '100000000000000001'
const receiver = '100000000000000002'
const nodes = [
  { gid: payer, metrics: { in_kzt: 0, out_kzt: 160000, in_tx: 0, out_tx: 2 }, role: 'distributor', flags: [], priority_score: 0.8, rank: 1, evidence: '2 перевода' },
  { gid: receiver, metrics: { in_kzt: 160000, out_kzt: 0, in_tx: 2, out_tx: 0 }, role: 'terminal', flags: [], priority_score: 0.3 },
]
const transactions = [
  { src: payer, dst: receiver, date: '2026-07-01', sum_kzt: 80000 },
  { src: payer, dst: receiver, date: '2026-07-03', sum_kzt: 80000 },
]
const raw = { nodes, edges: [{ src: payer, dst: receiver, sum_kzt: 160000, n_tx: 2 }], clusters: [], meta: {} }

test('official export and API preserve exact neighboring 18-digit identifiers and flow metrics', () => {
  const exported = normalizeGraphPayload(raw)
  assert.deepEqual(exported.nodes.map(node => node.id), [payer, receiver])
  assert.equal(exported.nodes[1].in_kzt, 160000)
  assert.equal(exported.nodes[1].out_kzt, 0)
  assert.equal(exported.links[0].source, payer)
  const api = normalizeGraphPayload({ meta: {}, nodes: exported.nodes, links: exported.links, top: exported.top })
  assert.equal(api.top[0].gid, payer)
  assert.equal(api.nodes[0].out_tx, 2)
  assert.throws(() => normalizeGraphPayload({ ...raw, nodes: [{ ...nodes[0], gid: Number(payer) }] }), /GID/)
})

test('missing transaction detail is not represented as zero financial activity', () => {
  const absent = normalizeGraphPayload(raw)
  assert.equal(localTransactions(absent, receiver).available, false)
  assert.equal(absent.nodes[1].in_kzt, 160000)
  const empty = normalizeGraphPayload({ ...raw, transactions: [] })
  assert.equal(localTransactions(empty, receiver).available, true)
  assert.equal(localTransactions(empty, receiver).total, 0)
})

test('local history matches API direction, newest-first order, duplicate preservation and pagination', () => {
  const data = normalizeGraphPayload({ ...raw, transactions: [...transactions, transactions[1]] })
  const page = localTransactions(data, receiver, 'in', 0, 1)
  assert.equal(page.total, 3)
  assert.equal(page.transactions[0].date, '2026-07-03')
  assert.equal(localTransactions(data, receiver, 'in', 1, 1).transactions[0].date, '2026-07-03')
  assert.equal(localTransactions(data, receiver, 'out').total, 0)
  assert.equal(localTransactions(data, payer, 'out').total, 3)
})

test('adapter rejects duplicate clients and dangling links instead of drawing fabricated counterparts', () => {
  assert.throws(() => normalizeGraphPayload({ ...raw, nodes: [nodes[0], nodes[0]] }), /согласованы/)
  assert.throws(() => normalizeGraphPayload({ ...raw, nodes: [nodes[0]] }), /согласованы/)
})
