import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ForceGraph2D from 'react-force-graph-2d'
import { LOCALES } from './i18n'
import { normalizeGraphPayload } from './graphAdapter'
import CopilotPanel from './CopilotPanel'
import LedgerPage from './LedgerPage'
import './App.css'

const ROLE_COLOR = {
  boundary: '#7b61a8',
  consolidator: '#e53935',
  coordinator: '#c9a227',
  distributor: '#f0873b',
  transit: '#4aa3e8',
  terminal: '#02b140',
  peripheral: '#8a94a3',
}

const ROLE_ORDER = [
  'consolidator',
  'coordinator',
  'distributor',
  'transit',
  'terminal',
  'boundary',
  'peripheral',
]

const MAX_DEPTH = 4
const MAX_DEPTH_EXPANDED = 7
const MAX_NODES = 80
const MAX_NODES_EXPANDED = 140
const LEVEL_GAP = 150
const SIBLING_GAP = 92
const EXPAND_LIMIT = 10

function formatKzt(n, locale) {
  if (n == null || Number.isNaN(n)) return '—'
  const loc = locale === 'en' ? 'en-US' : 'ru-RU'
  if (n >= 1_000_000) {
    const v = (n / 1_000_000).toFixed(1)
    return locale === 'en' ? `${v}M ₸` : `${v} млн ₸`
  }
  return new Intl.NumberFormat(loc, { maximumFractionDigits: 0 }).format(n) + ' ₸'
}

function linkId(end) {
  return typeof end === 'object' ? end.id : end
}

function buildAdjMaps(links) {
  const undirected = new Map()
  const out = new Map()
  const inn = new Map()
  const push = (map, a, b, sum) => {
    if (!map.has(a)) map.set(a, [])
    map.get(a).push({ id: b, sum_kzt: sum || 0 })
  }
  for (const l of links) {
    const s = linkId(l.source)
    const t = linkId(l.target)
    const sum = l.sum_kzt || 0
    push(undirected, s, t, sum)
    push(undirected, t, s, sum)
    push(out, s, t, sum)
    push(inn, t, s, sum)
  }
  for (const map of [undirected, out, inn]) {
    for (const list of map.values()) list.sort((a, b) => b.sum_kzt - a.sum_kzt)
  }
  return { undirected, out, inn }
}

/** Ego neighborhood around a center (real nodes only). */
function buildEgoGraph(data, centerId, hop = 2) {
  const nodeMap = new Map(data.nodes.map((n) => [n.id, n]))
  if (!nodeMap.has(centerId)) return { nodes: [], links: [] }

  const keep = new Set([centerId])
  let frontier = new Set([centerId])
  for (let h = 0; h < hop; h++) {
    const next = new Set()
    for (const link of data.links) {
      const s = link.source
      const t = link.target
      if (frontier.has(s) && !keep.has(t)) {
        next.add(t)
        keep.add(t)
      }
      if (frontier.has(t) && !keep.has(s)) {
        next.add(s)
        keep.add(s)
      }
    }
    frontier = next
  }

  return {
    nodes: [...keep].map((id) => nodeMap.get(id)).filter(Boolean).map((n) => ({ ...n })),
    links: data.links
      .filter((l) => keep.has(l.source) && keep.has(l.target))
      .map((l) => ({ ...l })),
  }
}

/**
 * Role-filtered subgraph: nodes of the role + bridging connectors along
 * shortest undirected paths so the tree stays connected.
 */
function buildRoleGraph(data, role, preferredRoot, limit = 48) {
  const byRole = data.nodes
    .filter((n) => n.role === role)
    .sort((a, b) => b.priority_score - a.priority_score)

  if (!byRole.length) return { nodes: [], links: [], rootId: preferredRoot }

  const roleIds = new Set(byRole.slice(0, limit).map((n) => n.id))
  if (preferredRoot && data.nodes.some((n) => n.id === preferredRoot && n.role === role)) {
    roleIds.add(preferredRoot)
  }

  const rootId =
    (preferredRoot && roleIds.has(preferredRoot) && preferredRoot) ||
    byRole[0].id

  // Include 1-hop neighbors of selected role nodes so hierarchy has edges
  const keep = new Set(roleIds)
  for (const l of data.links) {
    if (roleIds.has(l.source)) keep.add(l.target)
    if (roleIds.has(l.target)) keep.add(l.source)
  }

  // Cap total size: keep all role nodes, then top neighbors by priority
  if (keep.size > MAX_NODES) {
    const extras = [...keep]
      .filter((id) => !roleIds.has(id))
      .map((id) => data.nodes.find((n) => n.id === id))
      .filter(Boolean)
      .sort((a, b) => b.priority_score - a.priority_score)
      .slice(0, Math.max(0, MAX_NODES - roleIds.size))
      .map((n) => n.id)
    keep.clear()
    roleIds.forEach((id) => keep.add(id))
    extras.forEach((id) => keep.add(id))
  }

  return {
    nodes: data.nodes.filter((n) => keep.has(n.id)).map((n) => ({ ...n })),
    links: data.links.filter((l) => keep.has(l.source) && keep.has(l.target)),
    rootId,
  }
}

/**
 * Counterparties of a node from links + transactions, money-volume ranked.
 * Prefers outgoing (fund flow down the tree), then incoming.
 */
