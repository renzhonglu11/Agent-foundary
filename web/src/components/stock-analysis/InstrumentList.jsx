import { useState } from 'react'
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

export default function InstrumentList({ title, rows, emptyText, defaultExpanded = false, riskGroup }) {
  const [expandedInstrumentId, setExpandedInstrumentId] = useState(defaultExpanded && rows[0] ? rows[0].id : null)

  return (
    <Box sx={{ border: '1px solid #e5eaef', borderRadius: 2, overflow: 'hidden', backgroundColor: '#fff' }}>
      <Box sx={{ px: 1.5, py: 1, backgroundColor: '#f8fafc', borderBottom: '1px solid #e5eaef' }}>
        <Typography variant="body2" fontWeight={800}>{title} · {rows.length}</Typography>
      </Box>
      {rows.length ? rows.map((item) => {
        const open = expandedInstrumentId === item.id
        const riskLeg = riskGroup?.legs?.find(l => l.isin === item.symbol)
        
        return (
          <Box key={item.id} sx={{ borderBottom: '1px solid #edf2f7', '&:last-child': { borderBottom: 0 } }}>
            <Box
              onClick={() => setExpandedInstrumentId(open ? null : item.id)}
              sx={{ px: 1.5, py: 1.5, cursor: 'pointer', display: 'flex', flexDirection: { xs: 'column', lg: 'row' }, alignItems: { xs: 'stretch', lg: 'center' }, gap: 2 }}
            >
              <Stack direction="row" spacing={1} sx={{ alignItems: 'center', minWidth: 250, flex: 1 }}>
                <IconButton size="small" onClick={(event) => { event.stopPropagation(); setExpandedInstrumentId(open ? null : item.id) }}>
                  {open ? <KeyboardArrowDownRoundedIcon /> : <KeyboardArrowRightRoundedIcon />}
                </IconButton>
                <Box sx={{ minWidth: 0 }}>
                  <Typography variant="body2" fontWeight={800} noWrap>{cleanInstrumentName(item.stockName)}</Typography>
                  <Typography variant="caption" color="text.secondary" noWrap>{item.symbol}</Typography>
                </Box>
              </Stack>

              <Stack direction="row" spacing={1.5} useFlexGap sx={{ flexWrap: 'wrap', minWidth: 360, justifyContent: { xs: 'flex-start', lg: 'flex-end' }, alignItems: 'center' }}>
                {riskLeg ? (
                  <Tooltip title={`Confidence: ${riskLeg.exposureConfidence}${riskLeg.quoteAgeHours ? ` · Quote ${riskLeg.quoteAgeHours.toFixed(1)}h` : ''}`}>
                    <Chip size="small" color={riskStatusColors[riskLeg.legRiskStatus] || 'default'} label={riskLeg.legRiskStatus} sx={{ height: 24, fontWeight: 800 }} />
                  </Tooltip>
                ) : null}
                {riskLeg?.daysToExpiry != null ? <InlineMetric label="DTE" value={riskLeg.daysToExpiry} tone={riskLeg.daysToExpiry < 7 ? 'error.main' : undefined} /> : null}
                {item.isDerivative ? <InlineMetric label={item.deltaExposureEstimated ? 'ΔExp est.' : 'ΔExp'} value={formatMetricCurrency(item.deltaExposureEur)} tone="secondary.main" /> : null}
                {item.isDerivative ? <InlineMetric label="Ω" value={formatMetricNumber(item.effectiveLeverage)} /> : null}
                {item.isDerivative ? <InlineMetric label="BE" value={formatBreakEven(item)} /> : null}
              </Stack>
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

function formatMetricNumber(value) {
  return Number.isFinite(Number(value)) ? `${formatNumber2(value)}x` : '—'
}

function formatBreakEven(item) {
  if (!Number.isFinite(Number(item.breakEvenDistanceAbs)) || !Number.isFinite(Number(item.breakEvenDistancePct))) return '—'
  return formatPercent2(item.breakEvenDistancePct)
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
