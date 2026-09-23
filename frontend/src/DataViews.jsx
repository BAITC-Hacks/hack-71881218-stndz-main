import { useMemo, useState } from 'react'
import { fetchJSON } from './api'
import { Empty, Icon, RolePill, Score } from './components'
import { ROLE_LABELS } from './graphModel'
import { money, number } from './format'

export function RoleSelect({ value, onChange, label = 'Роль' }) {
  return <label className="filter-control"><span>{label}</span><select value={value} onChange={e => onChange(e.target.value)}><option value="all">Все роли</option>{Object.entries(ROLE_LABELS).map(([role, name]) => <option key={role} value={role}>{name}</option>)}</select></label>
}

function Resilience({ source, onOpenNode }) {
  const [n, setN] = useState(10)
  const [result, setResult] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const analyze = async () => {
    setBusy(true); setError(''); setResult(null)
    try { setResult(await fetchJSON(`/api/resilience?n=${n}`)) } catch (err) { setError(err.message) } finally { setBusy(false) }
  }
  return <details className="resilience-panel"><summary><Icon name="shield" /><div><strong>Устойчивость сети</strong><small>Как изменится связность при удалении приоритетных узлов</small></div><Icon name="chevron" size={16} /></summary><div className="resilience-content">
    <div className="resilience-controls"><label>Исключить топ <input type="number" min="1" max="100" disabled={busy} value={n} onChange={e => { setN(e.target.value); setResult(null) }} aria-label="Число узлов для симуляции" /> узлов</label><button className="primary-button" onClick={analyze} disabled={source !== 'api' || busy || !Number.isInteger(Number(n)) || Number(n) < 1 || Number(n) > 100}>{busy ? 'Рассчитываю…' : 'Рассчитать'}</button></div>
    {source !== 'api' && <p className="muted">Для симуляции нужно подключение к API.</p>}
    {error && <p className="inline-error" role="alert">{error}</p>}
    {result && <><div className="resilience-results"><div><span>Компонент сети</span><strong>{number(result.before.components)} <i>→</i> {number(result.after.components)}</strong></div><div><span>Узлов в крупнейшей компоненте</span><strong>{number(result.before.largest)} <i>→</i> {number(result.after.largest)}</strong></div></div><p className="muted small-text">Симуляция без учёта направления переводов. Исходные данные не изменяются.</p><details className="removed-nodes"><summary>Исключённые узлы: {result.removed.length}</summary>{result.removed.map(gid => <button className="text-button gid" key={gid} onClick={() => onOpenNode(gid)}>{gid}<Icon name="arrow" size={14} /></button>)}</details></>}
  </div></details>
}

export function PriorityView({ data, selectedId, onSelect, onOpenNode, source }) {
  const [role, setRole] = useState('all')
  const rows = data.top.filter(node => role === 'all' || node.role === role)
  return <div className="data-view"><div className="view-heading"><div><span className="eyebrow">ОЧЕРЕДЬ ПРОВЕРКИ</span><h1>Кого смотреть первым<span className="count-badge">{data.top.length}</span></h1><p>Приоритетные клиенты и обоснование по наблюдаемым потокам.</p></div></div>
    <div className="table-toolbar"><RoleSelect value={role} onChange={setRole} /><span className="muted small-text">Приоритет от 0 до 100 · по убыванию</span></div>
    <div className="table-container"><table className="data-table priority-table"><thead><tr><th>#</th><th>Клиент / роль</th><th>Приоритет</th><th>Почему проверить</th><th><span className="sr-only">Открыть</span></th></tr></thead><tbody>{rows.map(row => <tr key={row.gid} className={row.gid === selectedId ? 'selected' : ''} onClick={() => onSelect(row.gid)}><td className="rank-number">{row.rank}</td><td><button className="gid text-button" onClick={() => onSelect(row.gid)}>{row.gid}</button><RolePill role={row.role} /></td><td><Score value={row.priority_score} /></td><td className="reason-cell">{row.why || row.evidence}</td><td><button className="icon-button" title="Открыть окрестность" aria-label={`Открыть на графе ${row.gid}`} onClick={e => { e.stopPropagation(); onOpenNode(row.gid) }}><Icon name="arrow" size={17} /></button></td></tr>)}</tbody></table>{rows.length === 0 && <Empty title="В топе нет клиентов этой роли">Выберите другую роль или откройте общий список клиентов.</Empty>}</div>
    <Resilience source={source} onOpenNode={onOpenNode} />
  </div>
}

