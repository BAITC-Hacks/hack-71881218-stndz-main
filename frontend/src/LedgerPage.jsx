import { useDeferredValue, useMemo, useState } from 'react'

const ROLE_COLOR = {
  consolidator: 'var(--consolidator)',
  coordinator: 'var(--coordinator)',
  distributor: 'var(--distributor)',
  transit: 'var(--transit)',
  terminal: 'var(--terminal)',
  peripheral: 'var(--peripheral)',
}

function formatKzt(n, locale) {
  if (n == null || Number.isNaN(n)) return '—'
  const loc = locale === 'en' ? 'en-US' : 'ru-RU'
  if (n >= 1_000_000) {
    const v = (n / 1_000_000).toFixed(1)
    return locale === 'en' ? `${v}M ₸` : `${v} млн ₸`
  }
  return new Intl.NumberFormat(loc, { maximumFractionDigits: 0 }).format(n) + ' ₸'
}

function buildTxIndex(transactions) {
  const map = new Map()
  for (const t of transactions || []) {
    const rowIn = {
      date: t.date,
      dir: 'in',
      counterparty: t.src,
      sum_kzt: t.sum_kzt,
    }
    const rowOut = {
      date: t.date,
      dir: 'out',
      counterparty: t.dst,
      sum_kzt: t.sum_kzt,
    }
    if (!map.has(t.dst)) map.set(t.dst, [])
    if (!map.has(t.src)) map.set(t.src, [])
    map.get(t.dst).push(rowIn)
    map.get(t.src).push(rowOut)
  }
  for (const list of map.values()) {
    list.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
  }
  return map
}

/**
 * Full client ledger: every node with in/out totals and dated transfers.
 * Export has calendar dates only (no intraday time).
 */
