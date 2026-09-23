export const ROLE_COLORS = {
  coordinator: '#b08717',
  consolidator: '#d84c4c',
  distributor: '#df8132',
  transit: '#3d8ccc',
  terminal: '#278c69',
  boundary: '#8a6bb0',
  peripheral: '#8c97a6',
}

export const ROLE_LABELS = {
  coordinator: 'Координация',
  consolidator: 'Сбор средств',
  distributor: 'Распределение',
  transit: 'Транзит',
  terminal: 'Удержание средств',
  boundary: 'Граница данных',
  peripheral: 'Периферия',
}

export function endpointId(value) {
  return String(value && typeof value === 'object' ? value.id ?? value.gid : value)
}

export function nodeMatchesFilters(node, filters = {}) {
  return (
    (!filters.role || filters.role === 'all' || node.role === filters.role) &&
    (filters.depth == null || filters.depth === 'all' || Number(node.depth) === Number(filters.depth)) &&
    (!filters.seed || filters.seed === 'all' || Boolean(node.is_seed) === (filters.seed === 'seed'))
  )
}

function compareNodes(a, b) {
  return Number(b.priority_score || 0) - Number(a.priority_score || 0) || a.id.localeCompare(b.id)
}

function adjacency(nodes, links) {
  const maps = { incoming: new Map(), outgoing: new Map() }
  for (const node of nodes) {
    maps.incoming.set(node.id, [])
    maps.outgoing.set(node.id, [])
  }
  for (const link of links) {
    maps.outgoing.get(link.source)?.push({ id: link.target, amount: Number(link.sum_kzt || 0) })
    maps.incoming.get(link.target)?.push({ id: link.source, amount: Number(link.sum_kzt || 0) })
  }
  for (const map of Object.values(maps)) {
    for (const neighbors of map.values()) {
      neighbors.sort((a, b) => b.amount - a.amount || a.id.localeCompare(b.id))
    }
  }
  return maps
}

// Interleave payers and recipients. A large outgoing fan must never consume
// the entire display budget before any payer has been considered.
function balancedNeighbors(id, maps) {
  const incoming = maps.incoming.get(id) || []
  const outgoing = maps.outgoing.get(id) || []
  const result = []
  const seen = new Set([id])
  for (let index = 0; index < Math.max(incoming.length, outgoing.length); index++) {
    for (const item of [incoming[index], outgoing[index]]) {
      if (item && !seen.has(item.id)) {
        seen.add(item.id)
        result.push(item.id)
      }
    }
  }
  return result
}

/** Build a view without changing transaction directions, amounts or source data. */
export function buildGraphView(data, options = {}) {
  const { mode = 'ego', filters = {}, hop = 1, limit = 80 } = options
  const rootId = options.rootId == null ? null : String(options.rootId)
  const nodes = (data?.nodes || []).map((node) => ({ ...node, id: String(node.id ?? node.gid) }))
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const links = (data?.links || data?.edges || []).map((link) => ({
    ...link,
    source: endpointId(link.source ?? link.src),
    target: endpointId(link.target ?? link.dst),
  })).filter((link) => byId.has(link.source) && byId.has(link.target))
  const maps = adjacency(nodes, links)
  let candidates = []
  if (mode === 'priority') {
    const top = data?.top?.length
      ? data.top.slice(0, 30).map((row) => String(row.gid ?? row.id))
      : [...nodes].sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity) || compareNodes(a, b)).slice(0, 30).map((node) => node.id)
    candidates = [...new Set(top)].filter((id) => byId.has(id))
  } else if (mode === 'cluster') {
    candidates = nodes.filter((node) => String(node.cluster_id) === String(options.clusterId)).sort(compareNodes).map((node) => node.id)
  } else if (rootId && byId.has(rootId)) {
    const seen = new Set([rootId])
    let frontier = [rootId]
    candidates = [rootId]
    for (let step = 0; step < Math.min(2, Math.max(1, Number(hop) || 1)); step++) {
      const next = []
      const lists = frontier.map((id) => balancedNeighbors(id, maps))
      // Round-robin across frontier nodes also avoids letting one second-hop
      // hub hide every other branch when a view is limited.
      for (let index = 0; index < Math.max(0, ...lists.map((list) => list.length)); index++) {
        for (const list of lists) {
          const id = list[index]
          if (id && !seen.has(id)) {
            seen.add(id)
            next.push(id)
            candidates.push(id)
          }
        }
      }
      frontier = next
    }
  }

  const rootExcludedByFilters = mode === 'ego' && byId.has(rootId) && !nodeMatchesFilters(byId.get(rootId), filters)
  const matched = candidates.filter((id) => nodeMatchesFilters(byId.get(id), filters))
  const available = rootExcludedByFilters ? [rootId, ...matched] : matched
  const availableSet = new Set(available)
  const maxNodes = Number.isFinite(Number(limit)) ? Math.max(1, Math.floor(Number(limit))) : available.length
  const visibleIds = available.slice(0, maxNodes)
  const visibleSet = new Set(visibleIds)
  const availableLinks = links.filter((link) => availableSet.has(link.source) && availableSet.has(link.target))
  const visibleLinks = availableLinks.filter((link) => visibleSet.has(link.source) && visibleSet.has(link.target))
  const pairs = new Set(visibleLinks.map((link) => `${link.source}|${link.target}`))
  const directIncoming = new Set((maps.incoming.get(rootId) || []).map((node) => node.id))
  const directOutgoing = new Set((maps.outgoing.get(rootId) || []).map((node) => node.id))

  return {
    mode,
    rootId,
    nodes: visibleIds.map((id) => ({
      ...byId.get(id),
      _isRoot: mode === 'ego' && id === rootId,
      _contextOnly: Boolean(rootExcludedByFilters && id === rootId),
      _direction: id === rootId ? 'root' : directIncoming.has(id) && directOutgoing.has(id) ? 'both' : directIncoming.has(id) ? 'in' : directOutgoing.has(id) ? 'out' : 'indirect',
    })),
    links: visibleLinks.map((link) => ({
      ...link,
      _curvature: link.source === link.target ? 0.6 : pairs.has(`${link.target}|${link.source}`) ? 0.17 : 0,
    })),
    summary: {
      visibleNodes: visibleIds.length,
      availableNodes: available.length,
      visibleEdges: visibleLinks.length,
      availableEdges: availableLinks.length,
      hiddenNodes: available.length - visibleIds.length,
      filteredNodes: candidates.length - matched.length,
      rootExcludedByFilters,
    },
  }
}

