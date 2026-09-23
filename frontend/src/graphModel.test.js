import test from 'node:test'
import assert from 'node:assert/strict'
import { buildGraphView, graphFit, layoutGraphView, nodeRadius } from './graphModel.js'

const node = (id, extra = {}) => ({ id, role: 'peripheral', depth: 1, is_seed: false, priority_score: 0.5, ...extra })

test('incoming transfers keep their actual direction and amounts; cycles and reciprocal edges survive', () => {
  const data = { nodes: ['a', 'b', 'c'].map((id) => node(id)), links: [
    { source: 'a', target: 'b', sum_kzt: 160000 },
    { source: 'b', target: 'a', sum_kzt: 20000 },
    { source: 'b', target: 'c', sum_kzt: 30000 },
    { source: 'c', target: 'a', sum_kzt: 5000 },
  ] }
  const before = JSON.stringify(data)
  const graph = layoutGraphView(buildGraphView(data, { rootId: 'b', hop: 2 }))
  assert.equal(graph.links.length, 4)
  assert.deepEqual(graph.links.map(({ source, target, sum_kzt }) => [source, target, sum_kzt]), data.links.map(({ source, target, sum_kzt }) => [source, target, sum_kzt]))
  assert.ok(graph.links[0]._curvature > 0)
  assert.equal(JSON.stringify(data), before)
  graph.links[0].source = graph.nodes[0]
  assert.equal(data.links[0].source, 'a', 'D3 mutation is isolated from original data')
})

test('priority view keeps all 30 top nodes, including disconnected and isolated components', () => {
  const nodes = Array.from({ length: 32 }, (_, index) => node(`gid-${index}`))
  const data = { nodes, top: nodes.slice(0, 30).map((n, index) => ({ gid: n.id, rank: index + 1 })), links: [{ source: 'gid-0', target: 'gid-1', sum_kzt: 10 }, { source: 'gid-20', target: 'gid-21', sum_kzt: 20 }] }
  const view = buildGraphView(data, { mode: 'priority', rootId: 'gid-31' })
  const graph = layoutGraphView(view)
  assert.equal(graph.nodes.length, 30)
  assert.equal(graph.links.length, 2)
  assert.ok(graph.nodes.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y)))
  assert.equal(new Set(graph.nodes.map((n) => `${n.x}|${n.y}`)).size, 30)
})

test('ego budget balances payers and recipients and reports the complete hidden count', () => {
  const incoming = Array.from({ length: 5 }, (_, i) => node(`in-${i}`))
  const outgoing = Array.from({ length: 99 }, (_, i) => node(`out-${i}`))
  const data = { nodes: [node('root'), ...incoming, ...outgoing], links: [...incoming.map((n) => ({ source: n.id, target: 'root', sum_kzt: 5 })), ...outgoing.map((n) => ({ source: 'root', target: n.id, sum_kzt: 10 }))] }
  const view = buildGraphView(data, { rootId: 'root', limit: 80 })
  assert.equal(view.nodes.filter((n) => n._direction === 'in').length, 5)
  assert.equal(view.summary.availableNodes, 105)
  assert.equal(view.summary.hiddenNodes, 25)
  assert.equal(view.summary.visibleNodes, 80)
})

test('filters preserve disconnected matching nodes and explicitly mark an excluded ego root as context', () => {
  const data = { nodes: [node('a', { depth: 0 }), node('b', { depth: 1 }), node('c', { depth: 4, role: 'boundary' })], links: [{ source: 'a', target: 'b' }, { source: 'b', target: 'c' }] }
  const view = buildGraphView(data, { rootId: 'a', hop: 2, filters: { depth: '4' } })
  assert.deepEqual(view.nodes.map((n) => n.id), ['a', 'c'])
  assert.equal(view.nodes[0]._contextOnly, true)
  assert.equal(view.summary.rootExcludedByFilters, true)
  assert.equal(layoutGraphView(view).nodes.length, 2)
  assert.equal(view.links.length, 0)
})

test('exact 18-digit gids remain strings and adjacent values stay distinct', () => {
  const a = '100000000000000101'
  const b = '100000000000000102'
  const data = { nodes: [node(a), node(b)], links: [{ source: a, target: b, sum_kzt: 5000 }] }
  const view = buildGraphView(data, { rootId: b })
  assert.equal(view.nodes[0].id, b)
  assert.equal(view.links[0].source, a)
  assert.equal(view.links[0].target, b)
  assert.equal(new Set(view.nodes.map((n) => n.id)).size, 2)
})

test('cluster selection and filters never add outside nodes or artificial links', () => {
  const data = { nodes: [node('a', { cluster_id: 0, is_seed: true }), node('b', { cluster_id: 0, is_seed: true }), node('c', { cluster_id: 1, is_seed: true })], links: [{ source: 'a', target: 'c' }] }
  const view = buildGraphView(data, { mode: 'cluster', clusterId: 0, filters: { seed: 'seed' } })
  assert.deepEqual(view.nodes.map((n) => n.id), ['a', 'b'])
  assert.equal(view.links.length, 0)
  assert.equal(layoutGraphView(view).nodes.length, 2)
})

test('fit respects both width and height and does not zoom single nodes excessively', () => {
  const wide = graphFit([{ x: -3000, y: 0 }, { x: 3000, y: 0 }], 600, 500)
  assert.ok(6048 * wide.zoom <= 520)
  const tall = graphFit([{ x: 0, y: -2000 }, { x: 0, y: 2000 }], 600, 500)
  assert.ok(4048 * tall.zoom <= 420)
  assert.equal(graphFit([{ x: 0, y: 0 }], 600, 500).zoom, 1.5)
})

test('hop selection includes exactly the requested neighborhood and isolated roots remain usable', () => {
  const data = { nodes: ['a', 'b', 'c', 'd', 'isolated'].map((id) => node(id)), links: [{ source: 'b', target: 'a' }, { source: 'c', target: 'b' }, { source: 'd', target: 'c' }] }
  assert.deepEqual(buildGraphView(data, { rootId: 'a', hop: 1 }).nodes.map((n) => n.id), ['a', 'b'])
  assert.deepEqual(buildGraphView(data, { rootId: 'a', hop: 2 }).nodes.map((n) => n.id), ['a', 'b', 'c'])
  const isolated = layoutGraphView(buildGraphView(data, { rootId: 'isolated' }))
  assert.equal(isolated.nodes.length, 1)
  assert.equal(isolated.links.length, 0)
  assert.deepEqual([isolated.nodes[0].x, isolated.nodes[0].y], [0, 0])
})

test('fitted node sizes remain visible and preserve priority differences at every supported zoom', () => {
  for (const scale of [0.025, 0.1, 0.25, 0.5, 1, 2, 6]) {
    const small = nodeRadius(node('low', { priority_score: 0 }), scale)
    const large = nodeRadius(node('high', { priority_score: 1 }), scale)
    assert.ok(small * scale >= 4)
    assert.ok(large > small)
    assert.ok(Math.max(small + 2 / scale, 6 / scale) * scale >= 6)
  }
})
