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

const MAX_CHILDREN = 6
const LEVEL_GAP = 110
const SIBLING_GAP = 72

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
      if (frontier.has(s)) {
        next.add(t)
        keep.add(t)
      }
      if (frontier.has(t)) {
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

function buildPriorityGraph(data, limit = 60) {
  const topIds = new Set(data.top.slice(0, limit).map((t) => t.gid))
  const keep = new Set(topIds)
  for (const link of data.links) {
    if (topIds.has(link.source)) keep.add(link.target)
    if (topIds.has(link.target)) keep.add(link.source)
  }
  const ranked = data.nodes
    .filter((n) => keep.has(n.id))
    .sort((a, b) => b.priority_score - a.priority_score)
    .slice(0, 320)
  const ids = new Set(ranked.map((n) => n.id))
  return {
    nodes: ranked.map((n) => ({ ...n })),
    links: data.links
      .filter((l) => ids.has(l.source) && ids.has(l.target))
      .map((l) => ({ ...l })),
  }
}

/** Adjacency for undirected traversal over directed money links */
function buildAdj(links) {
  const adj = new Map()
  const add = (a, b, sum) => {
    if (!adj.has(a)) adj.set(a, [])
    adj.get(a).push({ id: b, sum_kzt: sum || 0 })
  }
  for (const l of links) {
    const s = linkId(l.source)
    const t = linkId(l.target)
    add(s, t, l.sum_kzt)
    add(t, s, l.sum_kzt)
  }
  for (const list of adj.values()) {
    list.sort((a, b) => b.sum_kzt - a.sum_kzt)
  }
  return adj
}

/**
 * Hierarchical tree from root: level 0 = root (top), then BFS layers.
 * Excess children collapse into a synthetic branch node unless expanded.
 */
function layoutTreeGraph(subgraph, rootId, expanded, collapsedLabel) {
  if (!subgraph.nodes.length) return { nodes: [], links: [], treeLinks: new Set() }

  const nodeMap = new Map(subgraph.nodes.map((n) => [n.id, { ...n }]))
  if (!nodeMap.has(rootId)) {
    const fallback = subgraph.nodes
      .slice()
      .sort((a, b) => (b.priority_score || 0) - (a.priority_score || 0))[0]
    if (!fallback) return { nodes: [], links: [], treeLinks: new Set() }
    rootId = fallback.id
  }

  const adj = buildAdj(subgraph.links)
  const parentOf = new Map()
  const childrenOf = new Map()
  const depthOf = new Map([[rootId, 0]])
  const visited = new Set([rootId])
  const queue = [rootId]

  while (queue.length) {
    const u = queue.shift()
    const depth = depthOf.get(u)
    const neigh = (adj.get(u) || []).filter((n) => !visited.has(n.id) && nodeMap.has(n.id))
    const isExpanded = expanded.has(u)
    const visible = isExpanded ? neigh : neigh.slice(0, MAX_CHILDREN)
    const hidden = isExpanded ? [] : neigh.slice(MAX_CHILDREN)

    childrenOf.set(u, [])
    for (const n of visible) {
      visited.add(n.id)
      parentOf.set(n.id, u)
      depthOf.set(n.id, depth + 1)
      childrenOf.get(u).push(n.id)
      queue.push(n.id)
    }

    if (hidden.length > 0) {
      const cid = `__collapsed__${u}`
      const collapsedNode = {
        id: cid,
        role: 'peripheral',
        priority_score: 0,
        is_seed: false,
        depth: depth + 1,
        cluster_id: -1,
        _collapsed: true,
        _parent: u,
        _hiddenIds: hidden.map((h) => h.id),
        _count: hidden.length,
        label: collapsedLabel(hidden.length),
      }
      nodeMap.set(cid, collapsedNode)
      parentOf.set(cid, u)
      depthOf.set(cid, depth + 1)
      childrenOf.get(u).push(cid)
      visited.add(cid)
    }
  }

  // Drop nodes not reachable from the root — keeps the hierarchy readable
  for (const id of [...nodeMap.keys()]) {
    if (!depthOf.has(id) && !String(id).startsWith('__collapsed__')) {
      nodeMap.delete(id)
    }
  }

  // Leaf-order for tidy horizontal placement
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
  leafOrder.forEach((id, i) => xOf.set(id, i * SIBLING_GAP))

  function assignX(id) {
    if (xOf.has(id)) return xOf.get(id)
    const kids = childrenOf.get(id) || []
    if (!kids.length) {
      const x = (xOf.size || 0) * SIBLING_GAP
      xOf.set(id, x)
      return x
    }
    const xs = kids.map(assignX)
    const x = (Math.min(...xs) + Math.max(...xs)) / 2
    xOf.set(id, x)
    return x
  }
  assignX(rootId)

  // Center tree around x=0
  const xs = [...xOf.values()]
  const mid = xs.length ? (Math.min(...xs) + Math.max(...xs)) / 2 : 0

  const treeLinks = new Set()
  const positioned = []
  for (const [id, depth] of depthOf) {
    const n = nodeMap.get(id)
    if (!n) continue
    const x = (xOf.get(id) ?? 0) - mid
    const y = depth * LEVEL_GAP
    n.fx = x
    n.fy = y
    n._treeDepth = depth
    n._isRoot = id === rootId
    positioned.push(n)
    const p = parentOf.get(id)
    if (p != null) treeLinks.add(`${p}|${id}`)
  }

  // Keep original money links among real nodes + tree edges to collapsed
  const realIds = new Set(positioned.filter((n) => !n._collapsed).map((n) => n.id))
  const links = []
  for (const l of subgraph.links) {
    const s = linkId(l.source)
    const t = linkId(l.target)
    if (realIds.has(s) && realIds.has(t)) {
      links.push({
        ...l,
        source: s,
        target: t,
        _tree: treeLinks.has(`${s}|${t}`) || treeLinks.has(`${t}|${s}`),
      })
    }
  }
  for (const [id, p] of parentOf) {
    const child = nodeMap.get(id)
    if (child?._collapsed) {
      links.push({
        source: p,
        target: id,
        sum_kzt: 0,
        n_tx: 0,
        _tree: true,
        _collapsedEdge: true,
      })
    }
  }

  return { nodes: positioned, links, treeLinks, rootId }
}

export default function App() {
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [roleFilter, setRoleFilter] = useState('all')
  const [selectedId, setSelectedId] = useState(null)
  const [mode, setMode] = useState('network')
  const [dayIdx, setDayIdx] = useState(0)
  const [graphSize, setGraphSize] = useState({ width: 0, height: 0 })
  const [locale, setLocale] = useState(() => {
    try {
      return localStorage.getItem('aml-locale') === 'en' ? 'en' : 'ru'
    } catch {
      return 'ru'
    }
  })
  const [expanded, setExpanded] = useState(() => new Set())
  const fgRef = useRef()
  const graphHostRef = useRef(null)
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
        if (json.top?.[0]) setSelectedId(json.top[0].gid)
        if (json.timeseries?.length) setDayIdx(Math.min(16, json.timeseries.length - 1))
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
    return ROLE_ORDER.map((role, i) => {
      const count = data.meta.roles?.[role] || 0
      const share = (count / total) * 100
      const delta = Number((((share % 7) - 3.2) * (i % 2 === 0 ? 1 : -1)).toFixed(1))
      return { role, count, delta }
    })
  }, [data])

  const rootId = selectedId || data?.top?.[0]?.gid

  const graphData = useMemo(() => {
    if (!data || !rootId) return { nodes: [], links: [] }
    let g =
      mode === 'hunt'
        ? buildEgoGraph(data, rootId, 2)
        : buildPriorityGraph(data, 55)

    if (roleFilter !== 'all') {
      const ids = new Set(g.nodes.filter((n) => n.role === roleFilter).map((n) => n.id))
      ids.add(rootId)
      g = {
        nodes: g.nodes.filter((n) => ids.has(n.id)),
        links: g.links.filter(
          (l) => ids.has(linkId(l.source)) && ids.has(linkId(l.target)),
        ),
      }
    }

    return layoutTreeGraph(g, rootId, expanded, i.collapsedBranch)
  }, [data, mode, rootId, roleFilter, expanded, i])

  useEffect(() => {
    const fg = fgRef.current
    if (!fg || !graphSize.width || !graphSize.height) return
    const t = setTimeout(() => {
      fg.zoomToFit(400, 64)
    }, 120)
    return () => clearTimeout(t)
  }, [
    graphData.nodes.length,
    graphData.links.length,
    graphSize.width,
    graphSize.height,
    mode,
    roleFilter,
    rootId,
    expanded,
  ])

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

  const focusNode = useCallback((id) => {
    if (String(id).startsWith('__collapsed__')) return
    setSelectedId(id)
    setMode('hunt')
    setExpanded(new Set())
  }, [])

  const onNodeClick = useCallback(
    (node) => {
      if (node._collapsed) {
        setExpanded((prev) => {
          const next = new Set(prev)
          next.add(node._parent)
          return next
        })
        return
      }
      focusNode(node.id)
    },
    [focusNode],
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
      focusNode(hit.id)
    } else setError(i.notFound(q))
  }

  const zoomBy = (factor) => {
    const fg = fgRef.current
    if (!fg) return
    fg.zoom(fg.zoom() * factor, 300)
  }

  if (error && !data) return <div className="error">{error}</div>
  if (!data) return <div className="loading">{i.loading}</div>

  const day = data.timeseries?.[dayIdx]
  const realNodeCount = graphData.nodes.filter((n) => !n._collapsed).length

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
                setExpanded(new Set())
              }}
            >
              {i.navNetwork}
            </button>
            <button
              type="button"
              role="tab"
              className={mode === 'hunt' ? 'active' : ''}
              onClick={() => selectedId && setMode('hunt')}
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
                if (data.top?.[0]) setSelectedId(data.top[0].gid)
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
                onClick={() => setRoleFilter('all')}
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
                  onClick={() => setRoleFilter(c.role)}
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
            {i.graphShown(realNodeCount, graphData.links.filter((l) => !l._collapsedEdge).length)}
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
                linkDirectionalArrowLength={(l) => (l._collapsedEdge ? 0 : 3.2)}
                linkDirectionalArrowRelPos={1}
                linkWidth={(l) =>
                  l._collapsedEdge
                    ? 1.2
                    : Math.max(0.35, Math.log10((l.sum_kzt || 1) + 1) * 0.55)
                }
                linkColor={(l) =>
                  l._collapsedEdge
                    ? 'rgba(107, 117, 133, 0.45)'
                    : l._tree
                      ? 'rgba(107, 117, 133, 0.45)'
                      : 'rgba(107, 117, 133, 0.18)'
                }
                linkLineDash={(l) => (l._collapsedEdge ? [4, 3] : null)}
                backgroundColor="rgba(0,0,0,0)"
                enableNodeDrag={false}
                cooldownTicks={0}
                d3AlphaDecay={1}
                nodeCanvasObject={(node, ctx, globalScale) => {
                  if (node._collapsed) {
                    const r = 14
                    ctx.beginPath()
                    ctx.arc(node.x, node.y, r, 0, 2 * Math.PI)
                    ctx.fillStyle = '#eef2f6'
                    ctx.fill()
                    ctx.strokeStyle = '#6b7585'
                    ctx.lineWidth = 1.2 / globalScale
                    ctx.setLineDash([3 / globalScale, 2 / globalScale])
                    ctx.stroke()
                    ctx.setLineDash([])
                    ctx.font = `${11 / globalScale}px Montserrat`
                    ctx.fillStyle = '#6b7585'
                    ctx.textAlign = 'center'
                    ctx.textBaseline = 'middle'
                    ctx.fillText(node.label || `+${node._count}`, node.x, node.y)
                    ctx.textAlign = 'left'
                    ctx.textBaseline = 'alphabetic'
                    return
                  }

                  const hot =
                    node.role === 'consolidator' ||
                    node.role === 'coordinator' ||
                    node.role === 'distributor'
                  const isFocus = node.id === selectedId || node._isRoot
                  const r =
                    2.2 +
                    11 * (node.priority_score || 0) +
                    (node.is_seed ? 2 : 0) +
                    (isFocus ? 4 : 0) +
                    (hot ? 1.2 : 0)

                  if (isFocus) {
                    ctx.beginPath()
                    ctx.arc(node.x, node.y, r + 6, 0, 2 * Math.PI)
                    ctx.fillStyle = 'rgba(2, 177, 64, 0.12)'
                    ctx.fill()
                  }

                  ctx.beginPath()
                  ctx.arc(node.x, node.y, r, 0, 2 * Math.PI)
                  ctx.fillStyle = ROLE_COLOR[node.role] || '#888'
                  ctx.fill()
                  if (isFocus || hot) {
                    ctx.strokeStyle = isFocus ? '#0e151c' : 'rgba(2,177,64,0.7)'
                    ctx.lineWidth = (isFocus ? 2 : 1) / globalScale
                    ctx.stroke()
                  }
                  if (globalScale > 1.1 || isFocus || node.priority_score > 0.62) {
                    ctx.font = `${(isFocus ? 12 : 10) / globalScale}px Montserrat`
                    ctx.fillStyle = '#0e151c'
                    ctx.fillText(
                      String(node.id).slice(-6),
                      node.x + r + 3,
                      node.y + 3,
                    )
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
                                  onClick={() => focusNode(t.counterparty)}
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
                      <button key={`i-${n.id}`} type="button" onClick={() => focusNode(n.id)}>
                        ← …{n.id.slice(-8)} · {n.n_tx} tx · {formatKzt(n.sum_kzt, locale)}
                      </button>
                    ))}
                    {neighbors.out.map((n) => (
                      <button key={`o-${n.id}`} type="button" onClick={() => focusNode(n.id)}>
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
                      onClick={() => focusNode(t.gid)}
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

      <footer className="timeline">
        <div className="timeline-label">
          {i.slice}&nbsp;
          <strong>{day?.day || '2026-07'}</strong>
        </div>
        <div className="track">
          <div className="track-line" />
          <div className="months">
            {[i.periodJul, '', '', '', '', '', '', '', '', '', '', i.periodAug].map(
              (m, idx) => (
                <span key={idx}>{m}</span>
              ),
            )}
          </div>
          <input
            type="range"
            min={0}
            max={Math.max((data.timeseries?.length || 1) - 1, 0)}
            value={dayIdx}
            onChange={(e) => setDayIdx(Number(e.target.value))}
          />
        </div>
        <div className="timeline-label" style={{ textAlign: 'right' }}>
          {day ? formatKzt(day.sum_kzt, locale) : '—'}
        </div>
      </footer>
    </div>
  )
}
