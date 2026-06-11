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
                  <Typography variant="body2" fontWeight={800} noWrap>{item.stockName}</Typography>
                  <Typography variant="caption" color="text.secondary" noWrap>{item.symbol}</Typography>
                </Box>
              </Stack>

              {/* Prominent Risk Dashboard Section */}
              {riskLeg && (
                <Box sx={{ 
                  display: 'flex', gap: 1, p: 1, borderRadius: 1.5, 
                  backgroundColor: riskLeg.legRiskStatus === 'HARD_BLOCKED' ? '#fff4f4' : riskLeg.legRiskStatus === 'WATCH' ? '#fff8e6' : '#f0fdf4',
                  border: '1px solid',
                  borderColor: riskLeg.legRiskStatus === 'HARD_BLOCKED' ? '#ffe0e0' : riskLeg.legRiskStatus === 'WATCH' ? '#ffecd1' : '#dcfce7'
                }}>
                  <Tooltip title={`Data Confidence: ${riskLeg.exposureConfidence} | Quote Age: ${riskLeg.quoteAgeHours ? riskLeg.quoteAgeHours.toFixed(2) + 'h' : 'N/A'}`}>
                    <Chip size="small" color={riskStatusColors[riskLeg.legRiskStatus] || 'default'} label={riskLeg.legRiskStatus} sx={{ fontWeight: 800 }} />
                  </Tooltip>
                  {riskLeg.daysToExpiry !== null && <Chip size="small" color={riskLeg.daysToExpiry < 7 ? 'error' : 'default'} variant={riskLeg.daysToExpiry < 7 ? 'filled' : 'outlined'} label={`⏳ DTE ${riskLeg.daysToExpiry}`} />}
                  {riskLeg.barrierDistancePct !== null && <Chip size="small" color={riskLeg.barrierDistancePct < 0.05 ? 'error' : 'default'} variant={riskLeg.barrierDistancePct < 0.05 ? 'filled' : 'outlined'} label={`🚧 Barrier ${(riskLeg.barrierDistancePct * 100).toFixed(1)}%`} />}
                </Box>
              )}

              {/* Financial Metrics */}
              <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', minWidth: 200, justifyContent: { xs: 'flex-start', lg: 'flex-end' } }}>
                {item.isDerivative ? <Chip size="small" color="secondary" variant="outlined" label={`${item.deltaExposureEstimated ? 'Delta Exp est.' : 'Delta Exp'} ${formatMetricCurrency(item.deltaExposureEur)}`} /> : null}
                {item.isDerivative ? <Chip size="small" color="warning" variant="outlined" label={`Lev ${formatMetricNumber(item.effectiveLeverage)}`} /> : null}
                {item.isDerivative ? <Chip size="small" variant="outlined" label={`BE ${formatBreakEven(item)}`} /> : null}
              </Stack>
              
              {/* Identity & Data Quality (Muted) */}
              <Stack direction="row" spacing={0.5} useFlexGap sx={{ flexWrap: 'wrap', minWidth: 100, justifyContent: { xs: 'flex-start', lg: 'flex-end' }, opacity: 0.8 }}>
                <Chip size="small" variant="outlined" sx={{ height: 20, fontSize: '0.65rem' }} label={item.assetClass} />
                {item.liveStockQuoteEnabled ? <Chip size="small" color="success" variant="outlined" sx={{ height: 20, fontSize: '0.65rem' }} label="Alpaca" /> : null}
                {item.liveEnrichmentEnabled && !item.liveStockQuoteEnabled ? <Chip size="small" color="success" variant="outlined" sx={{ height: 20, fontSize: '0.65rem' }} label="实时" /> : null}
                {!item.liveEnrichmentEnabled ? <Chip size="small" variant="outlined" sx={{ height: 20, fontSize: '0.65rem' }} label="JSON fallback" /> : null}
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
  const label = item.breakEvenStatus === 'above' ? 'Above BE' : 'Below BE'
  return `${label} ${preciseCurrency.format(item.breakEvenDistanceAbs)} / ${formatPercent2(item.breakEvenDistancePct)}`
}
