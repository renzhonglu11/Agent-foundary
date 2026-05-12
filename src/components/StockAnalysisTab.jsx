import { Fragment, useMemo, useState } from 'react'
import {
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  Collapse,
  Divider,
  IconButton,
  InputAdornment,
  MenuItem,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material'
import KeyboardArrowDownRoundedIcon from '@mui/icons-material/KeyboardArrowDownRounded'
import KeyboardArrowRightRoundedIcon from '@mui/icons-material/KeyboardArrowRightRounded'
import SearchRoundedIcon from '@mui/icons-material/SearchRounded'
import TuneRoundedIcon from '@mui/icons-material/TuneRounded'
import BusinessCenterRoundedIcon from '@mui/icons-material/BusinessCenterRounded'
import { preciseCurrency } from '../utils/formatters.js'

const ratingMeta = {
  强烈买入: { color: '#13deb9', bg: '#e9fff9', border: '#9bf3df' },
  买入: { color: '#5d87ff', bg: '#eef3ff', border: '#c5d4ff' },
  持有: { color: '#49beff', bg: '#edf8ff', border: '#a9dcff' },
  观望: { color: '#ffae1f', bg: '#fff9df', border: '#ffe18a' },
  卖出: { color: '#fa896b', bg: '#fff1ee', border: '#ffc9bd' },
}

const apiMeta = {
  alpaca: { color: '#5d87ff', bg: '#eef3ff', border: '#c5d4ff' },
  trading212: { color: '#13deb9', bg: '#e9fff9', border: '#9bf3df' },
  pdf: { color: '#ffae1f', bg: '#fff9df', border: '#ffe18a' },
}

const stockRows = {
  tier1: [
    { id: 't1-nvda', stockName: 'NVIDIA', symbol: 'NVDA', price: 143.85, targetPrice: 172, rating: '强烈买入', apiStatus: 'alpaca', holdingStatus: '12.5% 仓位', holdingDays: 218 },
    { id: 't1-msft', stockName: 'Microsoft', symbol: 'MSFT', price: 486.2, targetPrice: 535, rating: '买入', apiStatus: 'trading212', holdingStatus: '8.2% 仓位', holdingDays: 346 },
    { id: 't1-asml', stockName: 'ASML Holding', symbol: 'ASML', price: 812.4, targetPrice: 930, rating: '买入', apiStatus: 'pdf', holdingStatus: '5.8% 仓位', holdingDays: 121 },
  ],
  tier2: [
    { id: 't2-amzn', stockName: 'Amazon', symbol: 'AMZN', price: 214.76, targetPrice: 245, rating: '买入', apiStatus: 'alpaca', holdingStatus: '空仓', holdingDays: 0 },
    { id: 't2-googl', stockName: 'Alphabet', symbol: 'GOOGL', price: 196.32, targetPrice: 218, rating: '持有', apiStatus: 'trading212', holdingStatus: '3.1% 仓位', holdingDays: 74 },
    { id: 't2-lly', stockName: 'Eli Lilly', symbol: 'LLY', price: 768.1, targetPrice: 820, rating: '观望', apiStatus: 'pdf', holdingStatus: '空仓', holdingDays: 0 },
  ],
  tier3: [
    { id: 't3-tsla', stockName: 'Tesla', symbol: 'TSLA', price: 187.9, targetPrice: 165, rating: '卖出', apiStatus: 'alpaca', holdingStatus: '做空 2.0%', holdingDays: 31 },
    { id: 't3-intc', stockName: 'Intel', symbol: 'INTC', price: 34.5, targetPrice: 39, rating: '观望', apiStatus: 'trading212', holdingStatus: '空仓', holdingDays: 0 },
    { id: 't3-nke', stockName: 'Nike', symbol: 'NKE', price: 73.15, targetPrice: 82, rating: '持有', apiStatus: 'pdf', holdingStatus: '1.4% 仓位', holdingDays: 59 },
  ],
}

const tiers = [
  { id: 'tier1', title: 'Tier 1 Watchlist', subtitle: '最高优先级：可直接进入加仓/减仓决策流' },
  { id: 'tier2', title: 'Tier 2 Watchlist', subtitle: '重点跟踪：等待估值、安全边际或催化剂确认' },
  { id: 'tier3', title: 'Tier 3 Watchlist', subtitle: '观察池：需要更多外部 LLM 研报或价格信号' },
]

function Pill({ label, meta }) {
  return (
    <Box
      component="span"
      sx={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 0.75,
        px: 1,
        py: 0.25,
        borderRadius: '6px',
        border: `1px solid ${meta.border}`,
        backgroundColor: meta.bg,
        color: '#2a3547',
        fontSize: 13,
        fontWeight: 700,
        lineHeight: 1.35,
        whiteSpace: 'nowrap',
      }}
    >
      <Box component="span" sx={{ width: 6, height: 6, borderRadius: '50%', backgroundColor: meta.color, flexShrink: 0 }} />
      {label}
    </Box>
  )
}