function componentsOf(nodes, links) {
  const neighbors = new Map(nodes.map((node) => [node.id, []]))
  for (const link of links) {
    neighbors.get(link.source).push(link.target)
    neighbors.get(link.target).push(link.source)
  }
  const unseen = new Set(nodes.map((node) => node.id))
  const components = []
  for (const node of nodes) {
    if (!unseen.delete(node.id)) continue
    const component = [node.id]
    for (let index = 0; index < component.length; index++) {
      for (const neighbor of neighbors.get(component[index])) {
        if (unseen.delete(neighbor)) component.push(neighbor)
      }
    }
    components.push(component)
  }
  return components.sort((a, b) => b.length - a.length)
}

/** Stable coordinates; geometry never substitutes for the direction of money. */
export function layoutGraphView(view) {
  const nodes = view.nodes.map((node) => ({ ...node }))
  const links = view.links.map((link) => ({ ...link }))
  const place = (node, x, y) => Object.assign(node, { x, y, fx: x, fy: y })
  if (view.mode === 'ego') {
    const lanes = { in: [], out: [], both: [], indirect: [] }
    for (const node of nodes) {
      if (node._isRoot) place(node, 0, 0)
      else lanes[node._direction]?.push(node)
    }
    for (const [direction, sign] of [['in', -1], ['out', 1]]) {
      const lane = lanes[direction]
      const rows = Math.min(8, lane.length)
      lane.forEach((node, index) => {
        const col = Math.floor(index / 8)
        const row = index % 8
        place(node, sign * (240 + col * 100), (row - (Math.min(rows, lane.length - col * 8) - 1) / 2) * 46)
      })
    }
    lanes.both.forEach((node, index) => place(node, (index % 2 ? -1 : 1) * 55, 100 + Math.floor(index / 2) * 48))
    const outer = lanes.indirect
    const radiusX = Math.max(440, 340 + Math.ceil(Math.max(lanes.in.length, lanes.out.length) / 8) * 100)
    const radiusY = Math.max(450, Math.ceil(outer.length / 2) * 14)
    outer.forEach((node, index) => {
      const angle = 2 * Math.PI * index / Math.max(1, outer.length)
      place(node, Math.cos(angle) * radiusX, Math.sin(angle) * radiusY)
    })
  } else {
    const byId = new Map(nodes.map((node) => [node.id, node]))
    const components = componentsOf(nodes, links)
    const boxSizes = components.map((component) => Math.max(112, 84 * Math.sqrt(component.length - 1) + 100))
    const shelfWidth = Math.max(1, ...boxSizes, Math.sqrt(boxSizes.reduce((sum, side) => sum + side * side, 0)) * 1.3)
    let shelfX = 0
    let shelfY = 0
    let shelfHeight = 0
    components.forEach((component, componentIndex) => {
      const boxSize = boxSizes[componentIndex]
      if (shelfX > 0 && shelfX + boxSize > shelfWidth) {
        shelfX = 0
        shelfY += shelfHeight
        shelfHeight = 0
      }
      const centerX = shelfX + boxSize / 2
      const centerY = shelfY + boxSize / 2
      shelfX += boxSize
      shelfHeight = Math.max(shelfHeight, boxSize)
      const ordered = component.map((id) => byId.get(id)).sort(compareNodes)
      ordered.forEach((node, index) => {
        if (index === 0) return place(node, centerX, centerY)
        // Golden-angle placement keeps nodes separated without assigning
        // an invented parent/child hierarchy to a transaction network.
        const angle = index * Math.PI * (3 - Math.sqrt(5))
        const radius = 42 * Math.sqrt(index)
        place(node, centerX + Math.cos(angle) * radius, centerY + Math.sin(angle) * radius)
      })
    })
  }
  return { nodes, links }
}

export function nodeRadius(node, scale = 1) {
  const priority = Math.max(0, Math.min(1, Number(node.priority_score) || 0))
  const safeScale = Math.max(0.025, Number(scale) || 1)
  // Keep low-zoom views selectable, while retaining a visible priority signal.
  return Math.max(5.5 + 7 * priority, (4 + 2 * priority) / safeScale)
}

export function graphFit(nodes, width, height, padding = 40) {
  if (!nodes.length || width <= 0 || height <= 0) return null
  const xs = nodes.map((node) => node.x)
  const ys = nodes.map((node) => node.y)
  const minX = Math.min(...xs) - 24
  const maxX = Math.max(...xs) + 24
  const minY = Math.min(...ys) - 24
  const maxY = Math.max(...ys) + 24
  return {
    x: (minX + maxX) / 2,
    y: (minY + maxY) / 2,
    zoom: Math.max(0.025, Math.min(1.5, Math.max(1, width - padding * 2) / (maxX - minX), Math.max(1, height - padding * 2) / (maxY - minY))),
  }
}
