// Accept both the official graph-engine contract (gid/metrics/flags/edges)
// and the legacy UI contract (id/links/top).
export function normalizeGraphPayload(raw) {
  const nodes = (raw.nodes || []).map((node) => {
    const metrics = node.metrics || {}
    const flags = Array.isArray(node.flags) ? node.flags : []
    return {
      ...metrics,
      ...node,
      id: String(node.id ?? node.gid),
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
  return {
    ...raw,
    meta: {
      ...(raw.meta || {}),
      n_nodes: raw.meta?.n_nodes ?? raw.meta?.nodes ?? nodes.length,
      n_edges: raw.meta?.n_edges ?? raw.meta?.edges ?? links.length,
      roles: raw.meta?.roles || roles,
    },
    nodes,
    links,
    top,
    clusters: raw.clusters || [],
    transactions: raw.transactions || [],
    timeseries: raw.timeseries || [],
  }
}
