import { Box, Chip, Stack, Typography } from '@mui/material'

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
        <Box>
          <Typography variant="caption" color="text.secondary">{row.tierNote}</Typography>
        </Box>
        <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
          <Chip size="small" label={`市值 ${preciseCurrency.format(row.marketValue)}`} />
          <Chip size="small" label={`价格 ${preciseCurrency.format(row.price)}`} />
          <Chip size="small" label={`数量 ${formatNumber2(row.quantity)}`} />
          <Chip size="small" label={`成本 ${preciseCurrency.format(row.costBasis)}`} />
          <Chip size="small" color={row.unrealizedPnl >= 0 ? 'success' : 'error'} label={`浮盈亏 ${preciseCurrency.format(row.unrealizedPnl)} (${formatPercent2(row.unrealizedPct)})`} />
          <Chip size="small" variant="outlined" label={`资产类型 ${row.assetClass}`} />
          <Chip
            size="small"
            color={row.liveEnrichmentEnabled ? 'success' : 'default'}
            variant="outlined"
            label={row.liveStockQuoteEnabled ? 'Alpaca 实时价格' : `${row.enrichmentTier?.toUpperCase()} ${row.liveEnrichmentEnabled ? '实时更新' : '非实时'}`}
          />
          {row.productType ? <Chip size="small" color="info" variant="outlined" label={`产品类型 ${row.productType}`} /> : null}
          {row.leverage != null ? <Chip size="small" color="warning" variant="outlined" label={`Hebel ${Number(row.leverage).toFixed(2)}x`} /> : null}
          {row.delta != null ? <Chip size="small" color="secondary" variant="outlined" label={`Delta ${Number(row.delta).toFixed(2)}`} /> : null}
          {row.quoteSource ? <Chip size="small" color="success" variant="outlined" label={`报价来源 ${row.quoteSource}`} /> : null}
          {row.alpacaSymbol ? <Chip size="small" variant="outlined" label={`Alpaca ${row.alpacaSymbol}`} /> : null}
          {row.metadataSource ? <Chip size="small" variant="outlined" label={`Metadata ${row.metadataSource}`} /> : null}
        </Stack>
        <Stack spacing={0.25}>
          {row.pdfName ? <Typography variant="caption" color="text.secondary">PDF 名称：{row.pdfName}</Typography> : null}
          {row.issuer ? <Typography variant="caption" color="text.secondary">Issuer：{row.issuer}</Typography> : null}
          {row.instrument ? <Typography variant="caption" color="text.secondary">Instrument：{row.instrument}</Typography> : null}
          {row.underlying ? <Typography variant="caption" color="text.secondary">Underlying：{row.underlying}</Typography> : null}
          {row.underlyingSpot != null ? <Typography variant="caption" color="text.secondary">Spot：{preciseCurrency.format(row.underlyingSpot)}</Typography> : null}
          {row.strikePrice != null ? <Typography variant="caption" color="text.secondary">Basispreis：{preciseCurrency.format(row.strikePrice)}</Typography> : null}
          {row.knockoutPrice != null ? <Typography variant="caption" color="text.secondary">Knock-Out：{preciseCurrency.format(row.knockoutPrice)}</Typography> : null}
          {row.resetBarrier != null ? <Typography variant="caption" color="text.secondary">Akt. Reset-Barriere：{preciseCurrency.format(row.resetBarrier)}</Typography> : null}
          {row.ratio != null ? <Typography variant="caption" color="text.secondary">Bezugsverhältnis：{formatNumber2(row.ratio)}</Typography> : null}
          {row.calculatedBreakEven != null ? <Typography variant="caption" color="text.secondary">Break-even：{preciseCurrency.format(row.calculatedBreakEven)}</Typography> : null}
          {row.expiry ? <Typography variant="caption" color="text.secondary">Fälligkeit：{row.expiry}</Typography> : null}
          {row.bidPrice != null || row.askPrice != null ? (
            <Typography variant="caption" color="text.secondary">
              Alpaca IEX：Bid {formatNumber2(row.bidPrice)} / Ask {formatNumber2(row.askPrice)}{row.priceAsOf ? ` · ${row.priceAsOf}` : ''}
            </Typography>
          ) : null}
          {row.omega != null || row.theta != null || row.iv != null ? (
            <Typography variant="caption" color="text.secondary">
              Greeks：{row.omega != null ? `Omega ${formatNumber2(row.omega)} ` : ''}{row.theta != null ? `Theta ${formatNumber2(row.theta)} ` : ''}{row.iv != null ? `IV ${formatNumber2(Number(row.iv) * 100)}%` : ''}
            </Typography>
          ) : null}
          {row.lastTradeDate ? <Typography variant="caption" color="text.secondary">最近交易日期：{row.lastTradeDate}</Typography> : null}
        </Stack>
      </Stack>
    </Box>
  )
}
