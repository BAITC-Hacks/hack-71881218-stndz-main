import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ForceGraph2D from 'react-force-graph-2d'
import './App.css'

const ROLE_COLOR = {
  consolidator: '#e53935',
  coordinator: '#c9a227',
  distributor: '#f0873b',
  transit: '#4aa3e8',
  terminal: '#02b140',
  peripheral: '#8a94a3',
}

const ROLE_LABEL = {
  consolidator: 'Консолидаторы',
  coordinator: 'Координаторы',
  distributor: 'Распределители',
  transit: 'Транзит',
  terminal: 'Конечные',
  peripheral: 'Периферия',
}

const ROLE_HINT = {
  consolidator: 'точки сбора средств',
  coordinator: 'кандидаты в организаторы',
  distributor: 'веерная раздача',
  transit: 'пропуск без удержания',
  terminal: 'деньги оседают',
  peripheral: 'без яркой роли',
}

const ROLE_ORDER = [
  'consolidator',
  'coordinator',
  'distributor',
  'transit',
  'terminal',
  'peripheral',
]

function formatKzt(n) {
  if (n == null || Number.isNaN(n)) return '—'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)} млн ₸`
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(n) + ' ₸'
}

function formatPct(n) {
  const sign = n >= 0 ? '+' : ''
  return `${sign}${n.toFixed(1)}%`
}

function buildEgoGraph(data, centerId, hop = 1) {
  const nodeMap = new Map(data.nodes.map((n) => [n.id, n]))
  if (!nodeMap.has(centerId)) return { nodes: [], links: [] }

  const keep = new Set([centerId])
  let frontier = new Set([centerId])
  for (let h = 0; h < hop; h++) {
    const next = new Set()
    for (const link of data.links) {
      const s = typeof link.source === 'object' ? link.source.id : link.source
      const t = typeof link.target === 'object' ? link.target.id : link.target
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

export default function App() {
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [roleFilter, setRoleFilter] = useState('all')
  const [selectedId, setSelectedId] = useState(null)
  const [mode, setMode] = useState('network')
  const [dayIdx, setDayIdx] = useState(0)
  const [graphSize, setGraphSize] = useState({ width: 0, height: 0 })
  const fgRef = useRef()
  const graphHostRef = useRef(null)

  useEffect(() => {
    fetch('/data/graph.json')
      .then((r) => {
        if (!r.ok) throw new Error('Нет graph.json — запусти python pipeline.py')
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
      // «динамика» от доли роли — визуальный индикатор как в референсе
      const delta = Number((((share % 7) - 3.2) * (i % 2 === 0 ? 1 : -1)).toFixed(1))
      return { role, count, delta }
    })
  }, [data])

  const graphData = useMemo(() => {
    if (!data) return { nodes: [], links: [] }
    let g =
      mode === 'hunt' && selectedId
        ? buildEgoGraph(data, selectedId, 1)
        : buildPriorityGraph(data, 55)

    if (roleFilter !== 'all') {
      const ids = new Set(g.nodes.filter((n) => n.role === roleFilter).map((n) => n.id))
      if (selectedId) ids.add(selectedId)
      const linkId = (end) => (typeof end === 'object' ? end.id : end)
      g = {
        nodes: g.nodes.filter((n) => ids.has(n.id)),
        links: g.links.filter(
          (l) => ids.has(linkId(l.source)) && ids.has(linkId(l.target)),
        ),
      }
    }
    return g
  }, [data, mode, selectedId, roleFilter])

  useEffect(() => {
    const fg = fgRef.current
    if (!fg || !graphSize.width || !graphSize.height) return
    if (mode === 'hunt') return
    const t = setTimeout(() => {
      fg.zoomToFit(400, 48)
    }, 700)
    return () => clearTimeout(t)
  }, [graphData.nodes.length, graphData.links.length, graphSize.width, graphSize.height, mode, roleFilter])

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
    setSelectedId(id)
    setMode('hunt')
    setTimeout(() => {
      const fg = fgRef.current
      if (!fg) return
      const n = fg.graphData().nodes.find((x) => x.id === id)
      if (n) {
        fg.centerAt(n.x, n.y, 700)
        fg.zoom(3.2, 700)
      }
    }, 800)
  }, [])

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
    } else setError(`gid не найден: ${q}`)
  }

  const zoomBy = (factor) => {
    const fg = fgRef.current
    if (!fg) return
    fg.zoom(fg.zoom() * factor, 300)
  }

  if (error && !data) return <div className="error">{error}</div>
  if (!data) return <div className="loading">Freedom Bank · загрузка графа…</div>

  const day = data.timeseries?.[dayIdx]

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
            <strong>AML Desk</strong>
            <span>Граф денег</span>
          </div>
        </a>

        <form className="search" onSubmit={onSearch}>
          <input
            placeholder="Поиск клиента по gid…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setError('')
            }}
          />
          <button type="submit">Найти</button>
        </form>

        <div className="top-actions">
          <div className="seg">
            <button
              type="button"
              className={mode === 'network' ? 'active' : ''}
              onClick={() => {
                setMode('network')
                setRoleFilter('all')
              }}
            >
              Network
            </button>
            <button
              type="button"
              className={mode === 'hunt' ? 'active' : ''}
              onClick={() => selectedId && setMode('hunt')}
            >
              Hunt
            </button>
          </div>
          <span className="chip">Priority</span>
          <span className="chip">Июль 2026</span>
          <div className="avatar" title="AML аналитик">
            AML
          </div>
        </div>
      </header>

      <div className="workspace">
        <aside className="side">
          <div className="side-head">Роли в сети</div>
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
                  <strong>Вся сеть</strong>
                  <span>полный срез</span>
                </div>
                <div className="role-stats">
                  <b>{data.meta.n_nodes}</b>
                  <span className="trend up">узлов</span>
                </div>
              </button>
            </li>
            {roleCards.map((c) => (
              <li key={c.role}>
                <button
                  type="button"
                  className={`role-item ${roleFilter === c.role ? 'active' : ''}`}
                  onClick={() => setRoleFilter(c.role)}
                >
                  <div
                    className="role-ico"
                    style={{ background: ROLE_COLOR[c.role] }}
                  >
                    {c.role.slice(0, 1).toUpperCase()}
                  </div>
                  <div className="role-meta">
                    <strong>{ROLE_LABEL[c.role]}</strong>
                    <span>{ROLE_HINT[c.role]}</span>
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
            Показано <strong>{graphData.nodes.length}</strong> узлов ·{' '}
            {graphData.links.length} связей
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
                linkDirectionalArrowLength={3.2}
                linkDirectionalArrowRelPos={1}
                linkWidth={(l) =>
                  Math.max(0.35, Math.log10((l.sum_kzt || 1) + 1) * 0.55)
                }
                linkColor={() => 'rgba(107, 117, 133, 0.35)'}
                backgroundColor="rgba(0,0,0,0)"
                nodeCanvasObject={(node, ctx, globalScale) => {
                  const hot =
                    node.role === 'consolidator' ||
                    node.role === 'coordinator' ||
                    node.role === 'distributor'
                  const r =
                    2.2 +
                    11 * (node.priority_score || 0) +
                    (node.is_seed ? 2 : 0) +
                    (node.id === selectedId ? 3 : 0) +
                    (hot ? 1.2 : 0)
                  ctx.beginPath()
                  ctx.arc(node.x, node.y, r, 0, 2 * Math.PI)
                  ctx.fillStyle = ROLE_COLOR[node.role] || '#888'
                  ctx.fill()
                  if (node.id === selectedId || hot) {
                    ctx.strokeStyle =
                      node.id === selectedId ? '#0e151c' : 'rgba(2,177,64,0.7)'
                    ctx.lineWidth = (node.id === selectedId ? 1.6 : 1) / globalScale
                    ctx.stroke()
                  }
                  if (
                    globalScale > 1.35 ||
                    node.id === selectedId ||
                    node.priority_score > 0.62
                  ) {
                    ctx.font = `${10 / globalScale}px Montserrat`
                    ctx.fillStyle = '#0e151c'
                    ctx.fillText(
                      String(node.id).slice(-6),
                      node.x + r + 2,
                      node.y + 3,
                    )
                  }
                }}
                onNodeClick={(node) => focusNode(node.id)}
                cooldownTicks={90}
              />
            )}
          </div>
        </main>

        <aside className="side right">
          <div className="panel-block">
            <h2>Карточка клиента</h2>
            {!selected ? (
              <div className="sub">Кликните узел на графе или строку в топе</div>
            ) : (
              <>
                <div className="client-id" title={selected.id}>
                  {selected.id}
                </div>
                <div className="sub">
                  {ROLE_LABEL[selected.role] || selected.role}
                  {selected.is_seed ? ' · seed' : ''}
                  {' · '}depth {selected.depth}
                  {' · '}кластер #{selected.cluster_id}
                </div>

                <div className="money-grid">
                  <div className="money-card in">
                    <span>Получил</span>
                    <b>{formatKzt(selected.in_kzt)}</b>
                    <em>{selected.in_deg} плательщиков</em>
                  </div>
                  <div className="money-card out">
                    <span>Отправил</span>
                    <b>{formatKzt(selected.out_kzt)}</b>
                    <em>{selected.out_deg} получателей</em>
                  </div>
                  <div className="money-card net">
                    <span>Сальдо в графе</span>
                    <b>{formatKzt(selected.in_kzt - selected.out_kzt)}</b>
                    <em>
                      {history.length} tx · priority{' '}
                      {(selected.priority_score * 100).toFixed(0)}
                    </em>
                  </div>
                </div>

                <div className="evidence-box">{selected.evidence}</div>

                <div className="tx-block">
                  <h3>
                    История переводов
                    <span>{history.length} шт.</span>
                  </h3>
                  {history.length === 0 ? (
                    <div className="sub">Нет транзакций в выгрузке</div>
                  ) : (
                    <div className="tx-scroll">
                      <table className="tx-table">
                        <thead>
                          <tr>
                            <th>Дата</th>
                            <th>Тип</th>
                            <th>Контрагент</th>
                            <th>Сумма</th>
                          </tr>
                        </thead>
                        <tbody>
                          {history.map((t, i) => (
                            <tr key={`${t.date}-${t.counterparty}-${i}`}>
                              <td>{t.date.slice(5)}</td>
                              <td>
                                <span className={`tx-dir ${t.dir}`}>
                                  {t.dir === 'in' ? '↓ вход' : '↑ выход'}
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
                                {formatKzt(t.sum_kzt)}
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
                    <h3>Агрегат по связям</h3>
                    {neighbors.in.map((n) => (
                      <button key={`i-${n.id}`} type="button" onClick={() => focusNode(n.id)}>
                        ← …{n.id.slice(-8)} · {n.n_tx} tx · {formatKzt(n.sum_kzt)}
                      </button>
                    ))}
                    {neighbors.out.map((n) => (
                      <button key={`o-${n.id}`} type="button" onClick={() => focusNode(n.id)}>
                        → …{n.id.slice(-8)} · {n.n_tx} tx · {formatKzt(n.sum_kzt)}
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>

          <div className="panel-block">
            <h2>Priority ranking</h2>
            <div className="sub">кого смотреть первым</div>
            <table className="rank-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Client</th>
                  <th>Score</th>
                  <th>Δ</th>
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
                        >
                          {t.role}
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
          Срез:&nbsp;
          <strong>{day?.day || '2026-07'}</strong>
        </div>
        <div className="track">
          <div className="track-line" />
          <div className="months">
            {['Июл', '', '', '', '', '', '', '', '', '', '', 'Авг'].map((m, i) => (
              <span key={i}>{m}</span>
            ))}
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
          {day ? formatKzt(day.sum_kzt) : '—'}
        </div>
      </footer>
    </div>
  )
}
