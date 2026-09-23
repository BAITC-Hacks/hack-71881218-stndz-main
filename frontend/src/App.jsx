import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ForceGraph2D from 'react-force-graph-2d'
import './App.css'

const ROLE_COLOR = {
  consolidator: '#d64545',
  coordinator: '#c4a35a',
  distributor: '#d97b3d',
  transit: '#3d7ea6',
  terminal: '#3d9b6e',
  peripheral: '#6b7a72',
}

const ROLE_LABEL = {
  consolidator: 'консолидатор',
  coordinator: 'координатор',
  distributor: 'распределитель',
  transit: 'транзит',
  terminal: 'конечный',
  peripheral: 'периферия',
}

function formatKzt(n) {
  if (n == null || Number.isNaN(n)) return '—'
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(n) + ' ₸'
}

function buildEgoGraph(data, centerId, hop = 1) {
  const nodeMap = new Map(data.nodes.map((n) => [n.id, n]))
  if (!nodeMap.has(centerId)) return { nodes: [], links: [] }

  const keep = new Set([centerId])
  let frontier = new Set([centerId])
  for (let h = 0; h < hop; h++) {
    const next = new Set()
    for (const link of data.links) {
      if (frontier.has(link.source) || frontier.has(link.source?.id)) {
        const t = typeof link.target === 'object' ? link.target.id : link.target
        next.add(t)
        keep.add(t)
      }
      if (frontier.has(link.target) || frontier.has(link.target?.id)) {
        const s = typeof link.source === 'object' ? link.source.id : link.source
        next.add(s)
        keep.add(s)
      }
    }
    frontier = next
  }

  // если эго слишком маленькое — добавим топ соседей уже есть
  const nodes = [...keep]
    .map((id) => nodeMap.get(id))
    .filter(Boolean)
    .map((n) => ({ ...n }))
  const links = data.links
    .filter((l) => keep.has(l.source) && keep.has(l.target))
    .map((l) => ({ ...l }))
  return { nodes, links }
}

function buildPriorityGraph(data, limit = 80) {
  const topIds = new Set(data.top.slice(0, limit).map((t) => t.gid))
  const keep = new Set(topIds)
  for (const link of data.links) {
    if (topIds.has(link.source)) keep.add(link.target)
    if (topIds.has(link.target)) keep.add(link.source)
  }
  // кап
  const ranked = data.nodes
    .filter((n) => keep.has(n.id))
    .sort((a, b) => b.priority_score - a.priority_score)
    .slice(0, 350)
  const ids = new Set(ranked.map((n) => n.id))
  return {
    nodes: ranked.map((n) => ({ ...n })),
    links: data.links
      .filter((l) => ids.has(l.source) && ids.has(l.target))
      .map((l) => ({ ...l })),
  }
}

