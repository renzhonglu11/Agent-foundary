import { Fragment, useEffect, useMemo, useState } from 'react'
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
import { buildWatchlistGroups } from '../utils/watchlistGrouping.js'

const ratingMeta = {
  强烈买入: { color: '#13deb9', bg: '#e9fff9', border: '#9bf3df' },
  买入: { color: '#5d87ff', bg: '#eef3ff', border: '#c5d4ff' },
  持有: { color: '#49beff', bg: '#edf8ff', border: '#a9dcff' },
  观望: { color: '#ffae1f', bg: '#fff9df', border: '#ffe18a' },
  卖出: { color: '#fa896b', bg: '#fff1ee', border: '#ffc9bd' },
}

const apiMeta = {
  structured_enrichment: { color: '#13deb9', bg: '#e9fff9', border: '#9bf3df' },
  portfolio: { color: '#5d87ff', bg: '#eef3ff', border: '#c5d4ff' },
  backend: { color: '#5d87ff', bg: '#eef3ff', border: '#c5d4ff' },
  alpaca: { color: '#5d87ff', bg: '#eef3ff', border: '#c5d4ff' },
  trading212: { color: '#13deb9', bg: '#e9fff9', border: '#9bf3df' },
  pdf: { color: '#ffae1f', bg: '#fff9df', border: '#ffe18a' },
  missing: { color: '#7c8fac', bg: '#f6f9fc', border: '#d8dee8' },
}

const tierBuckets = ['tier1', 'tier2', 'tier3']
const twoDecimalNumber = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

function formatNumber2(value) {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? twoDecimalNumber.format(numeric) : '—'
}

function formatPercent2(value) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return '—'
  return `${numeric >= 0 ? '+' : ''}${twoDecimalNumber.format(numeric)}%`
}

function sourceLabel(source) {
  const labels = {
    structured_enrichment: '结构化产品 enrichment',
    portfolio: 'Portfolio',
    backend: 'Backend',
    alpaca: 'Alpaca',
    trading212: 'Trading 212',
    pdf: 'PDF fallback',
    missing: '缺失',
  }
  return labels[source] ?? source
}

const tiers = [
  { id: 'tier1', title: 'Tier 1 Watchlist', subtitle: '核心标的组；只对本层金融衍生品执行 Onvista/Börse Frankfurt 实时 enrichment' },
  { id: 'tier2', title: 'Tier 2 Watchlist', subtitle: '其余金融衍生品按 underlying 聚合；默认使用 Rust summary / 已缓存 JSON 数据' },
  { id: 'tier3', title: 'Tier 3 Watchlist', subtitle: '股票、ETF、Bond 等普通持仓；先使用 Rust portfolio JSON fallback，不触发衍生品实时抓取' },
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
      <Typography variant="body2" fontWeight={800} noWrap>{row.groupName || row.stockName}</Typography>
      <Typography variant="caption" color="text.secondary" noWrap>
        {row.derivativeCount != null ? `${row.stockCount} 股票/ETF · ${row.derivativeCount} 衍生品` : row.symbol}
      </Typography>
    </Box>
  )
}

