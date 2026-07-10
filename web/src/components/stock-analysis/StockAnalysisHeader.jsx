import {
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  Divider,
  InputAdornment,
  Stack,
  TextField,
  Typography,
} from '@mui/material'
import BusinessCenterRoundedIcon from '@mui/icons-material/BusinessCenterRounded'
import SearchRoundedIcon from '@mui/icons-material/SearchRounded'
import { attentionFilters } from './stockAnalysisUi.js'

export default function StockAnalysisHeader({
  search,
  onSearchChange,
  attentionFilter,
  onAttentionFilterChange,
  attentionCounts,
  liveRefreshing,
  onRealtimeRefresh,
  totalRows,
  totalInstruments,
  enrichedRows,
}) {
  return (
    <Card className="panel-card">
      <CardContent>
        <Stack direction={{ xs: 'column', lg: 'row' }} spacing={2} sx={{ justifyContent: 'space-between', alignItems: { xs: 'stretch', lg: 'center' } }}>
          <Box>
            <Stack direction="row" spacing={1.25} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
              <Typography variant="h5" fontWeight={800}>选股分析</Typography>
              <Button
                size="small"
                variant="outlined"
                loading={liveRefreshing}
                onClick={onRealtimeRefresh}
                sx={{ minWidth: 96, textTransform: 'none' }}
              >
                刷新实时数据
              </Button>
            </Stack>
            <Typography variant="body2" color="text.secondary" mt={0.5}>
              优先查看需要操作的标的；实时刷新仅更新 Tier 1 衍生品行情。
            </Typography>
          </Box>
          <Chip icon={<BusinessCenterRoundedIcon />} color="primary" label={`${totalRows} 个标的组 · ${totalInstruments} 个持仓行 · ${enrichedRows} 个结构化产品`} />
        </Stack>

        <Divider sx={{ my: 2.5 }} />

        <Stack direction={{ xs: 'column', xl: 'row' }} spacing={2} sx={{ alignItems: { xs: 'stretch', xl: 'center' }, justifyContent: 'space-between' }}>
          <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
            {attentionFilters.map((filter) => (
              <Button
                key={filter.id}
                size="small"
                variant={attentionFilter === filter.id ? 'contained' : 'outlined'}
                color={filter.id === 'action' && attentionCounts.action > 0 ? 'error' : filter.id === 'expiry' && attentionCounts.expiry > 0 ? 'warning' : 'primary'}
                onClick={() => onAttentionFilterChange(filter.id)}
                sx={{ textTransform: 'none' }}
              >
                {filter.label} {attentionCounts[filter.id] ?? 0}
              </Button>
            ))}
          </Stack>
          <TextField
            size="small"
            placeholder="搜索标的、代码或产品…"
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
            sx={{ minWidth: { xs: '100%', md: 360 } }}
            slotProps={{
              input: {
                startAdornment: (
                  <InputAdornment position="start">
                    <SearchRoundedIcon color="action" />
                  </InputAdornment>
                ),
              },
            }}
          />
        </Stack>
      </CardContent>
    </Card>
  )
}
