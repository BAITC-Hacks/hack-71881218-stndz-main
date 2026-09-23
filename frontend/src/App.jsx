import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ForceGraph2D from 'react-force-graph-2d'
import { LOCALES } from './i18n'
import './App.css'

const ROLE_COLOR = {
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
  'peripheral',
]

const MAX_DEPTH = 4
const MAX_NODES = 80
const LEVEL_GAP = 150
const SIBLING_GAP = 92

function formatKzt(n, locale) {
  if (n == null || Number.isNaN(n)) return '—'
  const loc = locale === 'en' ? 'en-US' : 'ru-RU'
  if (n >= 1_000_000) {
    const v = (n / 1_000_000).toFixed(1)
    return locale === 'en' ? `${v}M ₸` : `${v} млн ₸`
  }
  return new Intl.NumberFormat(loc, { maximumFractionDigits: 0 }).format(n) + ' ₸'
}

function formatPct(n) {
  const sign = n >= 0 ? '+' : ''
  return `${sign}${n.toFixed(1)}%`
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
 * Hierarchical tree — real nodes only (no collapsed / synthetic nodes).
 */
function layoutTreeGraph(subgraph, rootId, opts = {}) {
  const maxDepth = opts.maxDepth ?? MAX_DEPTH
  const levelGap = opts.levelGap ?? LEVEL_GAP
  const siblingGap = opts.siblingGap ?? SIBLING_GAP
  const maxNodes = opts.maxNodes ?? MAX_NODES

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

  // Drop unreachable nodes — only BFS tree members
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
    positioned.push(n)
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
  const [selectedId, setSelectedId] = useState(null)
  /** Stable tree root — only changes on search / rank / explicit re-root */
  const [treeRootId, setTreeRootId] = useState(null)
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
        setData(json)
        const first = json.top?.[0]?.gid
        if (first) {
          setSelectedId(first)
          setTreeRootId(first)
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

  const roleCards = useMemo(() => {
    if (!data) return []
    const total = data.meta.n_nodes || 1
    return ROLE_ORDER.map((role, idx) => {
      const count = data.meta.roles?.[role] || 0
      const share = (count / total) * 100
      const delta = Number((((share % 7) - 3.2) * (idx % 2 === 0 ? 1 : -1)).toFixed(1))
      return { role, count, delta }
    })
  }, [data])

  const effectiveRoot =
    treeRootId || selectedId || data?.top?.[0]?.gid || null

  const graphData = useMemo(() => {
    if (!data || !effectiveRoot) return { nodes: [], links: [], rootId: null }

    let subgraph
    let root = effectiveRoot

    if (roleFilter !== 'all') {
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

    return layoutTreeGraph(subgraph, root, {
      maxDepth: MAX_DEPTH,
      maxNodes: MAX_NODES,
      levelGap: LEVEL_GAP,
      siblingGap: SIBLING_GAP,
    })
  }, [data, effectiveRoot, roleFilter, mode])

  // Recenter only when tree structure changes (root / filter / mode), not on node select
  useEffect(() => {
    const fg = fgRef.current
    if (!fg || !graphSize.width || !graphSize.height) return
    if (!graphData.nodes.length) return

    const key = `${graphData.rootId}|${roleFilter}|${mode}|${graphData.nodes.length}`
    if (cameraKeyRef.current === key) return
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
  }, [graphData, graphSize.width, graphSize.height, roleFilter, mode])

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

  /** Select node without rebuilding the tree */
  const selectNode = useCallback(
    (id, { pan = true } = {}) => {
      setSelectedId(id)
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
    [graphSize.height],
  )

  /** Re-root the tree (search / ranking / explicit) */
  const reRootTree = useCallback((id) => {
    setTreeRootId(id)
    setSelectedId(id)
    setMode('hunt')
    cameraKeyRef.current = ''
  }, [])

  const onNodeClick = useCallback(
    (node) => {
      // Keep tree structure — only update selection + gentle pan
      selectNode(node.id, { pan: true })
    },
    [selectNode],
  )

  const onRoleFilter = useCallback(
    (role) => {
      setRoleFilter(role)
      cameraKeyRef.current = ''
      if (role === 'all') return
      // Keep current selection if it matches the role; else pick top of role
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
    const hit =
      data.nodes.find((n) => n.id === q) ||
      data.nodes.find((n) => n.id.endsWith(q)) ||
      data.nodes.find((n) => n.id.includes(q))
    if (hit) {
      setError('')
      setRoleFilter('all')
      reRootTree(hit.id)
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

      <div className="workspace">
        <aside className="side">
          <div className="side-head">{i.sideHead}</div>
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
                    <span className={`trend ${c.delta >= 0 ? 'up' : 'down'}`}>
                      {c.delta >= 0 ? '↗' : '↘'} {formatPct(c.delta)}
                    </span>
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

                <div className="evidence-box">{selected.evidence}</div>

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
                  <th>{i.colDelta}</th>
                </tr>
              </thead>
              <tbody>
                {data.top.slice(0, 8).map((t) => {
                  const delta = Number((((t.priority_score * 17) % 5) - 1.5).toFixed(2))
                  return (
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
                      <td className={`trend ${delta >= 0 ? 'up' : 'down'}`}>
                        {delta >= 0 ? '+' : ''}
                        {delta}%
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </aside>
      </div>
    </div>
  )
}
