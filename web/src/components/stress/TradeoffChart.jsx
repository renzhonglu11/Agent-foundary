import { useState } from 'react'
import { Box, Stack, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material'
import { ScatterChart } from '@mui/x-charts/ScatterChart'
import { useXScale, useYScale } from '@mui/x-charts/hooks'
import { compactCurrency, number } from '../../utils/formatters.js'
import { rowReduction } from '../../utils/portfolioComparison.js'
import { displayPoint, tradeoffDomain } from '../../utils/tradeoffChart.js'

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

// Short labels: whole euros below 1,000, compact above.
const axisMoney = value => (Math.abs(value) >= 1000 ? compactCurrency(value) : `${Math.round(value)} €`)
// Tick numbers carry no unit (the axis titles say €) and use a Latin font:
// measured in the CJK body font, the x-axis dropped every label as too wide.
const tickNumber = value => (Math.abs(value) >= 1000 ? `${number.format(Math.round(value / 100) / 10)}K` : String(Math.round(value)))
const TICK_STYLE = { fontFamily: 'Inter, "Segoe UI", system-ui, sans-serif', fontSize: 11 }
const MAX_PINNED_LABELS = 3

// Points beyond the focused range: a dashed ring where they are pinned and
// their real numbers beside it.
function PinnedMarks({ points }) {
  const xScale = useXScale()
  const yScale = useYScale()
  return (
    <g pointerEvents="none">
      {points.map((point, index) => {
        const cx = xScale(point.shown.x)
        const cy = yScale(point.shown.y)
        const left = cx > (xScale.range()[0] + xScale.range()[1]) / 2
        return (
          <g key={point.id}>
            <circle cx={cx} cy={cy} r={9} fill="none" stroke="#4a5a6c" strokeWidth={1.2} strokeDasharray="3 2" />
            {index < MAX_PINNED_LABELS ? (
              <text x={left ? cx - 13 : cx + 13} y={cy + 4} textAnchor={left ? 'end' : 'start'} fontSize={11} fill="#4a5a6c">
                实际 {axisMoney(point.x)} / {axisMoney(point.y)}
              </text>
            ) : null}
          </g>
        )
      })}
    </g>
  )
}

export default function TradeoffChart({ rows, reductions, reductionPct, onToggle }) {
  const [focus, setFocus] = useState(true)
  const raw = rows.map(row => ({ id: row.id, x: row.upGivenUp, y: row.worstImprovement }))
  const domain = tradeoffDomain(raw, { focus })
  const shownById = new Map(raw.map(point => [point.id, displayPoint(point, domain)]))
  const pinned = raw.filter(point => shownById.get(point.id).clipped)
    .map(point => ({ ...point, shown: shownById.get(point.id) }))
    .sort((left, right) => Math.max(right.x, right.y) - Math.max(left.x, left.y))

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
      data: pointsBySeries.get(kind.id).map(row => ({ id: row.id, ...shownById.get(row.id) })),
      valueFormatter: (_value, { dataIndex }) => {
        const row = pointsBySeries.get(kind.id)[dataIndex]
        if (!row) return ''
        const ratio = row.kind === 'tradeoff' ? `效率 ${number.format(row.efficiency)}` : kind.id === SELECTED.id ? '已在方案中' : kind.label
        const pinnedNote = shownById.get(row.id)?.clipped ? '（超出范围，按同一效率缩到边缘）' : ''
        return `${row.name}：最差改善 ${compactCurrency(row.worstImprovement)} · 放弃上涨 ${compactCurrency(row.upGivenUp)} · ${ratio}${pinnedNote}`
      },
    }))

  if (!rows.length) return null
  // Both axes share one range so equal euros are equal distances.
  const axis = { min: domain.min, max: domain.max, valueFormatter: tickNumber, tickLabelStyle: TICK_STYLE }
  return (
    <Box sx={{ border: '1px solid #d9e2ec', borderRadius: 2, backgroundColor: '#ffffff', p: 1, minWidth: 0 }}>
      <Stack direction="row" spacing={1} sx={{ px: 0.5, alignItems: 'flex-start', justifyContent: 'space-between' }}>
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="body2" fontWeight={800}>减仓取舍图</Typography>
          <Typography variant="caption" color="text.secondary" component="div">
            每个点是把一个仓位减 {reductionPct}% 的效果。虚线上方的点保护多于代价；点击可加入或移出自定义方案。
          </Typography>
        </Box>
        {domain.canFocus ? (
          <ToggleButtonGroup size="small" exclusive value={focus ? 'focus' : 'all'} onChange={(_event, value) => value && setFocus(value === 'focus')} aria-label="显示范围" sx={{ flexShrink: 0 }}>
            <ToggleButton value="focus" sx={{ px: 1, py: 0.25, fontSize: 12 }}>聚焦主体</ToggleButton>
            <ToggleButton value="all" sx={{ px: 1, py: 0.25, fontSize: 12 }}>显示全部</ToggleButton>
          </ToggleButtonGroup>
        ) : null}
      </Stack>
      <ScatterChart
        height={300}
        series={series}
        xAxis={[{ ...axis, label: '放弃的上涨（€）', tickLabelMinGap: 2, height: 52 }]}
        yAxis={[{ ...axis, label: '最差情景改善（€）', width: 64 }]}
        grid={{ horizontal: true, vertical: true }}
        margin={{ left: 8, right: 16, top: 8, bottom: 8 }}
        slotProps={{ legend: { direction: 'horizontal', position: { vertical: 'top', horizontal: 'start' } } }}
        onItemClick={(_event, item) => {
          const row = pointsBySeries.get(item?.seriesId)?.[item?.dataIndex]
          if (row) onToggle(row)
        }}
      >
        <EfficiencyLine />
        <PinnedMarks points={pinned} />
      </ScatterChart>
      {pinned.length ? (
        <Typography variant="caption" color="text.secondary" component="div" sx={{ px: 0.5 }}>
          {pinned.length} 个仓位离得太远，沿原点连线缩到边缘显示（虚线圈），在效率线哪一侧不变{pinned.length > MAX_PINNED_LABELS ? `；最大的 ${MAX_PINNED_LABELS} 个标出实际数值` : '；旁边是实际数值'}。悬停可看全部数字。
        </Typography>
      ) : null}
    </Box>
  )
}
