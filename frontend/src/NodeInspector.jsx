import { useEffect, useMemo, useState } from 'react'
import { fetchJSON } from './api'
import { Empty, Icon, Loading, RolePill, Score } from './components'
import { dateLabel, FLAG_LABELS, localTransactions, money, number, score, shortGid } from './format'

function Transactions({ node, data, source, onOpenNode }) {
  const [direction, setDirection] = useState('all')
  const [offset, setOffset] = useState(0)
  const [attempt, setAttempt] = useState(0)
  const [resource, setResource] = useState(null)
  const requestKey = `${node.id}-${source}-${direction}-${offset}-${attempt}`
  const result = resource?.key === requestKey && resource?.data === data ? resource.result : { loading: true }
  const limit = 20
  useEffect(() => {
    const controller = new AbortController()
    const request = source === 'api'
      ? fetchJSON(`/api/nodes/${node.id}/transactions?direction=${direction}&offset=${offset}&limit=${limit}`, { signal: controller.signal })
      : Promise.resolve(localTransactions(data, node.id, direction, offset, limit))
    request.then(page => { if (!controller.signal.aborted) setResource({ key: requestKey, data, result: page }) })
      .catch(error => { if (!controller.signal.aborted) setResource({ key: requestKey, data, result: { error: error.message } }) })
    return () => controller.abort()
  }, [node.id, data, source, direction, offset, attempt, requestKey])
  return <div className="transactions-section">
    <div className="segmented small" aria-label="Направление операций">{[['all', 'Все'], ['in', 'Входящие'], ['out', 'Исходящие']].map(([key, label]) => <button key={key} aria-pressed={direction === key} onClick={() => { setDirection(key); setOffset(0) }}>{label}</button>)}</div>
    <p className="muted small-text">Сначала новые. В исходных данных есть дата, без времени суток.</p>
    {result.loading ? <Loading /> : result.error ? <div className="inline-error">{result.error}<button onClick={() => setAttempt(attempt + 1)}>Повторить</button></div> : !result.available ? <Empty title="Детализация не загружена">Суммы в профиле рассчитаны по агрегированным связям. Пересчитайте выгрузку для просмотра операций.</Empty> : result.total === 0 ? <Empty title="Операций не найдено">В выбранном направлении за период выгрузки операций нет.</Empty> : <>
      <div className="transaction-list">{result.transactions.map((tx, index) => {
        const incoming = tx.dst === node.id
        const counterparty = incoming ? tx.src : tx.dst
        return <div className="transaction-row" key={`${tx.src}-${tx.dst}-${tx.date}-${index}`}>
          <span className={`flow-icon ${incoming ? 'incoming' : 'outgoing'}`}>{incoming ? '↙' : '↗'}</span>
          <div><button className="text-button gid" title={counterparty} onClick={() => onOpenNode(counterparty)}>{shortGid(counterparty)}</button><small>{dateLabel(tx.date)}</small></div>
          <div className="transaction-amount"><b>{incoming ? '+' : '−'}{money(tx.sum_kzt)}</b><small>{incoming ? 'Входящий' : 'Исходящий'}</small></div>
        </div>
      })}</div>
      <div className="pagination"><span>{offset + 1}–{Math.min(offset + limit, result.total)} из {number(result.total)}</span><button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - limit))} aria-label="Предыдущие операции">←</button><button disabled={offset + limit >= result.total} onClick={() => setOffset(offset + limit)} aria-label="Следующие операции">→</button></div>
    </>}
  </div>
}

