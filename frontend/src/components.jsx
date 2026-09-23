import { ROLE_COLORS, ROLE_LABELS } from './graphModel'
import { score } from './format'

const paths = {
  graph: 'M12 12 5 5m7 7 7-7m-7 7-7 7m7-7 7 7M5 2a3 3 0 1 0 0 6 3 3 0 0 0 0-6Zm14 0a3 3 0 1 0 0 6 3 3 0 0 0 0-6ZM5 16a3 3 0 1 0 0 6 3 3 0 0 0 0-6Zm14 0a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z',
  ranking: 'M8 6h12M8 12h9M8 18h6M3 6h1M3 12h1M3 18h1',
  clusters: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',
  users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm13 18v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75',
  search: 'm21 21-5.2-5.2M10.5 3a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15Z',
  download: 'M12 3v12m-5-5 5 5 5-5M5 17v4h14v-4',
  chevron: 'm9 5 7 7-7 7',
  arrow: 'M4 12h16m-6-6 6 6-6 6',
  close: 'm6 6 12 12M6 18 18 6',
  copy: 'M9 9h12v12H9zM15 5V3H3v12h2',
  refresh: 'M20 7v5h-5M4 17v-5h5M5.4 7a8 8 0 0 1 13.2-2L20 7M4 17l1.4 2A8 8 0 0 0 18.6 17',
  shield: 'm12 3 8 4v5c0 5-8 9-8 9s-8-4-8-9V7l8-4Zm-4 9 3 3 5-6',
  info: 'M12 8h.01M12 11v6M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Z',
}
export function Icon({ name, size = 20, ...props }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}><path d={paths[name] || paths.info} /></svg>
}
export function RolePill({ role }) {
  return <span className="role-pill" style={{ '--role-color': ROLE_COLORS[role] || '#697586' }}><span />{ROLE_LABELS[role] || role}</span>
}
export function Score({ value }) {
  return <span className="score"><span className="score-track"><i style={{ width: `${score(value) || 0}%` }} /></span><b>{score(value)}</b></span>
}
export function Empty({ title, children }) {
  return <div className="empty-state"><Icon name="search" size={28} /><strong>{title}</strong>{children && <p>{children}</p>}</div>
}
export function Loading({ children = 'Загрузка данных…' }) {
  return <div className="loading-state" role="status"><span className="spinner" />{children}</div>
}
