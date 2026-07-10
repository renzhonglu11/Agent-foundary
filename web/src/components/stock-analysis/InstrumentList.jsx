import { useMemo, useState } from 'react'
import { Box, Chip, Collapse, IconButton, Stack, Tooltip, Typography } from '@mui/material'
import KeyboardArrowDownRoundedIcon from '@mui/icons-material/KeyboardArrowDownRounded'
import KeyboardArrowRightRoundedIcon from '@mui/icons-material/KeyboardArrowRightRounded'

import { preciseCurrency } from '../../utils/formatters.js'
import DetailPanel from './DetailPanel.jsx'
import { formatNumber2, formatPercent2 } from './stockAnalysisUi.js'

const riskStatusColors = {
  'HARD_BLOCKED': 'error',
  'WATCH': 'warning',
  'OK': 'success'
}

const riskStatusLabels = {
  HARD_BLOCKED: '立即处理',
  WATCH: '需关注',
  OK: '正常',
}

export default function InstrumentList({ title, rows, emptyText, riskGroup, groupDeltaExposure }) {
  const [expandedInstrumentId, setExpandedInstrumentId] = useState(null)
  const sortedRows = useMemo(() => [...rows].sort((left, right) => {
    const leftRisk = riskGroup?.legs?.find((leg) => leg.isin === left.symbol)
    const rightRisk = riskGroup?.legs?.find((leg) => leg.isin === right.symbol)
    const rank = { HARD_BLOCKED: 0, WATCH: 1, OK: 2 }
    const riskDifference = (rank[leftRisk?.legRiskStatus] ?? 3) - (rank[rightRisk?.legRiskStatus] ?? 3)
    if (riskDifference) return riskDifference
    return Math.abs(Number(right.deltaExposureEur) || 0) - Math.abs(Number(left.deltaExposureEur) || 0)
  }), [riskGroup, rows])

  return (
    <Box sx={{ border: '1px solid #e5eaef', borderRadius: 2, overflow: 'hidden', backgroundColor: '#fff' }}>
      <Box sx={{ px: 1.5, py: 1, backgroundColor: '#f8fafc', borderBottom: '1px solid #e5eaef' }}>
        <Typography variant="body2" fontWeight={800}>{title} · {rows.length}</Typography>
      </Box>
      {sortedRows.length ? sortedRows.map((item) => {
        const open = expandedInstrumentId === item.id
        const riskLeg = riskGroup?.legs?.find(l => l.isin === item.symbol)
        
        return (
          <Box key={item.id} sx={{ borderBottom: '1px solid #edf2f7', '&:last-child': { borderBottom: 0 } }}>
            <Box
              onClick={() => setExpandedInstrumentId(open ? null : item.id)}
              sx={{ px: 1.5, py: 1.5, cursor: 'pointer', display: 'grid', gridTemplateColumns: { xs: '1fr', lg: 'minmax(260px, 1fr) 130px 190px 120px' }, alignItems: 'center', gap: { xs: 1, lg: 2 } }}
            >
              <Stack direction="row" spacing={1} sx={{ alignItems: 'center', minWidth: 0 }}>
                <IconButton size="small" onClick={(event) => { event.stopPropagation(); setExpandedInstrumentId(open ? null : item.id) }}>
                  {open ? <KeyboardArrowDownRoundedIcon /> : <KeyboardArrowRightRoundedIcon />}
                </IconButton>
                <Box sx={{ minWidth: 0 }}>
                  <Typography variant="body2" fontWeight={800} noWrap>{cleanInstrumentName(item.stockName)}</Typography>
                  <Typography variant="caption" color="text.secondary" noWrap>{item.symbol}</Typography>
                </Box>
              </Stack>

              <Box>
                {riskLeg ? (
                  <Tooltip title={`数据置信度：${riskLeg.exposureConfidence}${riskLeg.quoteAgeHours ? ` · 行情 ${riskLeg.quoteAgeHours.toFixed(1)} 小时前` : ''}`}>
                    <Chip size="small" color={riskStatusColors[riskLeg.legRiskStatus] || 'default'} label={riskStatusLabels[riskLeg.legRiskStatus] || '待评估'} sx={{ height: 24, fontWeight: 800 }} />
                  </Tooltip>
                ) : <Typography variant="caption" color="text.secondary">待评估</Typography>}
              </Box>
              <Box>
                <InlineMetric label={item.deltaExposureEstimated ? '估算敞口' : '敞口'} value={formatMetricCurrency(item.deltaExposureEur)} tone="secondary.main" />
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>{exposureShare(item.deltaExposureEur, groupDeltaExposure)}</Typography>
              </Box>
              <Box>
                {riskLeg?.daysToExpiry != null ? <InlineMetric label="剩余" value={`${riskLeg.daysToExpiry} 天`} tone={riskLeg.daysToExpiry < 90 ? 'warning.main' : undefined} /> : null}
                {item.isDerivative ? <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>盈亏平衡距离 {formatBreakEven(item)}</Typography> : null}
              </Box>
            </Box>
            <Collapse in={open} timeout="auto" unmountOnExit>
              <Box sx={{ px: 1.5, pb: 1.5 }}>
                <DetailPanel row={item} />
              </Box>
            </Collapse>
          </Box>
        )
      }) : (
        <Box sx={{ px: 1.5, py: 2 }}><Typography variant="body2" color="text.secondary">{emptyText}</Typography></Box>
      )}
    </Box>
  )
}

function formatMetricCurrency(value) {
  return Number.isFinite(Number(value)) ? preciseCurrency.format(value) : '—'
}

function formatBreakEven(item) {
  if (!Number.isFinite(Number(item.breakEvenDistanceAbs)) || !Number.isFinite(Number(item.breakEvenDistancePct))) return '—'
  return formatPercent2(item.breakEvenDistancePct)
}

function exposureShare(value, total) {
  const numeric = Math.abs(Number(value))
  const totalNumeric = Math.abs(Number(total))
  if (!Number.isFinite(numeric) || !Number.isFinite(totalNumeric) || totalNumeric === 0) return '占组敞口 —'
  return `占组敞口 ${formatNumber2((numeric / totalNumeric) * 100)}%`
}

function InlineMetric({ label, value, tone = 'text.primary' }) {
  return (
    <Typography variant="caption" sx={{ color: tone, fontWeight: 800, whiteSpace: 'nowrap' }}>
      {label} {value}
    </Typography>
  )
}

function cleanInstrumentName(value) {
  return String(value || '').split(' · ')[0]
}