export function ClientsView({ data, selectedId, onSelect, onOpenNode }) {
  const [query, setQuery] = useState('')
  const [role, setRole] = useState('all')
  const [sort, setSort] = useState('priority_score')
  const [page, setPage] = useState(0)
  const pageSize = 30
  const rows = useMemo(() => data.nodes.filter(node => (role === 'all' || node.role === role) && node.id.includes(query.trim())).sort((a, b) => (b[sort] || 0) - (a[sort] || 0) || a.id.localeCompare(b.id)), [data, query, role, sort])
  const safePage = Math.min(page, Math.max(0, Math.ceil(rows.length / pageSize) - 1))
  const visible = rows.slice(safePage * pageSize, (safePage + 1) * pageSize)
  return <div className="data-view"><div className="view-heading"><div><span className="eyebrow">УЧАСТНИКИ СЕТИ</span><h1>Клиенты<span className="count-badge">{number(data.nodes.length)}</span></h1><p>Все клиенты, включая границу наблюдения и изолированные узлы.</p></div></div>
    <div className="table-toolbar wrap"><label className="table-search"><Icon name="search" size={17} /><input placeholder="Фильтр по GID" aria-label="Фильтр клиентов по GID" value={query} onChange={e => { setQuery(e.target.value); setPage(0) }} /></label><RoleSelect value={role} onChange={value => { setRole(value); setPage(0) }} /><label className="filter-control"><span>Сортировать</span><select value={sort} onChange={e => { setSort(e.target.value); setPage(0) }}><option value="priority_score">По приоритету</option><option value="in_kzt">По входящему потоку</option><option value="out_kzt">По исходящему потоку</option></select></label></div>
    <div className="table-container"><table className="data-table"><thead><tr><th>Клиент / роль</th><th>Приоритет</th><th>Получено</th><th>Отправлено</th><th>Операций</th><th><span className="sr-only">Открыть</span></th></tr></thead><tbody>{visible.map(node => <tr key={node.id} className={node.id === selectedId ? 'selected' : ''} onClick={() => onSelect(node.id)}><td><button className="gid text-button" onClick={() => onSelect(node.id)}>{node.id}</button><div className="table-role"><RolePill role={node.role} />{node.is_seed && <span className="seed-dot" title="Исходный клиент" />}</div></td><td><Score value={node.priority_score} /></td><td className="numeric" title={money(node.in_kzt)}>{money(node.in_kzt, true)}</td><td className="numeric" title={money(node.out_kzt)}>{money(node.out_kzt, true)}</td><td className="numeric">{node.in_tx == null || node.out_tx == null ? '—' : number(node.in_tx + node.out_tx)}</td><td><button className="icon-button" title="Открыть окрестность" aria-label={`Открыть на графе ${node.id}`} onClick={e => { e.stopPropagation(); onOpenNode(node.id) }}><Icon name="arrow" size={17} /></button></td></tr>)}</tbody></table>{rows.length === 0 && <Empty title="Клиенты не найдены">Проверьте GID или измените фильтры.</Empty>}</div>
    <div className="pagination"><span>{rows.length ? safePage * pageSize + 1 : 0}–{Math.min((safePage + 1) * pageSize, rows.length)} из {number(rows.length)}</span><button disabled={safePage === 0} onClick={() => setPage(safePage - 1)} aria-label="Предыдущая страница клиентов">←</button><button disabled={(safePage + 1) * pageSize >= rows.length} onClick={() => setPage(safePage + 1)} aria-label="Следующая страница клиентов">→</button></div>
  </div>
}

export function ClustersView({ data, onOpenCluster }) {
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState('n_seed')
  const clusters = useMemo(() => data.clusters.filter(cluster => String(cluster.cluster_id).includes(query.trim())).sort((a, b) => b[sort] - a[sort] || b.n_nodes - a.n_nodes || a.cluster_id - b.cluster_id), [data, query, sort])
  return <div className="data-view clusters-view"><div className="view-heading"><div><span className="eyebrow">СТРУКТУРА СЕТИ</span><h1>Сообщества<span className="count-badge">{data.clusters.length}</span></h1><p>Группы связанных клиентов. Назначение каждого сообщества — гипотеза по его составу.</p></div></div>
    <div className="table-toolbar"><label className="table-search"><Icon name="search" size={17} /><input aria-label="Номер кластера" placeholder="Номер кластера" value={query} onChange={e => setQuery(e.target.value)} /></label><label className="filter-control"><span>Сортировать</span><select value={sort} onChange={e => setSort(e.target.value)}><option value="n_seed">По числу исходных клиентов</option><option value="n_nodes">По размеру сообщества</option><option value="sum_kzt_internal">По внутреннему обороту</option></select></label></div>
    <div className="cluster-grid">{clusters.map(cluster => <button className="cluster-card" key={cluster.cluster_id} onClick={() => onOpenCluster(cluster.cluster_id)}><div className="cluster-card-top"><span className="cluster-icon"><Icon name="clusters" size={20} /></span><span>Кластер <b>#{cluster.cluster_id}</b></span><Icon name="arrow" size={18} /></div><div className="cluster-stats"><div><strong>{number(cluster.n_nodes)}</strong><span>клиентов</span></div><div><strong>{number(cluster.n_seed)}</strong><span>исходных</span></div><div><strong>{money(cluster.sum_kzt_internal, true)}</strong><span>внутренний оборот</span></div></div><p>{cluster.hypothesis}</p><span className="cluster-open">Исследовать связи <Icon name="chevron" size={14} /></span></button>)}</div>
    {clusters.length === 0 && <Empty title="Кластер не найден">Измените номер в фильтре.</Empty>}
  </div>
}