export default function LedgerPage({
  data,
  locale,
  labels,
  selectedId,
  onSelect,
  onOpenOnGraph,
}) {
  const [filter, setFilter] = useState('')
  const [dirFilter, setDirFilter] = useState('all') // all | in | out
  const deferredFilter = useDeferredValue(filter.trim())

  const txIndex = useMemo(
    () => buildTxIndex(data?.transactions),
    [data?.transactions],
  )

  const rows = useMemo(() => {
    if (!data?.nodes) return []
    const q = deferredFilter.toLowerCase()
    const list = data.nodes.map((n) => {
      const txs = txIndex.get(n.id) || []
      let inKzt = 0
      let outKzt = 0
      let nIn = 0
      let nOut = 0
      for (const t of txs) {
        if (t.dir === 'in') {
          inKzt += t.sum_kzt || 0
          nIn += 1
        } else {
          outKzt += t.sum_kzt || 0
          nOut += 1
        }
      }
      return {
        id: n.id,
        role: n.role,
        is_seed: n.is_seed,
        in_kzt: inKzt,
        out_kzt: outKzt,
        n_in: nIn,
        n_out: nOut,
        n_tx: txs.length,
        last_date: txs[0]?.date || null,
      }
    })

    let filtered = list
    if (q) {
      filtered = list.filter(
        (r) =>
          r.id.includes(q) ||
          r.id.endsWith(q) ||
          (r.role && r.role.includes(q)),
      )
    }

    filtered.sort((a, b) => {
      if (b.n_tx !== a.n_tx) return b.n_tx - a.n_tx
      if (b.in_kzt + b.out_kzt !== a.in_kzt + a.out_kzt) {
        return b.in_kzt + b.out_kzt - (a.in_kzt + a.out_kzt)
      }
      return a.id < b.id ? -1 : 1
    })
    return filtered
  }, [data, txIndex, deferredFilter])

  const selectedMeta = useMemo(() => {
    if (!selectedId || !data?.nodes) return null
    const n = data.nodes.find((node) => node.id === selectedId)
    if (!n) return null
    const txs = txIndex.get(selectedId) || []
    let inKzt = 0
    let outKzt = 0
    let nIn = 0
    let nOut = 0
    for (const t of txs) {
      if (t.dir === 'in') {
        inKzt += t.sum_kzt || 0
        nIn += 1
      } else {
        outKzt += t.sum_kzt || 0
        nOut += 1
      }
    }
    return {
      id: n.id,
      role: n.role,
      is_seed: n.is_seed,
      in_kzt: inKzt,
      out_kzt: outKzt,
      n_in: nIn,
      n_out: nOut,
      n_tx: txs.length,
    }
  }, [data, selectedId, txIndex])

  const selectedTxs = useMemo(() => {
    if (!selectedId) return []
    const all = txIndex.get(selectedId) || []
    if (dirFilter === 'all') return all
    return all.filter((t) => t.dir === dirFilter)
  }, [txIndex, selectedId, dirFilter])

  return (
    <div className="ledger">
      <aside className="ledger-list" aria-label={labels.title}>
        <header className="ledger-list-head">
          <div>
            <strong>{labels.title}</strong>
            <span className="ledger-sub">
              {labels.shown(rows.length, data?.meta?.n_nodes || 0)}
            </span>
          </div>
          <input
            className="ledger-filter"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={labels.filterPlaceholder}
            aria-label={labels.filterPlaceholder}
          />
        </header>

        <div className="ledger-table-wrap">
          <table className="ledger-table">
            <thead>
              <tr>
                <th>{labels.colClient}</th>
                <th>{labels.colRole}</th>
                <th>{labels.colIn}</th>
                <th>{labels.colOut}</th>
                <th>{labels.colTx}</th>
                <th>{labels.colLast}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.id}
                  className={r.id === selectedId ? 'active' : ''}
                  onClick={() => onSelect(r.id)}
                >
                  <td>
                    <div className="gid">…{r.id.slice(-8)}</div>
                    {r.is_seed ? (
                      <span className="seed-tag">{labels.seed}</span>
                    ) : null}
                  </td>
                  <td>
                    <span
                      className="role-pill"
                      style={{ color: ROLE_COLOR[r.role] }}
                    >
                      {labels.roles[r.role] || r.role}
                    </span>
                  </td>
                  <td className="num in">{formatKzt(r.in_kzt, locale)}</td>
                  <td className="num out">{formatKzt(r.out_kzt, locale)}</td>
                  <td className="num">
                    {r.n_in}/{r.n_out}
                  </td>
                  <td className="num muted">{r.last_date || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </aside>

      <section className="ledger-detail" aria-label={labels.detailTitle}>
        {!selectedMeta ? (
          <div className="ledger-empty">{labels.pickClient}</div>
        ) : (
          <>
            <header className="ledger-detail-head">
              <div>
                <strong className="ledger-gid">{selectedMeta.id}</strong>
                <span className="ledger-sub">
                  {labels.roles[selectedMeta.role] || selectedMeta.role}
                  {' · '}
                  {labels.txSummary(
                    selectedMeta.n_in,
                    selectedMeta.n_out,
                    formatKzt(selectedMeta.in_kzt, locale),
                    formatKzt(selectedMeta.out_kzt, locale),
                  )}
                </span>
                <p className="ledger-note">{labels.dateNote}</p>
              </div>
              <div className="ledger-detail-actions">
                <div className="seg ledger-dir" role="group">
                  {['all', 'in', 'out'].map((d) => (
                    <button
                      key={d}
                      type="button"
                      className={dirFilter === d ? 'active' : ''}
                      onClick={() => setDirFilter(d)}
                    >
                      {d === 'all'
                        ? labels.dirAll
                        : d === 'in'
                          ? labels.txIn
                          : labels.txOut}
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  className="ledger-open-graph"
                  onClick={() => onOpenOnGraph(selectedMeta.id)}
                >
                  {labels.openGraph}
                </button>
              </div>
            </header>

            {selectedTxs.length === 0 ? (
              <div className="ledger-empty">{labels.txEmpty}</div>
            ) : (
              <div className="ledger-tx-wrap">
                <table className="ledger-tx-table">
                  <thead>
                    <tr>
                      <th>{labels.colDate}</th>
                      <th>{labels.colType}</th>
                      <th>{labels.colCounterparty}</th>
                      <th>{labels.colAmount}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selectedTxs.map((t, idx) => (
                      <tr key={`${t.date}-${t.dir}-${t.counterparty}-${idx}`}>
                        <td className="num">{t.date}</td>
                        <td>
                          <span className={`tx-dir ${t.dir}`}>
                            {t.dir === 'in' ? labels.txIn : labels.txOut}
                          </span>
                        </td>
                        <td>
                          <button
                            type="button"
                            className="tx-cp"
                            onClick={() => onSelect(t.counterparty)}
                            title={t.counterparty}
                          >
                            …{String(t.counterparty).slice(-8)}
                          </button>
                        </td>
                        <td className={`num ${t.dir}`}>
                          {formatKzt(t.sum_kzt, locale)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </section>
    </div>
  )
}