function InstrumentList({ title, rows, emptyText, defaultExpanded = false }) {
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
                <Chip size="small" label={preciseCurrency.format(item.marketValue)} />
                <Chip size="small" variant="outlined" label={item.assetClass} />
                {item.productType ? <Chip size="small" color="info" variant="outlined" label={item.productType} /> : null}
                {item.liveEnrichmentEnabled ? <Chip size="small" color="success" variant="outlined" label="实时" /> : <Chip size="small" variant="outlined" label="JSON fallback" />}
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

function GroupDetailPanel({ group }) {
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
          <Chip size="small" color={group.liveDerivativeCount ? 'success' : 'default'} variant="outlined" label={`实时 ${group.liveDerivativeCount}/${group.derivativeCount}`} />
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
      <Stack spacing={1.5}>
        <Box>
          <Typography variant="caption" color="text.secondary">{row.tierNote}</Typography>
        </Box>
        <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
          <Chip size="small" label={`市值 ${preciseCurrency.format(row.marketValue)}`} />
          <Chip size="small" label={`数量 ${formatNumber2(row.quantity)}`} />
          <Chip size="small" label={`成本 ${preciseCurrency.format(row.costBasis)}`} />
          <Chip size="small" color={row.unrealizedPnl >= 0 ? 'success' : 'error'} label={`浮盈亏 ${preciseCurrency.format(row.unrealizedPnl)} (${formatPercent2(row.unrealizedPct)})`} />
          <Chip size="small" variant="outlined" label={`资产类型 ${row.assetClass}`} />
          <Chip size="small" color={row.liveEnrichmentEnabled ? 'success' : 'default'} variant="outlined" label={`${row.enrichmentTier?.toUpperCase()} ${row.liveEnrichmentEnabled ? '实时更新' : '非实时'}`} />
          {row.productType ? <Chip size="small" color="info" variant="outlined" label={`产品类型 ${row.productType}`} /> : null}
          {row.leverage != null ? <Chip size="small" color="warning" variant="outlined" label={`Hebel ${Number(row.leverage).toFixed(2)}x`} /> : null}
          {row.delta != null ? <Chip size="small" color="secondary" variant="outlined" label={`Delta ${Number(row.delta).toFixed(2)}`} /> : null}
          {row.quoteSource ? <Chip size="small" color="success" variant="outlined" label={`报价来源 ${row.quoteSource}`} /> : null}
          {row.metadataSource ? <Chip size="small" variant="outlined" label={`Metadata ${row.metadataSource}`} /> : null}
        </Stack>
        <Stack spacing={0.25}>
          {row.pdfName ? <Typography variant="caption" color="text.secondary">PDF 名称：{row.pdfName}</Typography> : null}
          {row.issuer ? <Typography variant="caption" color="text.secondary">Issuer：{row.issuer}</Typography> : null}
          {row.instrument ? <Typography variant="caption" color="text.secondary">Instrument：{row.instrument}</Typography> : null}
          {row.underlying ? <Typography variant="caption" color="text.secondary">Underlying：{row.underlying}</Typography> : null}
          {row.strikePrice != null ? <Typography variant="caption" color="text.secondary">Basispreis：{preciseCurrency.format(row.strikePrice)}</Typography> : null}
          {row.knockoutPrice != null ? <Typography variant="caption" color="text.secondary">Knock-Out：{preciseCurrency.format(row.knockoutPrice)}</Typography> : null}
          {row.ratio != null ? <Typography variant="caption" color="text.secondary">Bezugsverhältnis：{formatNumber2(row.ratio)}</Typography> : null}
          {row.expiry ? <Typography variant="caption" color="text.secondary">Fälligkeit：{row.expiry}</Typography> : null}
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

function WatchlistTable({ tier, rows, search, ratingFilter }) {
  const [expandedRowId, setExpandedRowId] = useState(null)

  const filteredRows = useMemo(() => rows.filter((row) => {
    const searchText = `${row.groupName} ${row.symbol} ${row.rating} ${row.apiStatus} ${row.holdingStatus} ${row.instruments.map((item) => `${item.stockName} ${item.symbol}`).join(' ')}`
    const matchesSearch = !search || searchText.toLowerCase().includes(search.toLowerCase())
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
          <Chip color="primary" size="small" label={`${filteredRows.length} / ${rows.length} 个标的组`} />
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
                <TableCell sx={{ fontWeight: 800 }}>标的总览</TableCell>
                <TableCell align="right" sx={{ fontWeight: 800 }}>总市值</TableCell>
                <TableCell align="right" sx={{ fontWeight: 800 }}>Delta Exposure</TableCell>
                <TableCell sx={{ fontWeight: 800 }}>评级</TableCell>
                <TableCell sx={{ fontWeight: 800 }}>实时状态</TableCell>
                <TableCell sx={{ fontWeight: 800 }}>组成</TableCell>
                <TableCell align="right" sx={{ fontWeight: 800 }}>最近交易</TableCell>
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
                          aria-label={open ? `收起 ${row.groupName}` : `展开 ${row.groupName}`}
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
                      <TableCell align="right"><Typography variant="body2" fontWeight={700}>{preciseCurrency.format(row.marketValue)}</Typography></TableCell>
                      <TableCell align="right"><Typography variant="body2" fontWeight={700}>{row.deltaExposure ? preciseCurrency.format(row.deltaExposure) : '—'}</Typography></TableCell>
                      <TableCell><Pill label={row.rating} meta={ratingMeta[row.rating]} /></TableCell>
                      <TableCell>
                        <Chip size="small" color={row.liveDerivativeCount ? 'success' : 'default'} variant="outlined" label={`实时 ${row.liveDerivativeCount}/${row.derivativeCount}`} />
                      </TableCell>
                      <TableCell>
                        <Stack direction="row" spacing={0.75} useFlexGap sx={{ flexWrap: 'wrap' }}>
                          <Chip size="small" variant="outlined" label={`股票/ETF ${row.stockCount}`} />
                          <Chip size="small" color={row.derivativeCount ? 'info' : 'default'} variant="outlined" label={`衍生品 ${row.derivativeCount}`} />
                        </Stack>
                      </TableCell>
                      <TableCell align="right"><Typography variant="body2">{row.holdingDays === null ? '—' : `${row.holdingDays} 天前`}</Typography></TableCell>
                    </TableRow>
                    <TableRow>
                      <TableCell colSpan={8} sx={{ p: 0, borderBottom: open ? '1px solid #edf2f7' : 0 }}>
                        <Collapse in={open} timeout="auto" unmountOnExit>
                          <Box sx={{ px: 2, pb: 2, backgroundColor: '#ffffff' }}>
                            <GroupDetailPanel group={row} />
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

export default function StockAnalysisTab({ data }) {
  const [search, setSearch] = useState('')
  const [ratingFilter, setRatingFilter] = useState('全部评级')
  const [structuredProducts, setStructuredProducts] = useState([])

  useEffect(() => {
    let cancelled = false
    fetch('/data/structured-products-enrichment.json')
      .then((response) => (response.ok ? response.json() : null))
      .then((payload) => {
        if (!cancelled) setStructuredProducts(Array.isArray(payload?.items) ? payload.items : [])
      })
      .catch(() => {
        if (!cancelled) setStructuredProducts([])
      })

    return () => {
      cancelled = true
    }
  }, [])

  const stockRows = useMemo(() => buildWatchlistGroups(data, structuredProducts), [data, structuredProducts])
  const totalRows = Object.values(stockRows).reduce((sum, rows) => sum + rows.length, 0)
  const totalInstruments = Object.values(stockRows).flat().reduce((sum, group) => sum + group.instruments.length, 0)
  const enrichedRows = structuredProducts.length

  return (
    <Stack spacing={2.5}>
      <Card className="panel-card">
        <CardContent>
          <Stack direction={{ xs: 'column', lg: 'row' }} spacing={2} sx={{ justifyContent: 'space-between', alignItems: { xs: 'stretch', lg: 'center' } }}>
            <Box>
              <Typography variant="h5" fontWeight={800}>选股分析</Typography>
              <Typography color="text.secondary" mt={0.5}>
                当前 watchlist 按 underlying / 标的聚合展示；只对 Tier1 金融衍生品叠加 Onvista/Börse Frankfurt 实时数据，股票/ETF/Bond 先使用 Rust JSON fallback。
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
