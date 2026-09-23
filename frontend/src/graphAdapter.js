// Accept the official static export and the normalized API snapshot.
export function normalizeGraphPayload(raw) {
  if (!raw || !Array.isArray(raw.nodes)) throw new Error('Некорректная выгрузка графа.')
  const nodes = (raw.nodes || []).map((node) => {
    const id = node.id ?? node.gid
    if (typeof id !== 'string' || !/^\d{18}$/.test(id)) throw new Error('GID должен передаваться точной строкой из 18 цифр.')
    const metrics = node.metrics || {}
    const flags = Array.isArray(node.flags) ? node.flags : []
    return {
      ...metrics,
      ...node,
      id,
      priority_score: Number(node.priority_score || 0),
      flags,
      truncated_by_depth:
        Boolean(node.truncated_by_depth) || flags.includes('truncated_by_depth'),
    }
  })
  const links = (raw.links || raw.edges || []).map((edge) => ({
    ...edge,
    source: String(edge.source ?? edge.src),
    target: String(edge.target ?? edge.dst),
  }))
  const nodeById = new Map(nodes.map((node) => [node.id, node]))
  if (nodeById.size !== nodes.length || links.some(link => !nodeById.has(link.source) || !nodeById.has(link.target))) throw new Error('Узлы и связи выгрузки не согласованы.')
  let top = Array.isArray(raw.top) ? raw.top : []
  if (!top.length) {
    const ranked = nodes.filter((node) => Number.isFinite(node.rank))
    top = (ranked.length ? ranked : nodes)
      .slice()
      .sort(
        (a, b) =>
          (a.rank ?? Number.MAX_SAFE_INTEGER) -
            (b.rank ?? Number.MAX_SAFE_INTEGER) ||
          b.priority_score - a.priority_score ||
          a.id.localeCompare(b.id),
      )
      .slice(0, 30)
      .map((node, index) => ({
        rank: node.rank ?? index + 1,
        gid: node.id,
        role: node.role,
        priority_score: node.priority_score,
        in_deg: node.in_deg,
        why: node.evidence,
      }))
  } else {
    top = top.map((row, index) => {
      const gid = String(row.gid ?? row.id)
      return { ...nodeById.get(gid), ...row, gid, rank: row.rank ?? index + 1 }
    })
  }
  const roles = {}
  for (const node of nodes) roles[node.role] = (roles[node.role] || 0) + 1
  const whyById = new Map(top.map(row => [row.gid, row.why]))
  return {
    ...raw,
    meta: {
      ...(raw.meta || {}),
      n_nodes: raw.meta?.n_nodes ?? raw.meta?.nodes ?? nodes.length,
      n_edges: raw.meta?.n_edges ?? raw.meta?.edges ?? links.length,
      roles: raw.meta?.roles || roles,
    },
    nodes: nodes.map(node => ({ ...node, why: whyById.get(node.id) })),
    links,
    top,
    clusters: (raw.clusters || []).map(cluster => ({ ...cluster, top_gids: Array.isArray(cluster.top_gids) ? cluster.top_gids : String(cluster.top_gids || '').split(';').filter(Boolean) })),
    transactions: raw.transactions || [],
    transactionsAvailable: raw.meta?.transactions_available ?? Array.isArray(raw.transactions),
    timeseries: raw.timeseries || [],
  }
}
