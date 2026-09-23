import { useEffect, useMemo, useState } from 'react'
import GraphCanvas from './GraphCanvas'
import { ROLE_COLORS, ROLE_LABELS } from './graphModel'
import { normalizeGraphPayload } from './graphAdapter'
import { downloadExport, fetchJSON } from './api'
import { COPILOT_LABELS, money, number, periodLabel } from './format'
import { Icon, Loading, RolePill } from './components'
import { ClientsView, ClustersView, PriorityView, RoleSelect } from './DataViews'
import NodeInspector from './NodeInspector'
import CopilotPanel from './CopilotPanel'
import './App.css'

const DEFAULT_FILTERS = { role: 'all', depth: 'all', seed: 'all' }
const EXPORTS = [['nodes_roles.csv', 'Клиенты и роли'], ['top_nodes.csv', 'Приоритеты проверки'], ['clusters.csv', 'Сообщества']]
const NAVIGATION = [['graph', 'graph', 'Сеть переводов'], ['priority', 'ranking', 'Приоритеты'], ['clusters', 'clusters', 'Сообщества'], ['clients', 'users', 'Все клиенты']]

export default function App() {
  const [data, setData] = useState(null)
  const [source, setSource] = useState('')
  const [health, setHealth] = useState(null)
  const [loadError, setLoadError] = useState('')
  const [loading, setLoading] = useState(true)
  const [reload, setReload] = useState(0)
  const [page, setPage] = useState('graph')
  const [graphMode, setGraphMode] = useState('ego')
  const [selectedId, setSelectedId] = useState(null)
  const [rootId, setRootId] = useState(null)
  const [clusterId, setClusterId] = useState(null)
  const [showInspector, setShowInspector] = useState(true)
  const [filters, setFilters] = useState(DEFAULT_FILTERS)
  const [hop, setHop] = useState(1)
  const [limit, setLimit] = useState(80)
  const [summary, setSummary] = useState(null)
  const [query, setQuery] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchMessage, setSearchMessage] = useState('')
  const [notice, setNotice] = useState('')
  const [exporting, setExporting] = useState(false)

  useEffect(() => {
    let active = true
    async function load() {
      let raw, nextSource
      try {
        raw = await fetchJSON('/api/graph', { signal: AbortSignal.timeout(4000) })
        nextSource = 'api'
      } catch {
        raw = await fetchJSON('/data/graph.json')
        nextSource = 'snapshot'
      }
      const normalized = normalizeGraphPayload(raw)
      if (!normalized.nodes.length) throw new Error('В выгрузке нет клиентов.')
      if (!active) return
      setData(normalized); setSource(nextSource)
      const defaultId = normalized.top[0]?.gid || normalized.nodes[0].id
      const ids = new Set(normalized.nodes.map(node => node.id))
      setSelectedId(previous => ids.has(previous) ? previous : defaultId)
      setRootId(previous => ids.has(previous) ? previous : defaultId)
      setClusterId(previous => normalized.clusters.some(cluster => String(cluster.cluster_id) === String(previous)) ? previous : normalized.clusters[0]?.cluster_id)
      if (nextSource === 'api') fetchJSON('/api/health').then(value => { if (active) setHealth(value) }).catch(() => { if (active) setHealth(null) })
      else setHealth(null)
    }
    load().catch(error => { if (active) setLoadError(error.message || 'Не удалось загрузить граф.') }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [reload])

  const reloadData = () => { setLoading(true); setLoadError(''); setReload(value => value + 1) }

  const byId = useMemo(() => new Map((data?.nodes || []).map(node => [node.id, node])), [data])
  const selected = byId.get(selectedId)
  const cluster = data?.clusters.find(item => String(item.cluster_id) === String(clusterId))
  const matches = useMemo(() => {
    const q = query.trim()
    if (!q || !data) return []
    const exact = byId.get(q)
    if (exact) return [exact]
    return data.nodes.filter(node => node.id.includes(q)).sort((a, b) => b.priority_score - a.priority_score)
  }, [query, data, byId])

  const openNode = (id) => {
    if (!byId.has(id)) { setNotice('Клиент отсутствует в текущей выгрузке.'); return }
    setSelectedId(id); setRootId(id); setShowInspector(true); setPage('graph'); setGraphMode('ego')
    setFilters(DEFAULT_FILTERS); setLimit(80); setHop(1); setSearchOpen(false); setSearchMessage('')
  }
  const selectNode = (id) => { setSelectedId(id); setShowInspector(true) }
  const openCluster = (id) => {
    const next = data.clusters.find(item => String(item.cluster_id) === String(id))
    if (!next) return
    setClusterId(next.cluster_id); setGraphMode('cluster'); setPage('graph')
    const gid = next.top_gids?.[0] || data.nodes.find(node => node.cluster_id === next.cluster_id)?.id
    setRootId(gid); setSelectedId(gid); setShowInspector(true); setFilters(DEFAULT_FILTERS); setLimit(80)
  }
  const search = (event) => {
    event.preventDefault()
    if (!query.trim()) return
    if (matches.length === 1) openNode(matches[0].id)
    else { setSearchOpen(true); setSearchMessage(matches.length ? `Найдено ${number(matches.length)} клиентов. Выберите нужного или уточните GID.` : 'Клиент не найден. Проверьте GID.') }
  }
  const exportFile = async (filename) => {
    setExporting(true); setNotice('')
    try { await downloadExport(filename, source) } catch (error) { setNotice(error.message) } finally { setExporting(false) }
  }
  const navigate = (next) => { if (next === 'graph') { openNode(selectedId || rootId); return }; setPage(next); setSearchOpen(false) }

  if (!data && loading) return <div className="startup"><img src="/freedom-logo.svg" alt="Freedom Bank" /><Loading>Загружаю сеть переводов…</Loading></div>
  if (!data) return <div className="startup"><Icon name="graph" size={40} /><h1>Не удалось открыть сеть</h1><p>{loadError}</p><p className="muted">Запустите локальный сервис и пересчитайте данные по инструкции в README.</p><button className="primary-button" onClick={reloadData}>Повторить загрузку</button></div>

  return <div className="app-shell">
    <aside className="app-sidebar">
      <a className="brand" href="#" onClick={e => { e.preventDefault(); navigate('graph') }}><img src="/freedom-logo.svg" alt="Freedom Bank" /><span>ГРАФ ДЕНЕГ<span>Рабочее место аналитика</span></span></a>
      <div className="workspace-label"><span className="workspace-mark"><Icon name="shield" size={19} /></span><div><strong>AML Intelligence</strong><small>STNDZ MAIN</small></div><span className="live-dot" /></div>
      <p className="nav-caption">РАССЛЕДОВАНИЕ</p>
      <nav aria-label="Разделы">{NAVIGATION.map(([key, icon, label]) => <button key={key} className={page === key ? 'active' : ''} aria-current={page === key ? 'page' : undefined} onClick={() => navigate(key)}><Icon name={icon} size={19} /><span>{label}</span>{key === 'priority' && <b>{data.top.length}</b>}{key === 'clusters' && <b>{data.clusters.length}</b>}</button>)}</nav>
      <div className="sidebar-bottom"><div className="dataset-card"><span className="eyebrow">ТЕКУЩАЯ ВЫГРУЗКА</span><strong>{periodLabel(data.meta)}</strong><span>{number(data.meta.tx ?? data.transactions?.length)} операций · KZT</span><p>Один банк · от 5 000 ₸<br />Обход на 4 колена</p></div><div className="analyst"><span>AM</span><div><strong>AML-аналитик</strong><small>Локальное рабочее пространство</small></div></div></div>
    </aside>

    <div className="app-body">
      <header className="app-header">
        <form className="global-search" onSubmit={search} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setSearchOpen(false) }}><Icon name="search" size={19} /><input value={query} onChange={e => { setQuery(e.target.value); setSearchOpen(true); setSearchMessage('') }} onFocus={() => setSearchOpen(Boolean(query.trim()))} onKeyDown={e => { if (e.key === 'Escape') setSearchOpen(false) }} placeholder="Найти клиента по GID…" aria-label="Найти клиента по GID" autoComplete="off" /><button className="search-submit" type="submit">Найти <span>↵</span></button>
          {searchOpen && query.trim() && <div className="search-results"><p>{searchMessage || `Совпадений: ${number(matches.length)}`}</p>{matches.slice(0, 8).map(node => <button key={node.id} type="button" onClick={() => { setQuery(node.id); openNode(node.id) }}><span className="gid">{node.id}</span><RolePill role={node.role} /><Icon name="arrow" size={15} /></button>)}{matches.length > 8 && <small>Показаны первые 8. Введите больше цифр.</small>}</div>}
        </form>
        <div className="header-actions"><button className={`connection-status ${source}`} title={source === 'api' ? `Подключено: ${health?.source || 'граф API'}` : 'Граф загружен из локальной копии. Нажмите, чтобы повторить подключение к API.'} onClick={reloadData} disabled={loading}><span />{loading ? 'Обновление…' : source === 'api' ? 'API подключён' : 'Локальная копия'}<Icon name="refresh" size={13} /></button><details className="export-menu"><summary><Icon name="download" size={17} />Выгрузить CSV</summary><div>{EXPORTS.map(([filename, label]) => <button key={filename} disabled={exporting} onClick={() => exportFile(filename)}><span>{label}</span><small>{filename}</small></button>)}</div></details></div>
      </header>
      {(source !== 'api' || notice || loadError) && <div className={`status-banner ${notice || loadError ? 'warning' : ''}`} role="status"><Icon name="info" size={16} /><span>{notice || loadError || 'API недоступен. Открыта локальная выгрузка; рекомендации, симуляция и ассистент требуют подключения.'}</span>{notice ? <button onClick={() => setNotice('')} aria-label="Закрыть уведомление">×</button> : <button onClick={reloadData} disabled={loading}>Подключить</button>}</div>}
      <main className={`main-content ${page === 'clusters' ? 'full-page' : ''}`}>
        <section className="content-column">
          {page === 'graph' && <div className="graph-workspace">
            <div className="view-heading"><div><span className="eyebrow">АНАЛИЗ ДЕНЕЖНЫХ ПОТОКОВ</span><h1>{graphMode === 'cluster' ? `Кластер #${clusterId}` : graphMode === 'priority' ? 'Связи приоритетных клиентов' : 'Сеть переводов'}<span className="heading-dot" /></h1><p>{graphMode === 'cluster' ? cluster?.hypothesis : 'Исследуйте связи. Определяйте роли. Обосновывайте приоритет.'}</p></div>{!showInspector && <button className="secondary-button" onClick={() => setShowInspector(true)}>Карточка клиента <Icon name="chevron" size={16} /></button>}</div>
            <div className="network-stats"><div><span>Клиентов в выгрузке</span><strong>{number(data.nodes.length)}</strong></div><div><span>Направленных связей</span><strong>{number(data.links.length)}</strong></div><div><span>Исходных клиентов</span><strong>{number(data.meta.seeds ?? data.nodes.filter(node => node.is_seed).length)}<small>seed</small></strong></div><div><span>Общий оборот</span><strong>{money(data.meta.total_kzt, true)}</strong></div></div>
            <div className="graph-panel">
              <div className="graph-toolbar"><div className="segmented" aria-label="Режим графа">{[['ego', 'Окрестность'], ['priority', 'Топ-30'], ['cluster', 'Кластер']].map(([mode, label]) => <button key={mode} aria-pressed={graphMode === mode} onClick={() => { setGraphMode(mode); setFilters(DEFAULT_FILTERS); setLimit(80); if (mode === 'cluster' && selected) setClusterId(selected.cluster_id); if (mode === 'ego' && selectedId) setRootId(selectedId) }}>{label}</button>)}</div>{graphMode === 'ego' && <label className="inline-select"><span>Шагов</span><select aria-label="Число шагов окрестности" value={hop} onChange={e => { setHop(Number(e.target.value)); setLimit(80) }}><option value={1}>1</option><option value={2}>2</option></select></label>}{graphMode === 'cluster' && <label className="inline-select"><span>Кластер</span><select aria-label="Выбор кластера" value={clusterId ?? ''} onChange={e => openCluster(e.target.value)}>{data.clusters.map(item => <option key={item.cluster_id} value={item.cluster_id}>#{item.cluster_id} · {item.n_nodes} узлов</option>)}</select></label>}</div>
              <div className="graph-filter-row"><RoleSelect value={filters.role} onChange={role => setFilters({ ...filters, role })} /><label className="filter-control"><span>Колено</span><select aria-label="Фильтр по колену" value={filters.depth} onChange={e => setFilters({ ...filters, depth: e.target.value })}><option value="all">Все</option>{[0, 1, 2, 3, 4].map(depth => <option key={depth}>{depth}</option>)}</select></label><label className="filter-control"><span>Исходные клиенты</span><select aria-label="Фильтр исходных клиентов" value={filters.seed} onChange={e => setFilters({ ...filters, seed: e.target.value })}><option value="all">Все</option><option value="seed">Только seed</option><option value="nonseed">Без seed</option></select></label>{Object.values(filters).some(value => value !== 'all') && <button className="text-button reset-filters" onClick={() => setFilters(DEFAULT_FILTERS)}>Сбросить</button>}</div>
              {summary?.rootExcludedByFilters && <div className="graph-filter-warning">Выбранный клиент не соответствует фильтрам. <button onClick={() => setFilters(DEFAULT_FILTERS)}>Сбросить фильтры</button></div>}
              {summary && !summary.selectedVisible && selectedId && <div className="graph-filter-warning">Выбранный клиент вне текущего среза. <button onClick={() => openNode(selectedId)}>Открыть его окрестность</button></div>}
              <div className="graph-stage"><GraphCanvas data={data} selectedId={selectedId} rootId={rootId} mode={graphMode} clusterId={clusterId} filters={filters} hop={hop} limit={limit} onSelect={selectNode} onSummary={setSummary} /></div>
              <div className="graph-status"><span>{summary ? <><b>{number(summary.visibleNodes)}</b> из {number(summary.availableNodes)} узлов · <b>{number(summary.visibleEdges)}</b> из {number(summary.availableEdges)} связей</> : 'Подготовка графа…'}</span>{summary?.hiddenNodes > 0 && <button className="text-button" onClick={() => setLimit(limit + 80)}>Показать ещё {Math.min(80, summary.hiddenNodes)} узлов <Icon name="arrow" size={14} /></button>}</div>
              <div className="graph-legend">{Object.entries(ROLE_LABELS).map(([role, label]) => <span key={role}><i style={{ background: ROLE_COLORS[role] }} />{label}</span>)}<span className="seed-legend"><i />Исходный клиент</span></div>
            </div>
            <p className="graph-footnote"><Icon name="info" size={14} />Стрелки — направление переводов. Цвет — предполагаемая роль, размер — приоритет. Нажмите узел, чтобы открыть его карточку.</p>
          </div>}
          {page === 'priority' && <PriorityView key={`${source}-${data.meta.generated_at}-${reload}`} data={data} selectedId={selectedId} onSelect={selectNode} onOpenNode={openNode} source={source} />}
          {page === 'clients' && <ClientsView data={data} selectedId={selectedId} onSelect={selectNode} onOpenNode={openNode} />}
          {page === 'clusters' && <ClustersView data={data} onOpenCluster={openCluster} />}
        </section>
        {page !== 'clusters' && showInspector && <NodeInspector node={selected} data={data} source={source} onOpenNode={openNode} onOpenCluster={openCluster} onClose={() => setShowInspector(false)} />}
        {page !== 'graph' && page !== 'clusters' && !showInspector && <button className="reopen-inspector" onClick={() => setShowInspector(true)}>Карточка клиента <Icon name="chevron" size={15} /></button>}
      </main>
    </div>
    <CopilotPanel selectedId={selectedId} locale="ru" labels={COPILOT_LABELS} onOpenGid={openNode} available={source === 'api'} />
  </div>
}
