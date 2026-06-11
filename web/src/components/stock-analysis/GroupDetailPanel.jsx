import { Box, Chip, Stack, Typography, Grid } from '@mui/material'
import CheckCircleOutlinedIcon from '@mui/icons-material/CheckCircleOutlined'
import BlockIcon from '@mui/icons-material/Block'
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined'

import { preciseCurrency } from '../../utils/formatters.js'
import InstrumentList from './InstrumentList.jsx'

export default function GroupDetailPanel({ group, riskGroup }) {
  return (
    <Box sx={{ px: 2, py: 2, borderRadius: 2, border: '1px solid #e5eaef', backgroundColor: '#fbfdff' }}>
      <Stack spacing={1.5}>
        <Box>
          <Typography variant="h6" fontWeight={800}>{group.groupName}</Typography>
        </Box>
        
        {riskGroup && (
          <Box sx={{ p: 2, backgroundColor: '#ffffff', border: '1px solid #e5eaef', borderRadius: 2 }}>
            <Typography variant="subtitle2" sx={{ mb: 1.5, fontWeight: 700 }}>Risk Assessment</Typography>
            <Grid container spacing={3}>
              <Grid xs={12} md={4}>
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>Allowed Actions</Typography>
                <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
                  {riskGroup.action?.allowedActions?.length ? riskGroup.action.allowedActions.map(action => (
                    <Chip key={action} size="small" icon={<CheckCircleOutlinedIcon />} color="success" variant="outlined" label={action.replace(/_/g, ' ')} />
                  )) : <Typography variant="body2" color="text.secondary">None</Typography>}
                </Stack>
              </Grid>
              <Grid xs={12} md={4}>
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>Blocked Actions</Typography>
                <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
                  {riskGroup.action?.blockedActions?.length ? riskGroup.action.blockedActions.map(action => (
                    <Chip key={action} size="small" icon={<BlockIcon />} color="error" variant="outlined" label={action.replace(/_/g, ' ')} />
                  )) : <Typography variant="body2" color="text.secondary">None</Typography>}
                </Stack>
              </Grid>
              <Grid xs={12} md={4}>
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>Data Quality Flag</Typography>
                <Stack direction="row" spacing={1} alignItems="center">
                  <InfoOutlinedIcon fontSize="small" color="disabled" />
                  <Typography variant="body2">
                    {riskGroup.legs?.some(l => l.dataCompletenessRiskScore > 0) ? 'Missing or stale quotes detected' : 'Live data available'}
                  </Typography>
                </Stack>
              </Grid>
            </Grid>
          </Box>
        )}
        <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
          <Chip size="small" label={`总市值 ${preciseCurrency.format(group.marketValue)}`} />
          <Chip size="small" label={`股票/ETF ${group.stockCount}`} />
          <Chip size="small" label={`金融衍生品 ${group.derivativeCount}`} />
          <Chip size="small" color={group.liveStockQuoteCount ? 'success' : 'default'} variant="outlined" label={`Alpaca ${group.liveStockQuoteCount}/${group.stockCount}`} />
          <Chip size="small" color={group.liveDerivativeCount ? 'success' : 'default'} variant="outlined" label={`衍生品实时 ${group.liveDerivativeCount}/${group.derivativeCount}`} />
          {group.maxLeverage ? <Chip size="small" color="warning" variant="outlined" label={`Max Hebel ${Number(group.maxLeverage).toFixed(2)}x`} /> : null}
          {group.deltaExposure ? <Chip size="small" color="secondary" variant="outlined" label={`${group.deltaExposureEstimated ? 'Delta exposure est.' : 'Delta exposure'} ${preciseCurrency.format(group.deltaExposure)}`} /> : null}
        </Stack>
        <Stack spacing={1.25}>
          <InstrumentList title="股票 / ETF / Bond / JSON fallback" rows={group.stocks} emptyText="这个 underlying 下没有普通持仓。" />
          <InstrumentList title="金融衍生品" rows={group.derivatives} emptyText="这个 underlying 下没有金融衍生品。" defaultExpanded riskGroup={riskGroup} />
        </Stack>
      </Stack>
    </Box>
  )
}