function collectTxCounterparties(data, nodeId, limit = EXPAND_LIMIT) {
  const outSum = new Map()
  const inSum = new Map()

  for (const l of data.links) {
    if (l.source === nodeId) {
      outSum.set(l.target, (outSum.get(l.target) || 0) + (l.sum_kzt || 0))
    }
    if (l.target === nodeId) {
      inSum.set(l.source, (inSum.get(l.source) || 0) + (l.sum_kzt || 0))
    }
  }

  for (const t of data.transactions || []) {
    if (t.src === nodeId) {
      outSum.set(t.dst, (outSum.get(t.dst) || 0) + (t.sum_kzt || 0))
    }
    if (t.dst === nodeId) {
      inSum.set(t.src, (inSum.get(t.src) || 0) + (t.sum_kzt || 0))
    }
  }

  const ranked = []
  for (const [id, sum] of outSum) ranked.push({ id, sum, pref: 2 })
  for (const [id, sum] of inSum) {
    if (!outSum.has(id)) ranked.push({ id, sum, pref: 1 })
  }
  ranked.sort((a, b) => b.pref - a.pref || b.sum - a.sum)
  return ranked.slice(0, limit).map((r) => r.id)
}

/** Pull transaction counterparties of expanded nodes into the subgraph. */
function enrichWithExpansions(subgraph, data, expandedIds) {
  if (!expandedIds?.size) return subgraph
  const keep = new Set(subgraph.nodes.map((n) => n.id))
  for (const id of expandedIds) {
    if (!keep.has(id)) continue
    for (const nid of collectTxCounterparties(data, id)) keep.add(nid)
  }
  return {
    nodes: data.nodes.filter((n) => keep.has(n.id)).map((n) => ({ ...n })),
    links: data.links.filter((l) => keep.has(l.source) && keep.has(l.target)),
  }
}

/**
 * Hierarchical tree — real nodes only (no collapsed / synthetic nodes).
 * When forceChildren is set, those nodes are attached under the given parent
 * even if BFS would have skipped them (used for expand-on-click).
 */
function layoutTreeGraph(subgraph, rootId, opts = {}) {
  const maxDepth = opts.maxDepth ?? MAX_DEPTH
  const levelGap = opts.levelGap ?? LEVEL_GAP
  const siblingGap = opts.siblingGap ?? SIBLING_GAP
  const maxNodes = opts.maxNodes ?? MAX_NODES
  /** Map parentId -> childId[] forced under expanded clicks */
  const forceChildren = opts.forceChildren || new Map()

  if (!subgraph.nodes.length) return { nodes: [], links: [], rootId }

  const nodeMap = new Map(subgraph.nodes.map((n) => [n.id, { ...n }]))
  if (!nodeMap.has(rootId)) {
    const fallback = subgraph.nodes
      .slice()
      .sort((a, b) => (b.priority_score || 0) - (a.priority_score || 0))[0]
    if (!fallback) return { nodes: [], links: [], rootId }
    rootId = fallback.id
  }

  const { undirected, out, inn } = buildAdjMaps(subgraph.links)
  const parentOf = new Map()
  const childrenOf = new Map()
  const depthOf = new Map([[rootId, 0]])
  const visited = new Set([rootId])
  const queue = [rootId]

  const rankNeighbors = (u) => {
    const seen = new Set()
    const ranked = []
    // Forced children first (expanded transaction branch)
    for (const cid of forceChildren.get(u) || []) {
      if (!visited.has(cid) && nodeMap.has(cid) && !seen.has(cid)) {
        seen.add(cid)
        ranked.push({ id: cid, sum_kzt: 1e12, _pref: 3 })
      }
    }
    for (const n of out.get(u) || []) {
      if (!visited.has(n.id) && nodeMap.has(n.id) && !seen.has(n.id)) {
        seen.add(n.id)
        ranked.push({ ...n, _pref: 2 })
      }
    }
    for (const n of inn.get(u) || []) {
      if (!visited.has(n.id) && nodeMap.has(n.id) && !seen.has(n.id)) {
        seen.add(n.id)
        ranked.push({ ...n, _pref: 1 })
      }
    }
    for (const n of undirected.get(u) || []) {
      if (!visited.has(n.id) && nodeMap.has(n.id) && !seen.has(n.id)) {
        seen.add(n.id)
        ranked.push({ ...n, _pref: 0 })
      }
    }
    ranked.sort((a, b) => b._pref - a._pref || b.sum_kzt - a.sum_kzt)
    return ranked
  }

  while (queue.length) {
    const u = queue.shift()
    const depth = depthOf.get(u)
    childrenOf.set(u, [])
    if (depth >= maxDepth || visited.size >= maxNodes) continue

    const neigh = rankNeighbors(u)
    for (const n of neigh) {
      if (visited.size >= maxNodes) break
      visited.add(n.id)
      parentOf.set(n.id, u)
      depthOf.set(n.id, depth + 1)
      childrenOf.get(u).push(n.id)
      queue.push(n.id)
    }
  }

  // Attach forced children that BFS missed (e.g. already visited elsewhere):
  // only add if not already in tree under another parent — skip duplicates.
  for (const [parent, kids] of forceChildren) {
    if (!depthOf.has(parent)) continue
    const depth = depthOf.get(parent)
    if (depth >= maxDepth) continue
    if (!childrenOf.has(parent)) childrenOf.set(parent, [])
    for (const cid of kids) {
      if (!nodeMap.has(cid)) continue
      if (depthOf.has(cid)) continue
      if (visited.size >= maxNodes) break
      visited.add(cid)
      parentOf.set(cid, parent)
      depthOf.set(cid, depth + 1)
      childrenOf.get(parent).push(cid)
    }
  }

  for (const id of [...nodeMap.keys()]) {
    if (!depthOf.has(id)) nodeMap.delete(id)
  }

  const leafOrder = []
  function walk(id) {
    const kids = childrenOf.get(id) || []
    if (!kids.length) {
      leafOrder.push(id)
      return
    }
    for (const k of kids) walk(k)
  }
  walk(rootId)

  const xOf = new Map()
  leafOrder.forEach((id, i) => xOf.set(id, i * siblingGap))

  function assignX(id) {
    if (xOf.has(id)) return xOf.get(id)
    const kids = childrenOf.get(id) || []
    if (!kids.length) {
      const x = (xOf.size || 0) * siblingGap
      xOf.set(id, x)
      return x
    }
    const xs = kids.map(assignX)
    const x = (Math.min(...xs) + Math.max(...xs)) / 2
    xOf.set(id, x)
    return x
  }
  assignX(rootId)

  const xs = [...xOf.values()]
  const mid = xs.length ? (Math.min(...xs) + Math.max(...xs)) / 2 : 0

  const positioned = []
  for (const [id, depth] of depthOf) {
    const n = nodeMap.get(id)
    if (!n) continue
    const x = (xOf.get(id) ?? 0) - mid
    const y = depth * levelGap
    n.fx = x
    n.fy = y
    n.x = x
    n.y = y
    n._treeDepth = depth
    n._isRoot = id === rootId
    n._parentId = parentOf.get(id) ?? null
    positioned.push(n)
  }

  // Mark which nodes still have hidden tx counterparties
  for (const n of positioned) {
    const cps = opts.counterpartyLookup?.(n.id) || []
    n._hasMoreTx = cps.some((cid) => !depthOf.has(cid))
  }

  const moneyByPair = new Map()
  for (const l of subgraph.links) {
    const s = linkId(l.source)
    const t = linkId(l.target)
    moneyByPair.set(`${s}|${t}`, l)
    moneyByPair.set(`${t}|${s}`, l)
  }

  const links = []
  for (const [id, p] of parentOf) {
    if (!nodeMap.has(id)) continue
    const money = moneyByPair.get(`${p}|${id}`)
    links.push({
      ...(money || { sum_kzt: 0, n_tx: 0 }),
      source: p,
      target: id,
      _tree: true,
    })
  }

  return { nodes: positioned, links, rootId }
}

