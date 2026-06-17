import { Box, Chip, Stack, Typography } from '@mui/material'
import WarningAmberRoundedIcon from '@mui/icons-material/WarningAmberRounded'

import { preciseCurrency } from '../../utils/formatters.js'
import InstrumentList from './InstrumentList.jsx'

export default function GroupDetailPanel({ group, riskGroup }) {
  const dataIssueCount = riskGroup?.legs?.filter(hasDataIssue).length || 0
  const expiryRiskCount = riskGroup?.legs?.filter(hasExpiryRisk).length || 0
  const nearestExpiryDays = nearestExpiry(group.derivatives)
  const actionLabel = riskGroup?.groupActionLabel?.replace(/_/g, ' ') || 'No risk action'

  return (
    <Box sx={{ px: 2, py: 2, borderRadius: 2, border: '1px solid #e5eaef', backgroundColor: '#fbfdff' }}>
      <Stack spacing={1.5}>
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5} sx={{ alignItems: { xs: 'flex-start', md: 'center' }, justifyContent: 'space-between' }}>
          <Box>
            <Typography variant="h6" fontWeight={800}>{group.groupName}</Typography>
            <Typography variant="caption" color="text.secondary">实时数据 {group.liveDerivativeCount}/{group.derivativeCount || 0}</Typography>
          </Box>
          <Chip size="small" color={actionColor(riskGroup?.groupActionLabel)} label={actionLabel} sx={{ fontWeight: 800 }} />
        </Stack>

        <Stack direction="row" spacing={1.5} useFlexGap sx={{ flexWrap: 'wrap' }}>
          <SummaryMetric label="Delta Exposure" value={group.deltaExposure != null ? preciseCurrency.format(group.deltaExposure) : '—'} />
          <SummaryMetric label="Gross Weight" value={riskGroup ? weightPercent(riskGroup.grossWeightPct) : '—'} />
          <SummaryMetric label="衍生品" value={group.derivativeCount} />
          <SummaryMetric label="最近到期" value={nearestExpiryDays == null ? '—' : `${nearestExpiryDays}d`} />
        </Stack>

        {dataIssueCount > 0 ? (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 1.25, py: 1, borderRadius: 1.5, border: '1px solid #ffe1a6', backgroundColor: '#fff8e6' }}>
            <WarningAmberRoundedIcon color="warning" fontSize="small" />
            <Typography variant="body2">数据不完整：{dataIssueCount} 个产品数据源不完整或过期</Typography>
          </Box>
        ) : null}

        {expiryRiskCount > 0 ? (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 1.25, py: 1, borderRadius: 1.5, border: '1px solid #ffd7c2', backgroundColor: '#fff3ed' }}>
            <WarningAmberRoundedIcon color="warning" fontSize="small" />
            <Typography variant="body2">临近到期：{expiryRiskCount} 个产品需要 close/roll</Typography>
          </Box>
        ) : null}

        <Stack spacing={1.25}>
          {group.stocks.length ? <InstrumentList title="股票 / ETF / Bond" rows={group.stocks} emptyText="这个 underlying 下没有普通持仓。" /> : null}
          {group.derivatives.length ? <InstrumentList title="金融衍生品" rows={group.derivatives} emptyText="这个 underlying 下没有金融衍生品。" defaultExpanded riskGroup={riskGroup} /> : null}
        </Stack>
      </Stack>
    </Box>
  )
}

function hasDataIssue(leg) {
  const score = Number(leg.dataCompletenessRiskScore)
  return leg.exposureConfidence === 'no_data' || (Number.isFinite(score) && score > 3)
}

function hasExpiryRisk(leg) {
  const days = Number(leg.daysToExpiry)
  return Number.isFinite(days) && days >= 0 && days < 7
}

function SummaryMetric({ label, value }) {
  return (
    <Box sx={{ minWidth: 120 }}>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', lineHeight: 1.2 }}>{label}</Typography>
      <Typography variant="body2" fontWeight={800}>{value}</Typography>
    </Box>
  )
}

function nearestExpiry(rows) {
  const today = new Date()
  const days = rows
    .map((row) => row.expiry ? Math.ceil((new Date(row.expiry).getTime() - today.getTime()) / 86400000) : null)
    .filter((value) => Number.isFinite(value) && value >= 0)
  return days.length ? Math.min(...days) : null
}

function actionColor(actionLabel) {
  if (actionLabel === 'ADD_ALLOWED') return 'success'
  if (actionLabel === 'HOLD_MONITOR') return 'warning'
  if (actionLabel === 'CLOSE_OR_ROLL_DERIVATIVE') return 'warning'
  if (actionLabel) return 'error'
  return 'default'
}

function weightPercent(value) {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? `${(numeric * 100).toFixed(1)}%` : '—'
}
