import { Box, Typography } from '@mui/material'
import { ScatterChart } from '@mui/x-charts/ScatterChart'
import { useXScale, useYScale } from '@mui/x-charts/hooks'
import { compactCurrency, number } from '../../utils/formatters.js'
import { rowReduction } from '../../utils/portfolioComparison.js'

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

// Short tick labels: whole euros below 1,000, compact above.
const axisMoney = value => (Math.abs(value) >= 1000 ? compactCurrency(value) : `${Math.round(value)} €`)

export default function TradeoffChart({ rows, reductions, reductionPct, onToggle }) {
  const pointsBySeries = new Map([...KINDS, SELECTED].map(kind => [kind.id, []]))
  for (const row of rows) {
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
  return (
    <Box sx={{ border: '1px solid #e5eaef', borderRadius: 2, backgroundColor: '#ffffff', p: 1, minWidth: 0 }}>
      <Typography variant="body2" fontWeight={800} sx={{ px: 0.5 }}>减仓取舍图</Typography>
      <Typography variant="caption" color="text.secondary" component="div" sx={{ px: 0.5 }}>
        每个点是把一个仓位减 {reductionPct}% 的效果。虚线上方的点保护多于代价；点击可加入或移出自定义方案。
      </Typography>
      <ScatterChart
        height={280}
        series={series}
        xAxis={[{ label: '放弃的上涨（€）', valueFormatter: axisMoney }]}
        yAxis={[{ label: '最差情景改善（€）', valueFormatter: axisMoney, width: 76 }]}
        grid={{ horizontal: true }}
        margin={{ left: 8, right: 16, top: 8, bottom: 8 }}
        slotProps={{ legend: { direction: 'horizontal', position: { vertical: 'top', horizontal: 'start' } } }}
        onItemClick={(_event, item) => {
          const row = pointsBySeries.get(item?.seriesId)?.[item?.dataIndex]
          if (row) onToggle(row)
        }}
      >
        <EfficiencyLine />
      </ScatterChart>
    </Box>
  )
}
