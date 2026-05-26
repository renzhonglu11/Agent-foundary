import { Box, Chip, Stack, Typography } from '@mui/material'

import { preciseCurrency } from '../../utils/formatters.js'
import InstrumentList from './InstrumentList.jsx'

export default function GroupDetailPanel({ group }) {
  return (
    <Box sx={{ px: 2, py: 2, borderRadius: 2, border: '1px solid #e5eaef', backgroundColor: '#fbfdff' }}>
      <Stack spacing={1.5}>
        <Box>
          <Typography variant="body2" fontWeight={800}>{group.groupName}</Typography>
          <Typography variant="caption" color="text.secondary">
            第一级为 underlying 总览；第二级分股票/ETF 与金融衍生品；第三级展开单个 instrument 的原始详情。
          </Typography>
        </Box>
        <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
          <Chip size="small" label={`总市值 ${preciseCurrency.format(group.marketValue)}`} />
          <Chip size="small" label={`股票/ETF ${group.stockCount}`} />
          <Chip size="small" label={`金融衍生品 ${group.derivativeCount}`} />
          <Chip size="small" color={group.liveStockQuoteCount ? 'success' : 'default'} variant="outlined" label={`Alpaca ${group.liveStockQuoteCount}/${group.stockCount}`} />
          <Chip size="small" color={group.liveDerivativeCount ? 'success' : 'default'} variant="outlined" label={`衍生品实时 ${group.liveDerivativeCount}/${group.derivativeCount}`} />
          {group.maxLeverage ? <Chip size="small" color="warning" variant="outlined" label={`Max Hebel ${Number(group.maxLeverage).toFixed(2)}x`} /> : null}
          {group.deltaExposure ? <Chip size="small" color="secondary" variant="outlined" label={`Delta exposure ${preciseCurrency.format(group.deltaExposure)}`} /> : null}
        </Stack>
        <Stack spacing={1.25}>
          <InstrumentList title="股票 / ETF / Bond / JSON fallback" rows={group.stocks} emptyText="这个 underlying 下没有普通持仓。" />
          <InstrumentList title="金融衍生品" rows={group.derivatives} emptyText="这个 underlying 下没有金融衍生品。" defaultExpanded />
        </Stack>
      </Stack>
    </Box>
  )
}
