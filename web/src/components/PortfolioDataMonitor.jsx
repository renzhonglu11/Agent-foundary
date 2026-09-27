import { useQuery } from '@tanstack/react-query'
import { Alert, Box, Chip, Stack, Typography, Table, TableHead, TableBody, TableRow, TableCell } from '@mui/material'
import { compactCurrency } from '../utils/formatters.js'

const qualityLabels = {
  fresh: '交易时段内有效', closed_last_session: '休市 · 最近交易时段', stale: '行情过期',
  unknown_time: '市场时间未知', unknown_calendar: '交易日历未知', future_time: '行情时间异常',
  missing: '缺少行情', unmapped: '尚未识别标的', invalid_quote: '报价无效',
}
const issueLabels = {
  valuation_market_time_unknown: '持仓估值市场时间未知', valuation_missing_or_invalid: '估值缺失或无效',
  product_underlying_time_gap_over_24h: '产品抓取与标的时间相差超过 24 小时',
  fx_reference_fallback: '汇率使用备用值', greeks_market_time_unknown: 'Greeks 市场时间未知',
  product_capture_stale: '交易时段内产品抓取已过期', product_capture_future: '产品抓取时间异常',
  product_currency_unsupported: '产品币种未知或不支持，使用汇总估值',
}
const time = value => value ? new Date(value).toLocaleString() : '未知'

export default function PortfolioDataMonitor() {
  const query = useQuery({
    queryKey: ['portfolioMonitor'],
    queryFn: async () => {
      const response = await fetch('/api/portfolio-monitor/status', { cache: 'no-store' })
      if (!response.ok) throw new Error(`监控状态读取失败 (${response.status})`)
      return response.json()
    },
    refetchInterval: 30_000,
  })
  if (query.error) return <Alert severity="warning" sx={{ mb: 1.5 }}>{query.error.message}；当前无法确认后台数据状态。</Alert>
  const data = query.data
  const snapshot = data?.snapshot
  if (!snapshot) return <Alert severity="info" sx={{ mb: 1.5 }}>{data?.enabled === false ? '后台数据监控已关闭。' : '后台数据监控正在准备首份快照…'}</Alert>
  const expired = Date.now() - Date.parse(snapshot.evaluatedAt) > 180_000
  const rows = snapshot.positions || []
  const issues = rows.filter(row => row.issues?.length)
  const error = data.runtime?.lastError
  return <Box sx={{ mb: 1.5 }}>
    <Alert severity={expired || error || !data.enabled || issues.length ? 'warning' : 'info'}>
      <Typography variant="body2" fontWeight={700}>后台数据监控 · {data.enabled ? (data.runtime?.running ? '正在检查' : '已启用') : '已关闭'}</Typography>
      <Typography variant="body2">
        全部 {snapshot.positionCount} 个持仓；持仓市值 {compactCurrency(snapshot.holdingsMarketValue)}。
        现金与负债尚未核实，比例分母不包含现金。
      </Typography>
      <Typography variant="body2">
        有效标的行情覆盖 {Number(snapshot.usableUnderlyingCoveragePct).toFixed(1)}%（按持仓绝对市值）；
        未覆盖 {compactCurrency(snapshot.uncoveredUnderlyingValue)}。这不代表衍生品模型覆盖率。
      </Typography>
      <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', my: 0.75 }}>
        <Chip size="small" variant="outlined" label={`美股${snapshot.usSession?.state === 'open' ? '交易中' : snapshot.usSession?.state === 'closed' ? '休市' : '日历未知'}`} />
        <Chip size="small" variant="outlined" label={`标的刷新间隔 ${Math.round(data.intervalSeconds / 60)} 分钟`} />
        <Chip size="small" variant="outlined" label={`${issues.length} 个持仓存在数据限制`} />
      </Stack>
      <Typography variant="caption" component="div">检查时间：{time(snapshot.evaluatedAt)}；产品最近完成抓取：{time(data.structuredProducts?.lastFinishedAt)}。</Typography>
      {(expired || error || !data.enabled) && <Typography variant="body2">{error || (!data.enabled ? '监控已关闭' : '后台检查超过 3 分钟未更新')}；展示的是上一次快照，不能据此确认当前风险。</Typography>}
      {snapshot.provider?.failed && <Typography variant="body2">标的刷新存在失败或缺失，正在使用原时间戳的缓存并等待重试。</Typography>}
      {data.structuredProducts?.lastError && <Typography variant="body2">产品抓取失败：{data.structuredProducts.lastError}</Typography>}
      {data.structuredProducts?.liveEnabled === false && <Typography variant="body2">结构化产品实时抓取已关闭。</Typography>}
    </Alert>
    <Box component="details" sx={{ mt: 1 }}>
      <Box component="summary" sx={{ cursor: 'pointer', typography: 'body2' }}>查看全部持仓的数据来源与时间</Box>
      <Box sx={{ overflow: 'auto', maxHeight: 360 }}>
        <Table size="small" stickyHeader>
          <TableHead><TableRow>{['产品 / 市值', '估值来源 / 时间', '标的 / 行情时间', '数据限制'].map(label => <TableCell key={label}>{label}</TableCell>)}</TableRow></TableHead>
          <TableBody>{rows.map(row => <TableRow key={row.symbol}>
            <TableCell>{row.name || row.symbol}<Typography variant="caption" component="div">{compactCurrency(row.marketValue)}</Typography></TableCell>
            <TableCell>{row.valuationSource || '未知'}<Typography variant="caption" component="div">市场：{time(row.marketAsOf)}<br />抓取 / 导入：{time(row.fetchedAt)}</Typography></TableCell>
            <TableCell>{row.underlyingSymbol || '未识别'} · {qualityLabels[row.underlyingQuality] || row.underlyingQuality}<Typography variant="caption" component="div">市场：{time(row.underlyingQuote?.priceAsOf)}<br />抓取：{time(row.underlyingQuote?.fetchedAt)}</Typography></TableCell>
            <TableCell>{(row.issues || []).filter(issue => !issue.startsWith('underlying_')).map(issue => <Typography variant="caption" component="div" key={issue}>{issueLabels[issue] || issue}</Typography>)}</TableCell>
          </TableRow>)}</TableBody>
        </Table>
      </Box>
    </Box>
  </Box>
}
