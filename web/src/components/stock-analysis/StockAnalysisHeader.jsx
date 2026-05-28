import {
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  Divider,
  InputAdornment,
  MenuItem,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material'
import BusinessCenterRoundedIcon from '@mui/icons-material/BusinessCenterRounded'
import SearchRoundedIcon from '@mui/icons-material/SearchRounded'
import TuneRoundedIcon from '@mui/icons-material/TuneRounded'

export default function StockAnalysisHeader({
  search,
  onSearchChange,
  ratingFilter,
  onRatingFilterChange,
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
                real time
              </Button>
            </Stack>
            <Typography color="text.secondary" mt={0.5}>
              当前 watchlist 按 underlying / 标的聚合展示；real time 只刷新 Tier1 金融衍生品的 Onvista/Börse Frankfurt 数据，Tier1 分组里的股票由 Alpaca 按周期自动更新。
            </Typography>
          </Box>
          <Chip icon={<BusinessCenterRoundedIcon />} color="primary" label={`${totalRows} 个标的组 · ${totalInstruments} 个持仓行 · ${enrichedRows} 个结构化产品`} />
        </Stack>

        <Divider sx={{ my: 2.5 }} />

        <Stack direction={{ xs: 'column', xl: 'row' }} spacing={2} sx={{ alignItems: { xs: 'stretch', xl: 'center' }, justifyContent: 'space-between' }}>
          <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
            <Tooltip title="预留给后续按股票名称筛选" arrow>
              <Button variant="outlined" startIcon={<TuneRoundedIcon />} sx={{ borderStyle: 'dashed' }}>股票名称</Button>
            </Tooltip>
            <TextField
              select
              size="small"
              value={ratingFilter}
              onChange={(event) => onRatingFilterChange(event.target.value)}
              sx={{ minWidth: 160 }}
            >
              {['全部评级', '强烈买入', '买入', '持有', '观望', '卖出'].map((rating) => (
                <MenuItem key={rating} value={rating}>{rating}</MenuItem>
              ))}
            </TextField>
            <Button variant="outlined" sx={{ borderStyle: 'dashed' }}>价格</Button>
            <Button variant="outlined" sx={{ borderStyle: 'dashed' }}>目标价格</Button>
            <Button variant="outlined" sx={{ borderStyle: 'dashed' }}>持有状态</Button>
          </Stack>
          <TextField
            size="small"
            placeholder="Search stock, symbol, rating..."
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
