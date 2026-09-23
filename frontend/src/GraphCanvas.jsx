import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ForceGraph2D from 'react-force-graph-2d'
import { buildGraphView, endpointId, graphFit, layoutGraphView, nodeRadius, ROLE_COLORS, ROLE_LABELS } from './graphModel'
import './GraphCanvas.css'

const money = (value) => `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(Number(value) || 0)} ₸`

export default function GraphCanvas({ data, selectedId, rootId = selectedId, mode = 'ego', clusterId, filters = {}, hop = 1, limit = 80, onSelect, onSummary }) {
  const hostRef = useRef(null)
  const graphRef = useRef(null)
  const zoomRef = useRef(1)
  const summaryCallbackRef = useRef(onSummary)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [hoveredNode, setHoveredNode] = useState(null)
  const [hoveredLink, setHoveredLink] = useState(null)
  const view = useMemo(() => buildGraphView(data, { mode, rootId, clusterId, filters: { role: filters.role, depth: filters.depth, seed: filters.seed }, hop, limit }), [data, mode, rootId, clusterId, filters.role, filters.depth, filters.seed, hop, limit])
  const graphData = useMemo(() => layoutGraphView(view), [view])
  const activeId = hoveredNode?.id || (selectedId == null ? null : String(selectedId))
  const selectedVisible = selectedId == null || graphData.nodes.some((node) => node.id === String(selectedId))

  useEffect(() => {
    if (!hostRef.current) return
    const observer = new ResizeObserver(([entry]) => {
      setSize({ width: Math.floor(entry.contentRect.width), height: Math.floor(entry.contentRect.height) })
    })
    observer.observe(hostRef.current)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    summaryCallbackRef.current = onSummary
  }, [onSummary])

  useEffect(() => {
    summaryCallbackRef.current?.({ ...view.summary, selectedVisible })
  }, [view.summary, selectedVisible])

  const fit = useCallback(() => {
    const frame = graphFit(graphData.nodes, size.width, size.height)
    if (frame && graphRef.current) {
      graphRef.current.centerAt(frame.x, frame.y, 280)
      graphRef.current.zoom(frame.zoom, 280)
    }
  }, [graphData, size.width, size.height])

  useEffect(() => {
    const timer = setTimeout(fit, 70)
    return () => clearTimeout(timer)
  }, [fit])

  const related = (link) => endpointId(link.source) === activeId || endpointId(link.target) === activeId

  return (
    <section className="gc-frame" aria-label={`Граф: ${view.summary.visibleNodes} узлов, ${view.summary.visibleEdges} направленных связей`}>
      <div className="gc-stage" ref={hostRef}>
        {size.width > 0 && size.height > 0 && graphData.nodes.length > 0 && (
          <ForceGraph2D
            ref={graphRef}
            graphData={graphData}
            width={size.width}
            height={size.height}
            nodeId="id"
            nodeRelSize={4}
            nodeVal={(node) => ((nodeRadius(node, zoomRef.current) + (node.is_seed ? 2.5 / zoomRef.current : 0)) / 4) ** 2}
            nodeLabel={() => ''}
            linkLabel={() => ''}
            linkCurvature={(link) => link._curvature}
            linkDirectionalArrowLength={() => Math.max(6, 4.5 / zoomRef.current)}
            linkDirectionalArrowRelPos={1}
            linkDirectionalArrowColor={(link) => related(link) ? '#1d5d51' : '#758796'}
            linkWidth={(link) => (related(link) ? 1.9 : 0.65) + Math.min(1.3, Math.log10(1 + Number(link.sum_kzt || 0)) / 6)}
            linkColor={(link) => related(link) ? 'rgba(32,103,86,0.78)' : 'rgba(105,124,140,0.29)'}
            linkHoverPrecision={7}
            backgroundColor="#f7faf9"
            cooldownTicks={0}
            warmupTicks={0}
            enableNodeDrag
            minZoom={0.025}
            maxZoom={6}
            onZoom={({ k }) => { zoomRef.current = Math.max(0.025, k) }}
            onNodeDragEnd={(node) => { node.fx = node.x; node.fy = node.y }}
            onNodeClick={(node) => onSelect?.(node.id)}
            onNodeHover={(node) => { setHoveredNode(node); if (node) setHoveredLink(null) }}
            onLinkHover={(link) => { setHoveredLink(link); if (link) setHoveredNode(null) }}
            nodePointerAreaPaint={(node, color, ctx, scale) => {
              ctx.beginPath()
              ctx.arc(node.x, node.y, Math.max(nodeRadius(node, scale) + 2 / scale, 6 / scale), 0, Math.PI * 2)
              ctx.fillStyle = color
              ctx.fill()
            }}
            nodeCanvasObject={(node, ctx, scale) => {
              const radius = nodeRadius(node, scale)
              const selected = node.id === String(selectedId)
              const hovered = node.id === hoveredNode?.id
              ctx.save()
              if (selected || hovered) {
                ctx.beginPath()
                ctx.arc(node.x, node.y, radius + 4 / scale, 0, Math.PI * 2)
                ctx.fillStyle = 'rgba(34,123,99,0.15)'
                ctx.fill()
              }
              ctx.beginPath()
              ctx.arc(node.x, node.y, radius, 0, Math.PI * 2)
              ctx.fillStyle = ROLE_COLORS[node.role] || ROLE_COLORS.peripheral
              ctx.globalAlpha = node._contextOnly ? 0.5 : 1
              ctx.fill()
              ctx.globalAlpha = 1
              ctx.strokeStyle = selected || hovered ? '#162f29' : '#fff'
              ctx.lineWidth = (selected || hovered ? 2 : 1) / scale
              ctx.stroke()
              if (node.is_seed) {
                ctx.beginPath()
                ctx.arc(node.x, node.y, radius + 2.5 / scale, 0, Math.PI * 2)
                ctx.strokeStyle = '#34495e'
                ctx.lineWidth = 1.3 / scale
                ctx.stroke()
              }
              if (selected || hovered || node._isRoot || scale >= 1.1) {
                const label = `…${node.id.slice(-6)}`
                ctx.font = `${selected || hovered ? 600 : 500} ${11 / scale}px system-ui, sans-serif`
                const width = ctx.measureText(label).width
                const x = node.x + radius + 5 / scale
                ctx.fillStyle = 'rgba(247,250,249,0.93)'
                ctx.fillRect(x - 2 / scale, node.y - 9 / scale, width + 4 / scale, 15 / scale)
                ctx.fillStyle = '#18392f'
                ctx.textAlign = 'left'
                ctx.textBaseline = 'middle'
                ctx.fillText(label, x, node.y)
              }
              ctx.restore()
            }}
          />
        )}
        {!graphData.nodes.length && <div className="gc-empty"><strong>В этом срезе нет узлов</strong><span>Измените фильтры или выберите другого клиента.</span></div>}
      </div>

      {(hoveredNode || hoveredLink) && <div className="gc-hover" role="status">
        {hoveredNode ? <>
          <strong>GID {hoveredNode.id}</strong>
          <span>{ROLE_LABELS[hoveredNode.role] || hoveredNode.role} · приоритет {Math.round((hoveredNode.priority_score || 0) * 100)}%</span>
          <span>{hoveredNode.in_deg ?? 0} плательщиков · {hoveredNode.out_deg ?? 0} получателей</span>
          <span>Вход {money(hoveredNode.in_kzt)} · выход {money(hoveredNode.out_kzt)}</span>
        </> : <>
          <strong>…{endpointId(hoveredLink.source).slice(-8)} → …{endpointId(hoveredLink.target).slice(-8)}</strong>
          <span>{money(hoveredLink.sum_kzt)} · {hoveredLink.n_tx ?? '—'} переводов</span>
        </>}
      </div>}

      <div className="gc-controls" aria-label="Масштаб графа">
        <button type="button" onClick={() => graphRef.current?.zoom(Math.min(6, (graphRef.current.zoom() || 1) * 1.35), 180)} aria-label="Приблизить граф">+</button>
        <button type="button" onClick={() => graphRef.current?.zoom(Math.max(0.025, (graphRef.current.zoom() || 1) / 1.35), 180)} aria-label="Отдалить граф">−</button>
        <button type="button" onClick={fit} className="gc-fit">Вместить</button>
      </div>
    </section>
  )
}