function SelectedNode({ node, data, source, onOpenNode, onOpenCluster, onClose }) {
  const [tab, setTab] = useState('profile')
  const [cardResource, setCardResource] = useState(null)
  const [attempt, setAttempt] = useState(0)
  const [copyState, setCopyState] = useState('')
  const [neighborDirection, setNeighborDirection] = useState('in')
  const [neighborLimit, setNeighborLimit] = useState(20)
  const currentCard = cardResource?.data === data && cardResource?.source === source && cardResource?.attempt === attempt ? cardResource : null
  const card = currentCard?.card
  const cardError = currentCard?.error || ''
  useEffect(() => {
    if (source !== 'api') return
    const controller = new AbortController()
    fetchJSON(`/api/nodes/${node.id}/card`, { signal: controller.signal })
      .then(value => { if (!controller.signal.aborted) setCardResource({ data, source, attempt, card: value }) })
      .catch(error => { if (!controller.signal.aborted) setCardResource({ data, source, attempt, error: error.message }) })
    return () => controller.abort()
  }, [node.id, source, data, attempt])
  const neighbors = useMemo(() => {
    const incoming = data.links.filter(link => link.target === node.id)
    const outgoing = data.links.filter(link => link.source === node.id)
    return { in: incoming.sort((a, b) => b.sum_kzt - a.sum_kzt), out: outgoing.sort((a, b) => b.sum_kzt - a.sum_kzt) }
  }, [data, node.id])
  const byId = useMemo(() => new Map(data.nodes.map(item => [item.id, item])), [data])
  const flags = [...new Set([...(node.flags || []), ...(node.truncated_by_depth ? ['truncated_by_depth'] : [])])]
  const copyId = async () => {
    try { await navigator.clipboard.writeText(node.id); setCopyState('Скопировано') } catch { setCopyState('Выделите и скопируйте GID') }
  }
  return <aside className="node-inspector" aria-label="Карточка клиента">
    <div className="inspector-heading"><span className="eyebrow">КАРТОЧКА КЛИЕНТА</span><button className="icon-button" onClick={onClose} aria-label="Закрыть карточку"><Icon name="close" size={17} /></button></div>
    <div className="inspector-id"><strong className="gid">{node.id}</strong><button className="icon-button" onClick={copyId} title="Скопировать GID" aria-label="Скопировать GID"><Icon name="copy" size={16} /></button></div>
    {copyState && <small role="status" className="muted">{copyState}</small>}
    <div className="node-tags"><RolePill role={node.role} />{node.is_seed && <span className="seed-badge">Исходный клиент</span>}</div>
    <div className="node-meta"><span>Колено {node.depth}</span><button className="text-button" onClick={() => onOpenCluster(node.cluster_id)}>Кластер #{node.cluster_id}<Icon name="chevron" size={13} /></button></div>
    <button className="secondary-button full-width" onClick={() => onOpenNode(node.id)}>Открыть окрестность клиента <Icon name="graph" size={14} /></button>
    <div className="inspector-tabs" role="tablist" aria-label="Данные клиента">{[['profile', 'Профиль'], ['links', 'Связи'], ['transactions', 'Операции']].map(([key, label]) => <button role="tab" aria-selected={tab === key} key={key} onClick={() => setTab(key)}>{label}</button>)}</div>
    <div className="inspector-content">
      {tab === 'profile' && <>
        <div className="priority-block"><span>Приоритет проверки</span><Score value={node.priority_score} /></div>
        <p className="score-note">Соответствие роли: {score(node.role_score)} / 100. Оценки описывают структуру, а не вероятность нарушения.</p>
        <div className="flow-cards"><div><span>↙ Получено</span><strong title={money(node.in_kzt)}>{money(node.in_kzt, true)}</strong><small>{number(node.in_deg)} плательщиков · {number(node.in_tx)} операций</small></div><div><span>↗ Отправлено</span><strong title={money(node.out_kzt)}>{money(node.out_kzt, true)}</strong><small>{number(node.out_deg)} получателей · {number(node.out_tx)} операций</small></div></div>
        <div className="evidence-box"><span className="eyebrow"><Icon name="info" size={15} /> ПОЧЕМУ ЭТА РОЛЬ</span><p>{node.evidence}</p></div>
        {node.why && node.why !== node.evidence && <section className="inspector-section"><h3>Почему в приоритете</h3><p>{node.why}</p></section>}
        <div className="metric-list"><div><span>Сальдо внутри графа</span><b>{money(node.in_kzt - node.out_kzt)}</b></div><div><span>Seed в пределах 2 шагов</span><b>{number(node.seed_reach2)}</b></div><div><span>Синхронных плательщиков за день</span><b>{number(node.sync_in_max)}</b></div></div>
        <p className="muted small-text">Сальдо отражает только наблюдаемые переводы, не остаток на счёте.</p>
        {flags.length > 0 && <section className="inspector-section"><h3>Ограничения данных</h3>{flags.map(flag => <div className="quality-note" key={flag}><Icon name="info" size={14} /><span>{FLAG_LABELS[flag] || flag}</span></div>)}</section>}
        {card?.attention?.length > 0 && <section className="inspector-section"><h3>На что обратить внимание</h3>{card.attention.map((item, i) => <p key={i}>{item.text}</p>)}</section>}
        <section className="inspector-section next-steps"><h3><Icon name="arrow" size={16} /> Что запросить дальше</h3>
          {source !== 'api' ? <p className="muted">Подключите API для рекомендаций по полноте данных.</p> : cardError ? <div className="inline-error">{cardError}<button onClick={() => setAttempt(attempt + 1)}>Повторить</button></div> : !card ? <Loading /> : card.data_gaps.map((gap, i) => <div className="next-step" key={i}><p>{gap.gap}</p><strong>{gap.next_request}</strong></div>)}
        </section>
      </>}
      {tab === 'links' && <>
        <div className="segmented small">{[['in', 'Плательщики'], ['out', 'Получатели']].map(([key, label]) => <button key={key} aria-pressed={neighborDirection === key} onClick={() => { setNeighborDirection(key); setNeighborLimit(20) }}>{label} · {neighbors[key].length}</button>)}</div>
        <p className="muted small-text">По сумме переводов. Нажмите на клиента, чтобы открыть его окрестность.</p>
        {neighbors[neighborDirection].length === 0 ? <Empty title="Связей не найдено">{node.truncated_by_depth && neighborDirection === 'out' ? 'На границе обхода исходящие не собирались.' : 'В этом направлении в выгрузке нет связей.'}</Empty> : neighbors[neighborDirection].slice(0, neighborLimit).map(link => {
          const gid = neighborDirection === 'in' ? link.source : link.target
          return <button className="neighbor-row" key={gid} onClick={() => onOpenNode(gid)} title={gid}><div><strong className="gid">{shortGid(gid)}</strong><RolePill role={byId.get(gid)?.role} /></div><div><b>{money(link.sum_kzt, true)}</b><small>{number(link.n_tx)} операций <Icon name="arrow" size={12} /></small></div></button>
        })}
        {neighborLimit < neighbors[neighborDirection].length && <button className="secondary-button full-width" onClick={() => setNeighborLimit(neighborLimit + 20)}>Показать ещё {Math.min(20, neighbors[neighborDirection].length - neighborLimit)}</button>}
      </>}
      {tab === 'transactions' && <Transactions node={node} data={data} source={source} onOpenNode={onOpenNode} />}
    </div>
    <div className="inspector-footer"><Icon name="shield" size={15} /><span>Наблюдаемые признаки · гипотеза для проверки</span></div>
  </aside>
}

export default function NodeInspector(props) {
  if (!props.node) return <aside className="node-inspector"><Empty title="Выберите клиента">Нажмите на узел графа или строку таблицы, чтобы изучить потоки и объяснение роли.</Empty></aside>
  return <SelectedNode key={props.node.id} {...props} />
}
