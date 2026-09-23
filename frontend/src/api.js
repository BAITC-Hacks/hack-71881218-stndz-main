export async function fetchJSON(url, options = {}) {
  const timeout = AbortSignal.timeout(10000)
  const response = await fetch(url, { ...options, signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout })
  if (!response.ok) {
    let message = `Запрос не выполнен (${response.status})`
    try { const body = await response.json(); if (typeof body.detail === 'string') message = body.detail } catch { /* Use status when no JSON body is available. */ }
    throw new Error(message)
  }
  return response.json()
}

export async function downloadExport(filename, source) {
  const response = await fetch(source === 'api' ? `/api/exports/${filename}` : `/data/${filename}`, { signal: AbortSignal.timeout(10000) })
  if (!response.ok || response.headers.get('content-type')?.includes('text/html')) throw new Error('Выгрузка недоступна. Пересчитайте данные и обновите страницу.')
  const url = URL.createObjectURL(await response.blob())
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