function ensureVisible(fg, node, root, height) {
  if (!fg || !node || !Number.isFinite(node.y)) return
  // Prefer keeping root above; if selection is far below, pan down
  if (root && Number.isFinite(root.y)) {
    const span = Math.max(node.y - root.y, LEVEL_GAP)
    const targetY = root.y + span * 0.45
    const zoom = Math.min(
      1.4,
      Math.max(0.5, (height * 0.78) / (span + LEVEL_GAP * 2)),
    )
    fg.centerAt(root.x ?? 0, targetY, 350)
    fg.zoom(zoom, 350)
  } else {
    fg.centerAt(node.x, node.y, 350)
  }
}

export default function App() {
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [roleFilter, setRoleFilter] = useState('all')
  const [depthFilter, setDepthFilter] = useState('all')
  const [seedFilter, setSeedFilter] = useState('all')
  const [selectedCluster, setSelectedCluster] = useState('')
  const [selectedId, setSelectedId] = useState(null)
  const [nodeCard, setNodeCard] = useState(null)
  /** Stable tree root — only changes on search / rank / explicit re-root */
  const [treeRootId, setTreeRootId] = useState(null)
  /** Nodes whose transaction counterparties are pulled into the tree */
  const [expandedIds, setExpandedIds] = useState(() => new Set())
  const [mode, setMode] = useState('network')
  const [graphSize, setGraphSize] = useState({ width: 0, height: 0 })
  const [locale, setLocale] = useState(() => {
    try {
      return localStorage.getItem('aml-locale') === 'en' ? 'en' : 'ru'
    } catch {
      return 'ru'
    }
  })
  const fgRef = useRef()
  const graphHostRef = useRef(null)
  const cameraKeyRef = useRef('')
  const pendingPanRef = useRef(null)
  const i = LOCALES[locale]

  useEffect(() => {
    try {
      localStorage.setItem('aml-locale', locale)
    } catch {
      /* ignore */
    }
  }, [locale])

  useEffect(() => {
    fetch('/data/graph.json')
      .then((r) => {
        if (!r.ok) throw new Error(LOCALES.ru.loadError)
        return r.json()
      })
      .then((json) => {
        const normalized = normalizeGraphPayload(json)
        setData(normalized)
        const first = normalized.top?.[0]?.gid || normalized.nodes?.[0]?.id
        if (first) {
          setSelectedId(first)
          setTreeRootId(first)
        }
        if (normalized.clusters?.length) {
          setSelectedCluster(String(normalized.clusters[0].cluster_id))
        }
      })
      .catch((e) => setError(e.message))
  }, [])

  useEffect(() => {
    const el = graphHostRef.current
    if (!el) return

    const updateSize = () => {
      const { width, height } = el.getBoundingClientRect()
      setGraphSize({
        width: Math.max(0, Math.floor(width)),
        height: Math.max(0, Math.floor(height)),
      })
    }

    updateSize()
    const ro = new ResizeObserver(updateSize)
    ro.observe(el)
    return () => ro.disconnect()
  }, [data])

  const selected = useMemo(() => {
    if (!data || !selectedId) return null
    return data.nodes.find((n) => n.id === selectedId) || null
  }, [data, selectedId])

  useEffect(() => {
    if (!selectedId) {
      return undefined
    }
    const controller = new AbortController()
    fetch(`/api/nodes/${encodeURIComponent(selectedId)}/card`, {
      signal: controller.signal,
    })
      .then((response) => {
        if (!response.ok) throw new Error(String(response.status))
        return response.json()
      })
      .then(setNodeCard)
      .catch((requestError) => {
        if (requestError.name !== 'AbortError') setNodeCard(null)
      })
    return () => controller.abort()
  }, [selectedId])

  const roleCards = useMemo(() => {
    if (!data) return []
    const total = data.meta.n_nodes || 1
    return ROLE_ORDER.map((role) => {
      const count = data.meta.roles?.[role] || 0
      const share = (count / total) * 100
      return { role, count, share }
    })
  }, [data])

  const effectiveRoot =
    treeRootId || selectedId || data?.top?.[0]?.gid || null

  const graphData = useMemo(() => {
    if (!data || !effectiveRoot) return { nodes: [], links: [], rootId: null }

    let subgraph
    let root = effectiveRoot

    if (mode === 'cluster' && selectedCluster !== '') {
      const clusterId = Number(selectedCluster)
      const clusterNodes = data.nodes.filter((node) => node.cluster_id === clusterId)
      const clusterIds = new Set(clusterNodes.map((node) => node.id))
      root = clusterIds.has(effectiveRoot)
        ? effectiveRoot
        : clusterNodes.slice().sort((a, b) => b.priority_score - a.priority_score)[0]?.id
      subgraph = {
        nodes: clusterNodes.map((node) => ({ ...node })),
        links: data.links.filter(
          (link) => clusterIds.has(link.source) && clusterIds.has(link.target),
        ),
      }
    } else if (roleFilter !== 'all') {
      const roleGraph = buildRoleGraph(data, roleFilter, effectiveRoot, 48)
      subgraph = roleGraph
      root = roleGraph.rootId
    } else if (mode === 'priority') {
      const topIds = new Set(data.top.slice(0, 40).map((t) => t.gid))
      topIds.add(effectiveRoot)
      subgraph = {
        nodes: data.nodes.filter((n) => topIds.has(n.id)).map((n) => ({ ...n })),
        links: data.links.filter((l) => topIds.has(l.source) && topIds.has(l.target)),
      }
    } else {
      subgraph = buildEgoGraph(data, effectiveRoot, 2)
    }

    if (depthFilter !== 'all' || seedFilter !== 'all') {
      const visible = new Set(
        subgraph.nodes
          .filter(
            (node) =>
              (depthFilter === 'all' || node.depth === Number(depthFilter)) &&
              (seedFilter === 'all' || node.is_seed === (seedFilter === 'seed')),
          )
          .map((node) => node.id),
      )
      if (root) visible.add(root)
      subgraph = {
        nodes: subgraph.nodes.filter((node) => visible.has(node.id)),
        links: subgraph.links.filter(
          (link) => visible.has(link.source) && visible.has(link.target),
        ),
      }
    }

    subgraph = enrichWithExpansions(subgraph, data, expandedIds)

    const forceChildren = new Map()
    for (const id of expandedIds) {
      const kids = collectTxCounterparties(data, id).filter((cid) =>
        subgraph.nodes.some((n) => n.id === cid),
      )
      if (kids.length) forceChildren.set(id, kids)
    }

    const hasExpand = expandedIds.size > 0
    return layoutTreeGraph(subgraph, root, {
      maxDepth: hasExpand ? MAX_DEPTH_EXPANDED : MAX_DEPTH,
      maxNodes: hasExpand ? MAX_NODES_EXPANDED : MAX_NODES,
      levelGap: LEVEL_GAP,
      siblingGap: SIBLING_GAP,
      forceChildren,
      counterpartyLookup: (nid) => collectTxCounterparties(data, nid),
    })
  }, [
    data,
    effectiveRoot,
    roleFilter,
    depthFilter,
    seedFilter,
    selectedCluster,
    mode,
    expandedIds,
  ])

  // Recenter when root / filter / mode changes (not on selection)
  useEffect(() => {
    const fg = fgRef.current
    if (!fg || !graphSize.width || !graphSize.height) return
    if (!graphData.nodes.length) return

    const key = `${graphData.rootId}|${roleFilter}|${mode}`
    if (cameraKeyRef.current !== key) {
      cameraKeyRef.current = key
      const root = graphData.nodes.find((n) => n._isRoot) || graphData.nodes[0]
      const t = setTimeout(() => {
        const maxDepth = Math.max(...graphData.nodes.map((n) => n._treeDepth || 0), 1)
        const zoom = Math.min(
          1.25,
          Math.max(0.45, (graphSize.height * 0.8) / ((maxDepth + 1.2) * LEVEL_GAP)),
        )
        fg.centerAt(root.fx ?? 0, (root.fy ?? 0) + maxDepth * LEVEL_GAP * 0.32, 400)
        fg.zoom(zoom, 400)
      }, 60)
      return () => clearTimeout(t)
    }
  }, [graphData, graphSize.width, graphSize.height, roleFilter, mode])

  // After expand: pan down to show new branch while keeping root in frame
  useEffect(() => {
    const targetId = pendingPanRef.current
    if (!targetId || !graphData.nodes.length) return
    pendingPanRef.current = null
    const fg = fgRef.current
    if (!fg) return
    const node = graphData.nodes.find((n) => n.id === targetId)
    const root = graphData.nodes.find((n) => n._isRoot)
    const child =
      graphData.nodes.find((n) => n._parentId === targetId) || node
    const t = setTimeout(() => {
      if (child) ensureVisible(fg, child, root, graphSize.height)
    }, 80)
    return () => clearTimeout(t)
  }, [graphData, graphSize.height])

  const neighbors = useMemo(() => {
    if (!data || !selectedId) return { in: [], out: [] }
    const nodeMap = new Map(data.nodes.map((n) => [n.id, n]))
    const inn = []
    const out = []
    for (const l of data.links) {
      if (l.target === selectedId) {
        const n = nodeMap.get(l.source)
        if (n) inn.push({ ...n, sum_kzt: l.sum_kzt, n_tx: l.n_tx })
      }
      if (l.source === selectedId) {
        const n = nodeMap.get(l.target)
        if (n) out.push({ ...n, sum_kzt: l.sum_kzt, n_tx: l.n_tx })
      }
    }
    inn.sort((a, b) => b.sum_kzt - a.sum_kzt)
    out.sort((a, b) => b.sum_kzt - a.sum_kzt)
    return { in: inn.slice(0, 8), out: out.slice(0, 8) }
  }, [data, selectedId])

  const history = useMemo(() => {
    if (!data || !selectedId) return []
    const txs = data.transactions || []
    return txs
      .filter((t) => t.src === selectedId || t.dst === selectedId)
      .map((t) => {
        const incoming = t.dst === selectedId
        return {
          date: t.date,
          dir: incoming ? 'in' : 'out',
          counterparty: incoming ? t.src : t.dst,
          sum_kzt: t.sum_kzt,
        }
      })
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
  }, [data, selectedId])

  /** Select in card / list — also expand tx branch if node is already on the tree */
  const selectNode = useCallback(
    (id, { pan = true, expand = false } = {}) => {
      setSelectedId(id)
      if (expand && data) {
        const cps = collectTxCounterparties(data, id)
        if (cps.length) {
          pendingPanRef.current = id
          setExpandedIds((prev) => {
            if (prev.has(id)) return prev
            const next = new Set(prev)
            next.add(id)
            return next
          })
          return
        }
      }
      if (!pan) return
      requestAnimationFrame(() => {
        const fg = fgRef.current
        if (!fg) return
        const nodes = fg.graphData()?.nodes || []
        const node = nodes.find((n) => n.id === id)
        const root = nodes.find((n) => n._isRoot)
        if (node) ensureVisible(fg, node, root, graphSize.height)
      })
    },
    [data, graphSize.height],
  )

  /** Re-root the tree (search / ranking / explicit) */
  const reRootTree = useCallback((id) => {
    setTreeRootId(id)
    setSelectedId(id)
    setExpandedIds(new Set())
    setMode('hunt')
    cameraKeyRef.current = ''
  }, [])

  const onNodeClick = useCallback(
    (node) => {
      setSelectedId(node.id)
      // Expand transaction counterparties under this node (keep root/tree)
      const cps = data ? collectTxCounterparties(data, node.id) : []
      if (cps.length) {
        pendingPanRef.current = node.id
        setExpandedIds((prev) => {
          if (prev.has(node.id)) return prev
          const next = new Set(prev)
          next.add(node.id)
          return next
        })
      } else {
        requestAnimationFrame(() => {
          const fg = fgRef.current
          if (!fg) return
          const nodes = fg.graphData()?.nodes || []
          const n = nodes.find((x) => x.id === node.id)
          const root = nodes.find((x) => x._isRoot)
          if (n) ensureVisible(fg, n, root, graphSize.height)
        })
      }
    },
    [data, graphSize.height],
  )

  const onRoleFilter = useCallback(
    (role) => {
      setRoleFilter(role)
      setExpandedIds(new Set())
      cameraKeyRef.current = ''
      if (role === 'all') return
      if (!data) return
      const current = data.nodes.find((n) => n.id === selectedId)
      if (current?.role === role) return
      const topOfRole = data.nodes
        .filter((n) => n.role === role)
        .sort((a, b) => b.priority_score - a.priority_score)[0]
      if (topOfRole) {
        setTreeRootId(topOfRole.id)
        setSelectedId(topOfRole.id)
      }
    },
    [data, selectedId],
  )

  const onSearch = (e) => {
    e.preventDefault()
    const q = query.trim()
    if (!q || !data) return
    const exact = data.nodes.find((n) => n.id === q)
    const suffixMatches = exact ? [] : data.nodes.filter((n) => n.id.endsWith(q))
    const hit = exact || (suffixMatches.length === 1 ? suffixMatches[0] : null)
    if (hit) {
      setError('')
      setRoleFilter('all')
      if (mode === 'ledger') {
        setSelectedId(hit.id)
      } else {
        reRootTree(hit.id)
      }
    } else if (suffixMatches.length > 1) {
      setError(i.ambiguousGid(q, suffixMatches.length))
    } else setError(i.notFound(q))
  }

  const zoomBy = (factor) => {
    const fg = fgRef.current
    if (!fg) return
    fg.zoom(fg.zoom() * factor, 300)
  }

  if (error && !data) return <div className="error">{error}</div>
  if (!data) return <div className="loading">{i.loading}</div>

  return (
    <div className="app">
      <header className="topbar">
        <a className="logo" href="https://bankffin.kz/" target="_blank" rel="noreferrer">
          <img
            className="logo-img"
            src="/freedom-logo.svg"
            alt="Freedom Bank Kazakhstan"
          />
          <div className="logo-text">
            <strong>{i.brand}</strong>
            <span>{i.brandSub}</span>
          </div>
        </a>

        <form className="search" onSubmit={onSearch}>
          <input
            placeholder={i.searchPlaceholder}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setError('')
            }}
            aria-label={i.searchPlaceholder}
          />
          <button type="submit">{i.searchBtn}</button>
          {error && <span className="search-error" role="alert">{error}</span>}
        </form>

        <div className="top-actions">
          <div className="seg" role="tablist" aria-label="View mode">
            <button
              type="button"
              role="tab"
              className={mode === 'network' ? 'active' : ''}
              onClick={() => {
                setMode('network')
                setRoleFilter('all')
                setExpandedIds(new Set())
                cameraKeyRef.current = ''
              }}
            >
              {i.navNetwork}
            </button>
            <button
              type="button"
              role="tab"
              className={mode === 'hunt' ? 'active' : ''}
              onClick={() => setMode('hunt')}
            >
              {i.navHunt}
            </button>
            <button
              type="button"
              role="tab"
              className={mode === 'priority' ? 'active' : ''}
              onClick={() => {
                setMode('priority')
                setRoleFilter('all')
                if (data.top?.[0]) {
                  setTreeRootId(data.top[0].gid)
                  setSelectedId(data.top[0].gid)
                }
                cameraKeyRef.current = ''
              }}
            >
              {i.navPriority}
            </button>
            <button
              type="button"
              role="tab"
              className={mode === 'cluster' ? 'active' : ''}
              onClick={() => {
                setMode('cluster')
                setRoleFilter('all')
                const cluster = data.clusters.find(
                  (item) => String(item.cluster_id) === String(selectedCluster),
                )
                const gid = cluster?.top_gids?.[0]
                if (gid) reRootTree(String(gid))
              }}
            >
              {i.navClusters}
            </button>
            <button
              type="button"
              role="tab"
              className={mode === 'ledger' ? 'active' : ''}
              onClick={() => setMode('ledger')}
            >
              {i.navLedger}
            </button>
          </div>
          <span className="chip chip-period">{i.period}</span>
          <div className="lang-toggle" role="group" aria-label="Language">
            <button
              type="button"
              className={locale === 'ru' ? 'active' : ''}
              onClick={() => setLocale('ru')}
            >
              {i.langRu}
            </button>
            <button
              type="button"
              className={locale === 'en' ? 'active' : ''}
              onClick={() => setLocale('en')}
            >
              {i.langEn}
            </button>
          </div>
          <div className="avatar" title={i.avatarTitle}>
            AML
          </div>
        </div>
      </header>

      {mode === 'ledger' ? (
        <LedgerPage
          data={data}
          locale={locale}
          labels={i.ledger}
          selectedId={selectedId}
          onSelect={(id) => setSelectedId(id)}
          onOpenOnGraph={(id) => {
            setMode('hunt')
            setRoleFilter('all')
            reRootTree(id)
          }}
        />
      ) : (
      <div className="workspace">
        <aside className="side">
          <div className="side-head">{i.sideHead}</div>
          <div className="graph-filters">
            <label>
              <span>{i.depthFilter}</span>
              <select value={depthFilter} onChange={(e) => setDepthFilter(e.target.value)}>
                <option value="all">{i.filterAll}</option>
                {[0, 1, 2, 3, 4].map((depth) => (
                  <option key={depth} value={depth}>{depth}</option>
                ))}
              </select>
            </label>
            <label>
              <span>{i.seedFilter}</span>
              <select value={seedFilter} onChange={(e) => setSeedFilter(e.target.value)}>
                <option value="all">{i.filterAll}</option>
                <option value="seed">{i.onlySeed}</option>
                <option value="nonseed">{i.withoutSeed}</option>
              </select>
            </label>
          </div>
          {mode === 'cluster' && (
            <div className="cluster-picker">
              <label htmlFor="cluster-select">{i.clusterSelect}</label>
              <select
                id="cluster-select"
                value={selectedCluster}
                onChange={(e) => {
                  const value = e.target.value
                  setSelectedCluster(value)
                  const cluster = data.clusters.find(
                    (item) => String(item.cluster_id) === value,
                  )
                  const gid = cluster?.top_gids?.[0]
                  if (gid) reRootTree(String(gid))
                }}
              >
                {data.clusters.map((cluster) => (
                  <option key={cluster.cluster_id} value={cluster.cluster_id}>
                    #{cluster.cluster_id} · {cluster.n_nodes} {i.nodesUnit}
                  </option>
                ))}
              </select>
              {data.clusters
                .filter((cluster) => String(cluster.cluster_id) === selectedCluster)
                .map((cluster) => (
                  <div className="cluster-summary" key={cluster.cluster_id}>
                    <b>{i.clusterSummary(cluster.n_nodes, cluster.n_seed)}</b>
                    <span>{formatKzt(cluster.sum_kzt_internal, locale)}</span>
                    <p>{cluster.hypothesis}</p>
                  </div>
                ))}
            </div>
          )}
          <ul className="role-list">
            <li>
              <button
                type="button"
                className={`role-item ${roleFilter === 'all' ? 'active' : ''}`}
                onClick={() => onRoleFilter('all')}
              >
                <div className="role-ico" style={{ background: 'var(--ff-green)' }}>
                  Σ
                </div>
                <div className="role-meta">
                  <strong>{i.allNetwork}</strong>
                  <span>{i.allNetworkHint}</span>
                </div>
                <div className="role-stats">
                  <b>{data.meta.n_nodes}</b>
                  <span className="trend up">{i.nodesUnit}</span>
                </div>
              </button>
            </li>
            {roleCards.map((c) => (
              <li key={c.role}>
                <button
                  type="button"
                  className={`role-item ${roleFilter === c.role ? 'active' : ''}`}
                  onClick={() => onRoleFilter(c.role)}
                  title={i.roleTooltips[c.role]}
                >
                  <div
                    className="role-ico"
                    style={{ background: ROLE_COLOR[c.role] }}
                    title={i.roleTooltips[c.role]}
                  >
                    {c.role.slice(0, 1).toUpperCase()}
                  </div>
                  <div className="role-meta">
                    <strong className="role-name">
                      {i.roles[c.role]}
                      <span
                        className="hint-dot"
                        title={i.roleTooltips[c.role]}
                        aria-label={i.roleTooltips[c.role]}
                      >
                        ?
                      </span>
                    </strong>
                    <span>{i.roleHints[c.role]}</span>
                  </div>
                  <div className="role-stats">
                    <b>{c.count}</b>
                    <span className="share">{c.share.toFixed(1)}%</span>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </aside>

        <main className="canvas">
          <div className="graph-badge">
            {i.graphShown(graphData.nodes.length, graphData.links.length)}
            {error ? ` · ${error}` : ''}
          </div>
          <div className="zoom">
            <button type="button" onClick={() => zoomBy(1.25)} aria-label="zoom in">
              +
            </button>
            <button type="button" onClick={() => zoomBy(0.8)} aria-label="zoom out">
              −
            </button>
          </div>
          <div className="graph-host" ref={graphHostRef}>
            {graphSize.width > 0 && graphSize.height > 0 && (
              <ForceGraph2D
                ref={fgRef}
                width={graphSize.width}
                height={graphSize.height}
                graphData={graphData}
                nodeId="id"
                linkDirectionalArrowLength={4}
                linkDirectionalArrowRelPos={1}
                linkWidth={(l) =>
                  Math.max(1.3, Math.log10((l.sum_kzt || 1) + 1) * 0.65)
                }
                linkColor={() => 'rgba(22, 71, 52, 0.4)'}
                backgroundColor="rgba(0,0,0,0)"
                enableNodeDrag={false}
                enableZoomInteraction
                enablePanInteraction
                cooldownTicks={0}
                warmupTicks={0}
                d3AlphaDecay={1}
                d3VelocityDecay={1}
                nodeCanvasObject={(node, ctx, globalScale) => {
                  const hot =
                    node.role === 'consolidator' ||
                    node.role === 'coordinator' ||
                    node.role === 'distributor'
                  const isSelected = node.id === selectedId
                  const isRoot = node._isRoot
                  const r = Math.max(
                    5,
                    3 +
                      10 * (node.priority_score || 0) +
                      (node.is_seed ? 2 : 0) +
                      (isSelected || isRoot ? 3.5 : 0) +
                      (hot ? 1 : 0),
                  )

                  if (isSelected || isRoot) {
                    ctx.beginPath()
                    ctx.arc(node.x, node.y, r + 7, 0, 2 * Math.PI)
                    ctx.fillStyle = isSelected
                      ? 'rgba(2, 177, 64, 0.16)'
                      : 'rgba(14, 21, 28, 0.06)'
                    ctx.fill()
                  }

                  ctx.beginPath()
                  ctx.arc(node.x, node.y, r, 0, 2 * Math.PI)
                  ctx.fillStyle = ROLE_COLOR[node.role] || '#888'
                  ctx.fill()
                  if (isSelected || isRoot || hot) {
                    ctx.strokeStyle = isSelected
                      ? '#0e151c'
                      : isRoot
                        ? '#164734'
                        : 'rgba(2,177,64,0.65)'
                    ctx.lineWidth = (isSelected || isRoot ? 2 : 1) / globalScale
                    ctx.stroke()
                  }
                  if (
                    globalScale > 1.05 ||
                    isSelected ||
                    isRoot ||
                    node.priority_score > 0.55
                  ) {
                    ctx.font = `${(isSelected || isRoot ? 12 : 10) / globalScale}px Montserrat`
                    ctx.fillStyle = '#0e151c'
                    ctx.fillText(String(node.id).slice(-6), node.x + r + 3, node.y + 3)
                  }
                  // Hint: node has transaction counterparties not yet shown
                  if (node._hasMoreTx && !isRoot) {
                    const br = 5.5 / Math.max(globalScale, 0.7)
                    ctx.beginPath()
                    ctx.arc(node.x + r * 0.65, node.y - r * 0.65, br, 0, 2 * Math.PI)
                    ctx.fillStyle = '#fff'
                    ctx.fill()
                    ctx.strokeStyle = 'var(--ff-green)'
                    ctx.strokeStyle = '#02b140'
                    ctx.lineWidth = 1.2 / globalScale
                    ctx.stroke()
                    ctx.font = `bold ${9 / globalScale}px Montserrat`
                    ctx.fillStyle = '#02b140'
                    ctx.textAlign = 'center'
                    ctx.textBaseline = 'middle'
                    ctx.fillText('+', node.x + r * 0.65, node.y - r * 0.65 + 0.5)
                    ctx.textAlign = 'left'
                    ctx.textBaseline = 'alphabetic'
                  }
                }}
                onNodeClick={onNodeClick}
              />
            )}
          </div>
        </main>

        <aside className="side right">
          <div className="panel-block">
            <h2>{i.clientCard}</h2>
            {!selected ? (
              <div className="sub">{i.clientEmpty}</div>
            ) : (
              <>
                <div className="client-id" title={selected.id}>
                  {selected.id}
                </div>
                <div className="sub">
                  {i.roles[selected.role] || selected.role}
                  {selected.is_seed ? ` · ${i.seed}` : ''}
                  {' · '}
                  {i.depth} {selected.depth}
                  {' · '}
                  {i.cluster} #{selected.cluster_id}
                </div>
                <div className="score-row">
                  <span title={i.roleScoreHint}>{i.roleScore}: <b>{(selected.role_score || 0).toFixed(2).replace('.', locale === 'ru' ? ',' : '.')}</b></span>
                  <span>{i.priorityScore}: <b>{((selected.priority_score || 0) * 100).toFixed(0)}%</b></span>
                </div>

                <div className="money-grid">
                  <div className="money-card in">
                    <span>{i.received}</span>
                    <b>{formatKzt(selected.in_kzt, locale)}</b>
                    <em>{i.payers(selected.in_deg)}</em>
                  </div>
                  <div className="money-card out">
                    <span>{i.sent}</span>
                    <b>{formatKzt(selected.out_kzt, locale)}</b>
                    <em>{i.recipients(selected.out_deg)}</em>
                  </div>
                  <div className="money-card net">
                    <span>{i.balance}</span>
                    <b>{formatKzt(selected.in_kzt - selected.out_kzt, locale)}</b>
                    <em>
                      {i.txPriority(
                        history.length,
                        (selected.priority_score * 100).toFixed(0),
                      )}
                    </em>
                  </div>
                </div>

                <div className="evidence-box">
                  <strong>{i.hypothesisLabel}</strong>
                  <span>{selected.evidence}</span>
                </div>

                {nodeCard?.gid === selectedId && nodeCard.attention?.length > 0 && (
                  <div className="api-insights attention-block">
                    <h3>{i.attentionTitle}</h3>
                    {nodeCard.attention.map((item, index) => (
                      <p key={`${item.text}-${index}`}>{item.text}</p>
                    ))}
                  </div>
                )}

                {nodeCard?.gid === selectedId && nodeCard.data_gaps?.length > 0 && (
                  <div className="api-insights gaps-block">
                    <h3>{i.dataGapsTitle}</h3>
                    {nodeCard.data_gaps.map((item, index) => (
                      <div className="data-gap" key={`${item.gap}-${index}`}>
                        <p>{item.gap}</p>
                        <span>{i.nextRequest}: {item.next_request}</span>
                      </div>
                    ))}
                  </div>
                )}

                {(selected.flags?.length > 0 || selected.truncated_by_depth) && (
                  <div className="quality-flags">
                    <h3>{i.dataQuality}</h3>
                    {[...new Set([
                      ...(selected.flags || []),
                      ...(selected.truncated_by_depth ? ['truncated_by_depth'] : []),
                    ])].map((flag) => (
                      <div className="quality-flag" key={flag}>
                        {i.flagLabels[flag] || flag}
                      </div>
                    ))}
                  </div>
                )}

                <div className="tx-block">
                  <h3>
                    {i.txHistory}
                    <span>{i.txCount(history.length)}</span>
                  </h3>
                  {history.length === 0 ? (
                    <div className="sub">{i.txEmpty}</div>
                  ) : (
                    <div className="tx-scroll">
                      <table className="tx-table">
                        <thead>
                          <tr>
                            <th>{i.colDate}</th>
                            <th>{i.colType}</th>
                            <th>{i.colCounterparty}</th>
                            <th>{i.colAmount}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {history.map((t, idx) => (
                            <tr key={`${t.date}-${t.counterparty}-${idx}`}>
                              <td>{t.date.slice(5)}</td>
                              <td>
                                <span className={`tx-dir ${t.dir}`}>
                                  {t.dir === 'in' ? i.txIn : i.txOut}
                                </span>
                              </td>
                              <td>
                                <button
                                  type="button"
                                  className="tx-cp"
                                  onClick={() => selectNode(t.counterparty)}
                                  title={t.counterparty}
                                >
                                  …{t.counterparty.slice(-8)}
                                </button>
                              </td>
                              <td className={t.dir === 'in' ? 'sum-in' : 'sum-out'}>
                                {t.dir === 'in' ? '+' : '−'}
                                {formatKzt(t.sum_kzt, locale)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>

                {(neighbors.in.length > 0 || neighbors.out.length > 0) && (
                  <div className="neighbors">
                    <h3>{i.linkAgg}</h3>
                    {neighbors.in.map((n) => (
                      <button
                        key={`i-${n.id}`}
                        type="button"
                        onClick={() => selectNode(n.id)}
                      >
                        ← …{n.id.slice(-8)} · {n.n_tx} tx · {formatKzt(n.sum_kzt, locale)}
                      </button>
                    ))}
                    {neighbors.out.map((n) => (
                      <button
                        key={`o-${n.id}`}
                        type="button"
                        onClick={() => selectNode(n.id)}
                      >
                        → …{n.id.slice(-8)} · {n.n_tx} tx · {formatKzt(n.sum_kzt, locale)}
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>

          <div className="panel-block">
            <h2>{i.priorityRank}</h2>
            <div className="sub">{i.prioritySub}</div>
            <table className="rank-table">
              <thead>
                <tr>
                  <th>{i.colRank}</th>
                  <th>{i.colClient}</th>
                  <th>{i.colScore}</th>
                  <th>{i.colInDeg}</th>
                </tr>
              </thead>
              <tbody>
                {data.top.slice(0, 30).map((t) => (
                  <tr
                    key={t.gid}
                    className={t.gid === selectedId ? 'active' : ''}
                    onClick={() => reRootTree(t.gid)}
                  >
                    <td>{t.rank}</td>
                    <td>
                      <div className="gid">…{t.gid.slice(-8)}</div>
                      <span
                        className="role-pill"
                        style={{ color: ROLE_COLOR[t.role] }}
                        title={i.roleTooltips[t.role]}
                      >
                        {i.roles[t.role] || t.role}
                      </span>
                    </td>
                    <td>{(t.priority_score * 100).toFixed(0)}</td>
                    <td>{t.in_deg ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </aside>
      </div>
      )}

      <CopilotPanel
        selectedId={selectedId}
        locale={locale}
        labels={i.copilot}
        onOpenGid={(gid) => {
          setRoleFilter('all')
          if (mode === 'ledger') {
            setSelectedId(gid)
          } else {
            reRootTree(gid)
          }
        }}
      />
    </div>
  )
}
