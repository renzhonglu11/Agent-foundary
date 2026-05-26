import { useState } from 'react'
import { Box, Chip, Collapse, IconButton, Stack, Typography } from '@mui/material'
import KeyboardArrowDownRoundedIcon from '@mui/icons-material/KeyboardArrowDownRounded'
import KeyboardArrowRightRoundedIcon from '@mui/icons-material/KeyboardArrowRightRounded'

import { preciseCurrency } from '../../utils/formatters.js'
import DetailPanel from './DetailPanel.jsx'
import { formatNumber2, formatPercent2 } from './stockAnalysisUi.js'

export default function InstrumentList({ title, rows, emptyText, defaultExpanded = false }) {
  const [expandedInstrumentId, setExpandedInstrumentId] = useState(defaultExpanded && rows[0] ? rows[0].id : null)
  return (
    <Box sx={{ border: '1px solid #e5eaef', borderRadius: 2, overflow: 'hidden', backgroundColor: '#fff' }}>
      <Box sx={{ px: 1.5, py: 1, backgroundColor: '#f8fafc', borderBottom: '1px solid #e5eaef' }}>
        <Typography variant="body2" fontWeight={800}>{title} · {rows.length}</Typography>
      </Box>
      {rows.length ? rows.map((item) => {
        const open = expandedInstrumentId === item.id
        return (
          <Box key={item.id} sx={{ borderBottom: '1px solid #edf2f7', '&:last-child': { borderBottom: 0 } }}>
            <Stack
              direction={{ xs: 'column', md: 'row' }}
              spacing={1}
              onClick={() => setExpandedInstrumentId(open ? null : item.id)}
              sx={{ px: 1.5, py: 1, cursor: 'pointer', alignItems: { xs: 'stretch', md: 'center' }, justifyContent: 'space-between' }}
            >
              <Stack direction="row" spacing={1} sx={{ alignItems: 'center', minWidth: 0 }}>
                <IconButton size="small" onClick={(event) => { event.stopPropagation(); setExpandedInstrumentId(open ? null : item.id) }}>
                  {open ? <KeyboardArrowDownRoundedIcon /> : <KeyboardArrowRightRoundedIcon />}
                </IconButton>
                <Box sx={{ minWidth: 0 }}>
                  <Typography variant="body2" fontWeight={800} noWrap>{item.stockName}</Typography>
                  <Typography variant="caption" color="text.secondary" noWrap>{item.symbol}</Typography>
                </Box>
              </Stack>
              <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', justifyContent: { xs: 'flex-start', md: 'flex-end' } }}>
                <Chip size="small" variant="outlined" label={item.assetClass} />
                {item.isDerivative ? <Chip size="small" color="secondary" variant="outlined" label={`${item.deltaExposureEstimated ? 'Delta Exp est.' : 'Delta Exp'} ${formatMetricCurrency(item.deltaExposureEur)}`} /> : null}
                {item.isDerivative ? <Chip size="small" color="warning" variant="outlined" label={`Lev ${formatMetricNumber(item.effectiveLeverage)}`} /> : null}
                {item.isDerivative ? <Chip size="small" variant="outlined" label={`BE ${formatBreakEven(item)}`} /> : null}
                {item.liveStockQuoteEnabled ? <Chip size="small" color="success" variant="outlined" label="Alpaca" /> : null}
                {item.liveEnrichmentEnabled && !item.liveStockQuoteEnabled ? <Chip size="small" color="success" variant="outlined" label="实时" /> : null}
                {!item.liveEnrichmentEnabled ? <Chip size="small" variant="outlined" label="JSON fallback" /> : null}
              </Stack>
            </Stack>
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
