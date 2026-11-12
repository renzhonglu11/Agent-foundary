import { useEffect, useRef, useState } from 'react'
import { Box, Button, Stack, Typography } from '@mui/material'
import ZoomOutMapRoundedIcon from '@mui/icons-material/ZoomOutMapRounded'
import { ScatterChart } from '@mui/x-charts/ScatterChart'
import { ChartsBrushOverlay } from '@mui/x-charts/ChartsBrushOverlay'
import { useBrush, useXScale, useYScale } from '@mui/x-charts/hooks'
import { compactCurrency, number } from '../../utils/formatters.js'
import { rowReduction } from '../../utils/portfolioComparison.js'
import { fullView, inView, viewFromBox } from '../../utils/tradeoffChart.js'

const KINDS = [
  { id: 'tradeoff', label: '取舍', color: '#1f6fd1' },
  { id: 'free', label: '无上涨代价', color: '#1a9e72' },
  { id: 'neutral', label: '无影响', color: '#9aa6b4' },
  { id: 'hedge', label: '对冲仓位', color: '#e0702e' },
]
const SELECTED = { id: 'selected', label: '已在自定义方案', color: '#0b3d91' }

// Efficiency = 1 is the line y = x: points above it buy more downside
// protection than the upside they give up.
function EfficiencyLine() {
  const xScale = useXScale()
  const yScale = useYScale()
  const [x0, x1] = xScale.domain()
  const [y0, y1] = yScale.domain()
  const start = Math.max(x0, y0)
  const end = Math.min(x1, y1)
  if (!(end > start)) return null
  // Label part-way along the line so it never sits on the plot edge.
  const labelAt = start + (end - start) * 0.8
  return (
    <g pointerEvents="none">
      <line x1={xScale(start)} y1={yScale(start)} x2={xScale(end)} y2={yScale(end)} stroke="#64748b" strokeWidth={1.5} strokeDasharray="5 4" />
      <text x={xScale(labelAt) + 6} y={yScale(labelAt) + 14} fontSize={11} fill="#475569">效率 = 1</text>
    </g>
  )
}

// Tick numbers carry no unit (the axis titles say €) and use a Latin font:
// measured in the CJK body font, the x-axis dropped every label as too wide.
const tickNumber = value => (Math.abs(value) >= 1000 ? `${number.format(Math.round(value / 100) / 10)}K` : String(Math.round(value)))
const TICK_STYLE = { fontFamily: 'Inter, "Segoe UI", system-ui, sans-serif', fontSize: 11 }

// The free chart package draws a selection box but does not zoom; when a drag
// ends, this turns the box into the next view.
function BrushToZoom({ view, onZoom }) {
  const brush = useBrush()
  const xScale = useXScale()
  const yScale = useYScale()
  const last = useRef(null)
  useEffect(() => {
    if (brush) {
      last.current = brush
      return
    }
    const done = last.current
    last.current = null
    if (!done) return
    const toData = point => ({ x: xScale.invert(point.x), y: yScale.invert(point.y) })
    const next = viewFromBox(toData(done.start), toData(done.current), view)
    if (next) onZoom(next)
  }, [brush, xScale, yScale, view, onZoom])
  return null
}

export default function TradeoffChart({ rows, reductions, reductionPct, onToggle }) {
  // A stack of views: each drag pushes one, "back" pops one.
  const [zoomStack, setZoomStack] = useState([])
  const points = rows.map(row => ({ id: row.id, x: row.upGivenUp, y: row.worstImprovement }))
  const full = fullView(points)
  const view = zoomStack.at(-1) ?? full
  const zoomed = zoomStack.length > 0
  const visibleIds = new Set(points.filter(point => inView(point, view)).map(point => point.id))
  const visibleRows = rows.filter(row => visibleIds.has(row.id))

  const pointsBySeries = new Map([...KINDS, SELECTED].map(kind => [kind.id, []]))
  for (const row of visibleRows) {
    const inPlan = rowReduction(reductions, row.productIds) !== 0
    pointsBySeries.get(inPlan ? SELECTED.id : row.kind)?.push(row)
  }
  const series = [...KINDS, SELECTED]
    .filter(kind => pointsBySeries.get(kind.id).length)
    .map(kind => ({
      id: kind.id,
      label: kind.label,
      color: kind.color,
      markerSize: kind.id === SELECTED.id ? 7 : 5,
      data: pointsBySeries.get(kind.id).map(row => ({ id: row.id, x: row.upGivenUp, y: row.worstImprovement })),
      valueFormatter: (_value, { dataIndex }) => {
        const row = pointsBySeries.get(kind.id)[dataIndex]
        if (!row) return ''
        const ratio = row.kind === 'tradeoff' ? `效率 ${number.format(row.efficiency)}` : kind.id === SELECTED.id ? '已在方案中' : kind.label
        return `${row.name}：最差改善 ${compactCurrency(row.worstImprovement)} · 放弃上涨 ${compactCurrency(row.upGivenUp)} · ${ratio}`
      },
    }))

  if (!rows.length) return null
  const axisFor = range => ({ min: range[0], max: range[1], valueFormatter: tickNumber, tickLabelStyle: TICK_STYLE })
  return (
    <Box sx={{ border: '1px solid #d9e2ec', borderRadius: 2, backgroundColor: '#ffffff', p: 1, minWidth: 0 }}>
      <Stack direction="row" spacing={1} sx={{ px: 0.5, alignItems: 'flex-start', justifyContent: 'space-between' }}>
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="body2" fontWeight={800}>减仓取舍图</Typography>
          <Typography variant="caption" color="text.secondary" component="div">
            每个点是把一个仓位减 {reductionPct}% 的效果。虚线上方的点保护多于代价；点击加入或移出自定义方案，拖动框选可放大。
          </Typography>
        </Box>
        {zoomed ? (
          <Stack direction="row" spacing={0.5} sx={{ flexShrink: 0 }}>
            {zoomStack.length > 1 ? <Button size="small" onClick={() => setZoomStack(current => current.slice(0, -1))}>上一步</Button> : null}
            <Button size="small" variant="outlined" startIcon={<ZoomOutMapRoundedIcon />} onClick={() => setZoomStack([])}>全部</Button>
          </Stack>
        ) : null}
      </Stack>
      <ScatterChart
        height={300}
        series={series}
        xAxis={[{ ...axisFor(view.x), label: '放弃的上涨（€）', tickLabelMinGap: 2, height: 52 }]}
        yAxis={[{ ...axisFor(view.y), label: '最差情景改善（€）', width: 64 }]}
        grid={{ horizontal: true, vertical: true }}
        margin={{ left: 8, right: 16, top: 8, bottom: 8 }}
        brushConfig={{ enabled: true }}
        slotProps={{ legend: { direction: 'horizontal', position: { vertical: 'top', horizontal: 'start' } } }}
        onItemClick={(_event, item) => {
          const row = pointsBySeries.get(item?.seriesId)?.[item?.dataIndex]
          if (row) onToggle(row)
        }}
      >
        <EfficiencyLine />
        <ChartsBrushOverlay />
        <BrushToZoom view={view} onZoom={next => setZoomStack(current => [...current, next])} />
      </ScatterChart>
      {zoomed ? (
        <Typography variant="caption" color="text.secondary" component="div" sx={{ px: 0.5 }}>
          已放大：显示 {visibleRows.length} / {rows.length} 个仓位；两轴刻度可能不同，以虚线判断效率。
        </Typography>
      ) : null}
    </Box>
  )
}