export default function App() {
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [roleFilter, setRoleFilter] = useState('all')
  const [selectedId, setSelectedId] = useState(null)
  const [mode, setMode] = useState('priority') // priority | ego
  const fgRef = useRef()

  useEffect(() => {
    fetch('/data/graph.json')
      .then((r) => {
        if (!r.ok) throw new Error('Нет graph.json — сначала: python pipeline.py')
        return r.json()
      })
      .then((json) => {
        setData(json)
        if (json.top?.[0]) setSelectedId(json.top[0].gid)
      })
      .catch((e) => setError(e.message))
  }, [])

  const selected = useMemo(() => {
    if (!data || !selectedId) return null
    return data.nodes.find((n) => n.id === selectedId) || null
  }, [data, selectedId])

  const graphData = useMemo(() => {
    if (!data) return { nodes: [], links: [] }
    let g =
      mode === 'ego' && selectedId
        ? buildEgoGraph(data, selectedId, 1)
        : buildPriorityGraph(data, 60)

    if (roleFilter !== 'all') {
      const ids = new Set(g.nodes.filter((n) => n.role === roleFilter).map((n) => n.id))
      // оставляем выбранный всегда
      if (selectedId) ids.add(selectedId)
      g = {
        nodes: g.nodes.filter((n) => ids.has(n.id)),
        links: g.links.filter((l) => ids.has(l.source) && ids.has(l.target)),
      }
    }
    return g
  }, [data, mode, selectedId, roleFilter])

  const neighbors = useMemo(() => {
    if (!data || !selectedId) return { in: [], out: [] }
    const nodeMap = new Map(data.nodes.map((n) => [n.id, n]))
    const inn = []
    const out = []
    for (const l of data.links) {
      if (l.target === selectedId) {
        const n = nodeMap.get(l.source)
        if (n) inn.push({ ...n, sum_kzt: l.sum_kzt })
      }
      if (l.source === selectedId) {
        const n = nodeMap.get(l.target)
        if (n) out.push({ ...n, sum_kzt: l.sum_kzt })
      }
    }
    inn.sort((a, b) => b.sum_kzt - a.sum_kzt)
    out.sort((a, b) => b.sum_kzt - a.sum_kzt)
    return { in: inn.slice(0, 12), out: out.slice(0, 12) }
  }, [data, selectedId])

  const focusNode = useCallback(
    (id) => {
      setSelectedId(id)
      setMode('ego')
      const node = graphData.nodes.find((n) => n.id === id)
      // после перестройки графа — центрируем чуть позже
      setTimeout(() => {
        const fg = fgRef.current
        if (!fg) return
        const n = fg.graphData().nodes.find((x) => x.id === id)
        if (n) {
          fg.centerAt(n.x, n.y, 600)
          fg.zoom(3, 600)
        }
      }, 400)
      void node
    },
    [graphData.nodes],
  )

  const onSearch = (e) => {
    e.preventDefault()
    const q = query.trim()
    if (!q || !data) return
    const hit =
      data.nodes.find((n) => n.id === q) ||
      data.nodes.find((n) => n.id.endsWith(q)) ||
      data.nodes.find((n) => n.id.includes(q))
    if (hit) focusNode(hit.id)
    else setError(`gid не найден: ${q}`)
  }

  if (error && !data) return <div className="error">{error}</div>
  if (!data) return <div className="loading">Загрузка графа…</div>

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <h1>Граф денег</h1>
          <span>AML · роли · кластеры · приоритеты проверки</span>
        </div>
        <form className="controls" onSubmit={onSearch}>
          <input
            placeholder="Поиск gid…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setError('')
            }}
          />
          <select value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)}>
            <option value="all">все роли</option>
            {Object.keys(ROLE_COLOR).map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
          <button type="submit">Найти</button>
          <button
            type="button"
            className="ghost"
            onClick={() => {
              setMode('priority')
              setRoleFilter('all')
            }}
          >
            Топ-сеть
          </button>
          <button
            type="button"
            className="ghost"
            onClick={() => selectedId && setMode('ego')}
          >
            Эго 1 hop
          </button>
        </form>
      </header>

      <div className="layout">
        <aside className="panel">
          <h2>Сводка</h2>
          <div className="legend">
            {Object.entries(ROLE_COLOR).map(([role, color]) => (
              <span key={role}>
                <i style={{ background: color }} />
                {ROLE_LABEL[role]}
              </span>
            ))}
          </div>
          <div className="stats">
            <div className="stat">
              <b>{data.meta.n_nodes}</b>
              <span>узлов</span>
            </div>
            <div className="stat">
              <b>{data.meta.n_edges}</b>
              <span>связей</span>
            </div>
            <div className="stat">
              <b>{data.meta.n_clusters}</b>
              <span>кластеров</span>
            </div>
            <div className="stat">
              <b>{data.top.length}</b>
              <span>в топе</span>
            </div>
          </div>

          <h2>Топ приоритетов</h2>
          <ul className="list">
            {data.top.map((t) => (
              <li
                key={t.gid}
                className={t.gid === selectedId ? 'active' : ''}
                onClick={() => focusNode(t.gid)}
              >
                <span className="rank">#{t.rank}</span>
                <strong>…{t.gid.slice(-8)}</strong>
                <span
                  className="role"
                  style={{ color: ROLE_COLOR[t.role] || '#ccc' }}
                >
                  {t.role}
                </span>
                <span className="why">{t.why}</span>
              </li>
            ))}
          </ul>
        </aside>

        <main className="graph-wrap">
          <ForceGraph2D
            ref={fgRef}
            graphData={graphData}
            nodeId="id"
            linkDirectionalArrowLength={3.5}
            linkDirectionalArrowRelPos={1}
            linkWidth={(l) => Math.max(0.4, Math.log10((l.sum_kzt || 1) + 1) * 0.6)}
            linkColor={() => 'rgba(143, 163, 150, 0.35)'}
            backgroundColor="rgba(0,0,0,0)"
            nodeCanvasObject={(node, ctx, globalScale) => {
              const r =
                2.5 +
                10 * (node.priority_score || 0) +
                (node.is_seed ? 2 : 0) +
                (node.id === selectedId ? 3 : 0)
              ctx.beginPath()
              ctx.arc(node.x, node.y, r, 0, 2 * Math.PI, false)
              ctx.fillStyle = ROLE_COLOR[node.role] || '#888'
              ctx.fill()
              if (node.id === selectedId) {
                ctx.strokeStyle = '#e8efe9'
                ctx.lineWidth = 1.5 / globalScale
                ctx.stroke()
              }
              if (globalScale > 1.4 || node.id === selectedId || node.priority_score > 0.65) {
                ctx.font = `${11 / globalScale}px IBM Plex Sans`
                ctx.fillStyle = '#e8efe9'
                ctx.fillText(String(node.id).slice(-6), node.x + r + 2, node.y + 3)
              }
            }}
            onNodeClick={(node) => focusNode(node.id)}
            cooldownTicks={80}
          />
          <div className="hint">
            Стрелки = направление денег · клик по узлу = эго-граф 1 hop · поиск по gid
            {error ? ` · ${error}` : ''}
          </div>
        </main>

        <aside className="panel right">
          <h2>Карточка узла</h2>
          {!selected ? (
            <div className="empty">Выберите узел на графе или в топе</div>
          ) : (
            <div className="detail">
              <div className="gid">{selected.id}</div>
              <div>
                <span
                  className="role"
                  style={{ color: ROLE_COLOR[selected.role] }}
                >
                  {selected.role}
                </span>
                {selected.is_seed ? ' · seed' : ''}
                {selected.truncated_by_depth ? ' · обрыв depth=4' : ''}
              </div>
              <div className="meta">
                <div>
                  <span>priority</span>
                  {selected.priority_score.toFixed(3)}
                </div>
                <div>
                  <span>role_score</span>
                  {selected.role_score.toFixed(3)}
                </div>
                <div>
                  <span>in / out deg</span>
                  {selected.in_deg} / {selected.out_deg}
                </div>
                <div>
                  <span>cluster</span>
                  {selected.cluster_id}
                </div>
                <div>
                  <span>in KZT</span>
                  {formatKzt(selected.in_kzt)}
                </div>
                <div>
                  <span>out KZT</span>
                  {formatKzt(selected.out_kzt)}
                </div>
              </div>
              <div className="evidence">{selected.evidence}</div>

              <div className="neighbors">
                <h3>Входящие ({neighbors.in.length})</h3>
                {neighbors.in.map((n) => (
                  <button key={`in-${n.id}`} type="button" onClick={() => focusNode(n.id)}>
                    ← …{n.id.slice(-8)} · {n.role} · {formatKzt(n.sum_kzt)}
                  </button>
                ))}
                <h3>Исходящие ({neighbors.out.length})</h3>
                {neighbors.out.map((n) => (
                  <button key={`out-${n.id}`} type="button" onClick={() => focusNode(n.id)}>
                    → …{n.id.slice(-8)} · {n.role} · {formatKzt(n.sum_kzt)}
                  </button>
                ))}
              </div>
            </div>
          )}

          <h2>Кластеры</h2>
          {data.clusters.slice(0, 12).map((c) => (
            <div
              key={c.cluster_id}
              className="cluster-item"
              onClick={() => {
                const first = String(c.top_gids || '').split(';')[0]
                if (first) focusNode(first)
              }}
            >
              <strong>
                #{c.cluster_id} · {c.n_nodes} узлов · seed {c.n_seed}
              </strong>
              {c.hypothesis}
            </div>
          ))}
        </aside>
      </div>
    </div>
  )
}
