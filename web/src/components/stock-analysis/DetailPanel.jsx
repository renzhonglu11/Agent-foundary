import { Accordion, AccordionDetails, AccordionSummary, Box, Stack, Typography } from '@mui/material'
import ExpandMoreRoundedIcon from '@mui/icons-material/ExpandMoreRounded'

import { preciseCurrency } from '../../utils/formatters.js'
import { formatNumber2, formatPercent2 } from './stockAnalysisUi.js'

export default function DetailPanel({ row }) {
  return (
    <Box
      sx={{
        px: 2,
        py: 2,
        borderRadius: 2,
        border: '1px solid #e5eaef',
        backgroundColor: '#fbfdff',
      }}
    >
      <Stack spacing={1.5}>
        <MetricSection
          title="关键指标"
          items={[
            ['市值', currencyOrDash(row.marketValue)],
            ['盈亏', currencyOrDash(row.unrealizedPnl), row.unrealizedPnl >= 0 ? 'success.main' : 'error.main'],
            ['盈亏率', formatPercent2(row.unrealizedPct), row.unrealizedPnl >= 0 ? 'success.main' : 'error.main'],
            ...(row.isDerivative ? [
              [row.deltaExposureEstimated ? '估算 Delta 敞口' : 'Delta 敞口', currencyOrDash(row.deltaExposureEur)],
              ['剩余期限', expiryDaysOrDash(row.expiry)],
              ['盈亏平衡距离', formatPercent2(row.breakEvenDistancePct)],
            ] : []),
          ]}
        />

        <DetailAccordion
          title="仓位与交易"
          items={[
            ['价格', currencyOrDash(row.price)],
            ['数量', formatNumber2(row.quantity)],
            ['成本', currencyOrDash(row.costBasis)],
            ['最近交易', row.lastTradeDate || '—'],
          ]}
        />

        {row.isDerivative ? (
          <>
            <DetailAccordion
              title="高级风险指标"
              items={[
                ['Delta', numberOrDash(row.delta)],
                ['Omega', numberOrDash(row.omega)],
                ['IV', percentRatioOrDash(row.iv)],
                ['Theta', numberOrDash(row.theta)],
                ['有效杠杆', numberOrDash(row.effectiveLeverage)],
              ]}
            />
            <DetailAccordion
              title="合约条款"
              items={[
                ['行权价', currencyOrDash(row.strikePrice)],
                ['换算比例', numberOrDash(row.ratio)],
                ['盈亏平衡价', currencyOrDash(row.calculatedBreakEven)],
                ['到期日', row.expiry || '—'],
                ['敲出价', currencyOrDash(row.knockoutPrice)],
                ['重置障碍价', currencyOrDash(row.resetBarrier)],
              ]}
            />
          </>
        ) : null}

        <Accordion disableGutters elevation={0} sx={{ border: '1px solid #e5eaef', borderRadius: 1.5, '&:before': { display: 'none' } }}>
          <AccordionSummary expandIcon={<ExpandMoreRoundedIcon />} sx={{ minHeight: 36, px: 1.5, '& .MuiAccordionSummary-content': { my: 0.75 } }}>
            <Typography variant="body2" fontWeight={800}>数据来源与诊断</Typography>
          </AccordionSummary>
          <AccordionDetails sx={{ px: 1.5, pt: 0, pb: 1.5 }}>
            <MetricGrid
              items={[
                ['实时状态', realtimeStatus(row)],
                ['Metadata source', row.metadataSource || '—'],
                ['Greeks source', row.greeksSource || '—'],
                ['Quote source', row.quoteSource || '—'],
                ['Quote time', row.priceAsOf || '—'],
                ['Product type', row.productType || '—'],
                ['Tier', row.enrichmentTier || '—'],
                ['ISIN', row.symbol || '—'],
                ['PDF name', row.pdfName || '—'],
                ['Instrument raw', row.instrument || '—'],
                ['Underlying', row.underlying || '—'],
              ]}
              dense
            />
          </AccordionDetails>
        </Accordion>
      </Stack>
    </Box>
  )
}

function DetailAccordion({ title, items }) {
  return (
    <Accordion disableGutters elevation={0} sx={{ border: '1px solid #e5eaef', borderRadius: 1.5, '&:before': { display: 'none' } }}>
      <AccordionSummary expandIcon={<ExpandMoreRoundedIcon />} sx={{ minHeight: 36, px: 1.5, '& .MuiAccordionSummary-content': { my: 0.75 } }}>
        <Typography variant="body2" fontWeight={800}>{title}</Typography>
      </AccordionSummary>
      <AccordionDetails sx={{ px: 1.5, pt: 0, pb: 1.5 }}>
        <MetricGrid items={items} dense />
      </AccordionDetails>
    </Accordion>
  )
}

function MetricSection({ title, items }) {
  return (
    <Box>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.75, fontWeight: 800 }}>{title}</Typography>
      <MetricGrid items={items} />
    </Box>
  )
}

function MetricGrid({ items, dense = false }) {
  return (
    <Box
      sx={{
        display: 'grid',
        gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, minmax(0, 1fr))', lg: 'repeat(3, minmax(0, 1fr))' },
        gap: dense ? 0.75 : 1,
      }}
    >
      {items.map(([label, value, tone]) => (
        <Box key={label} sx={{ minWidth: 0 }}>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', lineHeight: 1.2 }}>{label}</Typography>
          <Typography variant="body2" sx={{ color: tone || 'text.primary', fontWeight: 800, wordBreak: 'break-word' }}>{value}</Typography>
        </Box>
      ))}
    </Box>
  )
}

function currencyOrDash(value) {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? preciseCurrency.format(numeric) : '—'
}

function numberOrDash(value) {
  return Number.isFinite(Number(value)) ? formatNumber2(value) : '—'
}

function percentRatioOrDash(value) {
  return Number.isFinite(Number(value)) ? `${formatNumber2(Number(value) * 100)}%` : '—'
}

function expiryDaysOrDash(expiry) {
  if (!expiry) return '—'
  const timestamp = new Date(expiry).getTime()
  if (!Number.isFinite(timestamp)) return '—'
  const days = Math.ceil((timestamp - Date.now()) / 86400000)
  return days >= 0 ? `${days} 天` : '已到期'
}

function realtimeStatus(row) {
  if (row.liveStockQuoteEnabled) return 'Alpaca realtime'
  if (row.liveEnrichmentEnabled) return 'structured-products realtime'
  if (row.metadataSource || row.greeksSource) return 'cache/provider fallback'
  return 'portfolio fallback'
}
