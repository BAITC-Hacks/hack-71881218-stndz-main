export const number = (value) => new Intl.NumberFormat('ru-RU').format(value ?? 0)
export function money(value, compact = false) {
  if (value == null || !Number.isFinite(Number(value))) return 'Нет данных'
  return new Intl.NumberFormat('ru-RU', {
    maximumFractionDigits: compact ? 1 : 0,
    ...(compact ? { notation: 'compact' } : {}),
  }).format(value) + ' ₸'
}
export const score = (value) => Number.isFinite(value) ? Math.round(value * 100) : '—'
export const shortGid = (gid) => `…${String(gid).slice(-8)}`
export function dateLabel(value) {
  if (!value) return '—'
  return new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(value))
}
export function periodLabel(meta) {
  if (!meta?.date_from || !meta?.date_to) return 'Период выгрузки'
  return `${dateLabel(meta.date_from)} — ${dateLabel(meta.date_to)}`
}
export const FLAG_LABELS = {
  truncated_by_depth: 'Граница данных: исходящие после 4-го колена не собирались.',
  seed_inflow_incomplete: 'Исходный клиент: входящие из-за пределов выборки неполные.',
  outflow_exceeds_inflow: 'Отправлено больше, чем получено внутри наблюдаемой сети.',
  external_funding: 'Источник части средств находится за пределами выборки.',
  isolated: 'Связей в предоставленной выгрузке нет.',
}
export const COPILOT_LABELS = {
  title: 'Ассистент аналитика', fab: 'Спросить AI', close: 'Закрыть ассистента',
  placeholder: 'Вопрос о клиенте, связях или приоритете…', send: 'Отправить',
  hint: 'Ответы строятся по данным этой сети. Выберите клиента для контекста или задайте вопрос о приоритетах.',
  thinking: 'Проверяю данные…', unavailable: 'Не удалось получить ответ. Проверьте подключение к API и повторите запрос.',
  emptyAnswer: 'Ответ не получен.', modeLlm: 'AI + данные графа', modeRules: 'Анализ по правилам',
  contextOn: (tail) => `Клиент ${tail}`, contextOff: 'Вся сеть',
}

export function localTransactions(data, gid, direction = 'all', offset = 0, limit = 20) {
  const available = Array.isArray(data.transactions) && data.transactionsAvailable !== false
  const transactions = (data.transactions || []).filter(t =>
    direction === 'in' ? t.dst === gid : direction === 'out' ? t.src === gid : t.src === gid || t.dst === gid,
  ).sort((a, b) => b.date.localeCompare(a.date) || a.src.localeCompare(b.src) || a.dst.localeCompare(b.dst) || a.sum_kzt - b.sum_kzt)
  return { gid, available, total: transactions.length, offset, limit, transactions: transactions.slice(offset, offset + limit) }
}