function StockNameCell({ row }) {
  return (
    <Box sx={{ minWidth: 0 }}>
      <Typography variant="body2" fontWeight={800} noWrap>{row.stockName}</Typography>
      <Typography variant="caption" color="text.secondary" noWrap>{row.symbol}</Typography>
    </Box>
  )
}

function DetailPanel({ row }) {
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
      <Stack spacing={0.5}>
        <Typography variant="body2" fontWeight={800}>{row.stockName} · {row.symbol}</Typography>
        <Typography color="text.secondary">test text</Typography>
      </Stack>
    </Box>
  )
}

function WatchlistTable({ tier, rows, search, ratingFilter }) {
  const [expandedRowId, setExpandedRowId] = useState(null)

  const filteredRows = useMemo(() => rows.filter((row) => {
    const matchesSearch = !search || `${row.stockName} ${row.symbol} ${row.rating} ${row.apiStatus} ${row.holdingStatus}`.toLowerCase().includes(search.toLowerCase())
    const matchesRating = ratingFilter === '全部评级' || row.rating === ratingFilter
    return matchesSearch && matchesRating
  }), [ratingFilter, rows, search])

  const toggleRow = (rowId) => {
    setExpandedRowId((current) => (current === rowId ? null : rowId))
  }

  return (
    <Card className="panel-card">
      <CardContent>
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={1} sx={{ justifyContent: 'space-between', mb: 2 }}>
          <Box>
            <Typography variant="h6">{tier.title}</Typography>
            <Typography variant="body2" color="text.secondary">{tier.subtitle}</Typography>
          </Box>
          <Chip color="primary" size="small" label={`${filteredRows.length} / ${rows.length} 只股票`} />
        </Stack>

        <TableContainer
          sx={{
            border: '1px solid #e5eaef',
            borderRadius: 2,
            overflowX: 'auto',
          }}
        >
          <Table size="small" sx={{ minWidth: 960 }} aria-label={`${tier.title} collapsible stock table`}>
            <TableHead>
              <TableRow sx={{ backgroundColor: '#f8fafc' }}>
                <TableCell sx={{ width: 56 }} />
                <TableCell sx={{ fontWeight: 800 }}>股票名称</TableCell>
                <TableCell align="right" sx={{ fontWeight: 800 }}>价格</TableCell>
                <TableCell align="right" sx={{ fontWeight: 800 }}>目标价格</TableCell>
                <TableCell sx={{ fontWeight: 800 }}>评级</TableCell>
                <TableCell sx={{ fontWeight: 800 }}>API状态</TableCell>
                <TableCell sx={{ fontWeight: 800 }}>持有状态</TableCell>
                <TableCell align="right" sx={{ fontWeight: 800 }}>持有天数</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {filteredRows.map((row) => {
                const open = expandedRowId === row.id
                return (
                  <Fragment key={row.id}>
                    <TableRow
                      hover
                      onClick={() => toggleRow(row.id)}
                      sx={{
                        cursor: 'pointer',
                        '& > *': { borderBottom: open ? 'none' : '1px solid #edf2f7' },
                      }}
                    >
                      <TableCell>
                        <IconButton
                          aria-label={open ? `收起 ${row.stockName}` : `展开 ${row.stockName}`}
                          size="small"
                          onClick={(event) => {
                            event.stopPropagation()
                            toggleRow(row.id)
                          }}
                        >
                          {open ? <KeyboardArrowDownRoundedIcon /> : <KeyboardArrowRightRoundedIcon />}
                        </IconButton>
                      </TableCell>
                      <TableCell><StockNameCell row={row} /></TableCell>
                      <TableCell align="right"><Typography variant="body2" fontWeight={700}>{preciseCurrency.format(row.price)}</Typography></TableCell>
                      <TableCell align="right"><Typography variant="body2" fontWeight={700}>{preciseCurrency.format(row.targetPrice)}</Typography></TableCell>
                      <TableCell><Pill label={row.rating} meta={ratingMeta[row.rating]} /></TableCell>
                      <TableCell><Pill label={row.apiStatus} meta={apiMeta[row.apiStatus]} /></TableCell>
                      <TableCell>
                        <Typography variant="body2" fontWeight={row.holdingStatus === '空仓' ? 500 : 800} color={row.holdingStatus === '空仓' ? 'text.secondary' : 'text.primary'} noWrap>
                          {row.holdingStatus}
                        </Typography>
                      </TableCell>
                      <TableCell align="right"><Typography variant="body2">{row.holdingDays} 天</Typography></TableCell>
                    </TableRow>
                    <TableRow>
                      <TableCell colSpan={8} sx={{ p: 0, borderBottom: open ? '1px solid #edf2f7' : 0 }}>
                        <Collapse in={open} timeout="auto" unmountOnExit>
                          <Box sx={{ px: 2, pb: 2, backgroundColor: '#ffffff' }}>
                            <DetailPanel row={row} />
                          </Box>
                        </Collapse>
                      </TableCell>
                    </TableRow>
                  </Fragment>
                )
              })}
              {!filteredRows.length ? (
                <TableRow>
                  <TableCell colSpan={8} sx={{ py: 4, textAlign: 'center' }}>
                    <Typography color="text.secondary">没有匹配的股票</Typography>
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </TableContainer>
      </CardContent>
    </Card>
  )
}

export default function StockAnalysisTab() {
  const [search, setSearch] = useState('')
  const [ratingFilter, setRatingFilter] = useState('全部评级')
  const totalRows = Object.values(stockRows).reduce((sum, rows) => sum + rows.length, 0)

  return (
    <Stack spacing={2.5}>
      <Card className="panel-card">
        <CardContent>
          <Stack direction={{ xs: 'column', lg: 'row' }} spacing={2} sx={{ justifyContent: 'space-between', alignItems: { xs: 'stretch', lg: 'center' } }}>
            <Box>
              <Typography variant="h5" fontWeight={800}>选股分析</Typography>
              <Typography color="text.secondary" mt={0.5}>
                接收外部 LLM 分析内容后，抽取长期趋势、目标价、加仓建议、估值水平等评级信号。
              </Typography>
            </Box>
            <Chip icon={<BusinessCenterRoundedIcon />} color="primary" label={`${totalRows} 个候选标的`} />
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
                onChange={(event) => setRatingFilter(event.target.value)}
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
              onChange={(event) => setSearch(event.target.value)}
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

      {tiers.map((tier) => (
        <WatchlistTable key={tier.id} tier={tier} rows={stockRows[tier.id]} search={search} ratingFilter={ratingFilter} />
      ))}
    </Stack>
  )
}
