import { useEffect, useState } from 'react'
import { Alert, Box, Button, Chip, CircularProgress, Dialog, DialogContent, DialogTitle, Divider, IconButton, LinearProgress, Popover, Stack, Typography } from '@mui/material'
import CloseRoundedIcon from '@mui/icons-material/CloseRounded'
import ExpandMoreRoundedIcon from '@mui/icons-material/ExpandMoreRounded'
import SyncRoundedIcon from '@mui/icons-material/SyncRounded'
import { usePortfolioMonitorStatus } from '../hooks/usePortfolioMonitor.js'
import { useStructuredProductsRefreshStatus } from '../hooks/useStructuredProductsRefreshStatus.js'
import { dateTime, number } from '../utils/formatters.js'
import { backgroundUpdateState, lastMonitorCheck, monitorUpdateState, productUpdateState, providerUpdateState, validTimestamp } from '../utils/backgroundUpdateStatus.js'
import PortfolioDataMonitor from './PortfolioDataMonitor.jsx'

const time = value => validTimestamp(value) ? dateTime(value) : '暂无记录'
const dotColors = { success: '#69f0c0', warning: '#ffd166', error: '#ffb4a2', info: '#c9edff', default: '#dfe6ff' }

function JobStatus({ title, state, children }) {
  return <Stack spacing={0.75}>
    <Stack direction="row" spacing={1} sx={{ alignItems: 'center', justifyContent: 'space-between' }}>
      <Typography variant="subtitle2">{title}</Typography>
      <Chip size="small" color={state.color} variant="outlined" label={state.label} />
    </Stack>
    {children}
    {state.issue && <Alert severity={state.color === 'error' ? 'error' : 'warning'} sx={{ overflowWrap: 'anywhere' }}>{state.issue}</Alert>}
  </Stack>
}

export default function BackgroundUpdateStatus() {
  const monitor = usePortfolioMonitorStatus()
  const products = useStructuredProductsRefreshStatus()
  const [anchor, setAnchor] = useState(null)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 15_000)
    return () => window.clearInterval(timer)
  }, [])

  const snapshot = monitor.data?.snapshot
  const refresh = products.data
  const monitorState = monitorUpdateState(monitor.data, monitor.error, now)
  const productState = productUpdateState(refresh, products.error, snapshot?.productMarketOpen)
  const providerState = providerUpdateState(refresh, products.error)
  const state = backgroundUpdateState(monitorState, productState, providerState)
  const progress = Number.isFinite(refresh?.progressPercent) ? Math.max(0, Math.min(100, refresh.progressPercent)) : null
  const quoteInterval = monitor.data?.intervalSeconds
  const productInterval = refresh?.intervalMinutes
  const nextQuote = snapshot?.nextQuoteAttemptAt
  const nextOpen = snapshot?.usSession?.nextOpen
  const coverage = snapshot?.usableUnderlyingCoveragePct
  const checkedAt = lastMonitorCheck(monitor.data)
  const fetching = monitor.isFetching || products.isFetching

  return <>
    <Button
      color="inherit"
      aria-label={`后台数据更新：${state.label}`}
      aria-haspopup="dialog"
      aria-expanded={Boolean(anchor)}
      aria-controls={anchor ? 'background-update-status' : undefined}
      onClick={event => setAnchor(event.currentTarget)}
      startIcon={state.busy ? <CircularProgress size={14} color="inherit" /> : <Box component="span" sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: dotColors[state.color] }} />}
      endIcon={<ExpandMoreRoundedIcon />}
      sx={{ flexShrink: 0, px: { xs: 1, sm: 1.5 }, py: 0.65, border: '1px solid rgba(255,255,255,.35)', bgcolor: 'rgba(255,255,255,.1)', '&:hover': { bgcolor: 'rgba(255,255,255,.2)' } }}
    >
      <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
        <Typography component="span" variant="body2" fontWeight={700}>后台更新</Typography>
        <Typography component="span" variant="caption">{state.label}</Typography>
      </Stack>
    </Button>
    <Popover
      open={Boolean(anchor)} anchorEl={anchor} onClose={() => setAnchor(null)}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }} transformOrigin={{ vertical: 'top', horizontal: 'right' }}
      slotProps={{ paper: { id: 'background-update-status', role: 'dialog', 'aria-labelledby': 'background-update-title', sx: { width: 420, maxWidth: 'calc(100vw - 32px)', maxHeight: 'calc(100dvh - 88px)', mt: 1, p: 2, overflowWrap: 'anywhere' } } }}
    >
      <Stack spacing={2}>
        <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between' }}>
          <Box>
            <Typography id="background-update-title" variant="subtitle1" fontWeight={800}>后台数据更新</Typography>
            <Typography variant="caption" color="text.secondary">关闭浏览器后，服务器仍按计划运行。</Typography>
          </Box>
          <IconButton size="small" aria-label="关闭后台更新状态" onClick={() => setAnchor(null)}><CloseRoundedIcon fontSize="small" /></IconButton>
        </Stack>
        <JobStatus title="标的报价与风险计算" state={monitorState}>
          <Typography variant="body2">最近检查：{checkedAt == null ? '暂无记录' : dateTime(checkedAt)}</Typography>
          {monitor.data?.runtime?.lastCycle === 'unchanged' && <Typography variant="caption" color="text.secondary">
            输入没有变化，沿用 {time(snapshot?.evaluatedAt)} 的计算结果{Number.isFinite(monitor.data.unchangedRecalcMinutes) && `；最长 ${number.format(monitor.data.unchangedRecalcMinutes)} 分钟重算一次`}。
          </Typography>}
          <Typography variant="body2" color="text.secondary">最近请求报价：{time(snapshot?.provider?.checkedAt)}</Typography>
          <Typography variant="caption" color="text.secondary">
            {snapshot?.usSession?.state === 'closed' ? `美股休市，保留最近交易时段行情。${validTimestamp(nextOpen) ? ` 下次开盘：${time(nextOpen)}。` : ''}` : snapshot?.usSession?.state === 'open' ? '美股交易中。' : '美股交易日历待确认。'}
            {Number.isFinite(quoteInterval) && ` 标的报价刷新间隔 ${number.format(quoteInterval / 60)} 分钟。`}
          </Typography>
          {snapshot?.usSession?.state !== 'closed' && validTimestamp(nextQuote) && Date.parse(nextQuote) > now && <Typography variant="caption" color="text.secondary">下次报价尝试不早于：{time(nextQuote)}</Typography>}
          {Number.isFinite(coverage) && <Typography variant="caption" color="text.secondary">有效标的行情覆盖 {number.format(coverage)}% 持仓市值；全部 {snapshot.positionCount} 个持仓。</Typography>}
        </JobStatus>
        <Divider />
        <JobStatus title="结构化产品行情" state={productState}>
          <Typography variant="body2">最近完成：{time(refresh?.lastFinishedAt)}</Typography>
          {(refresh?.running || refresh?.queued) && <>
            <LinearProgress aria-label="产品行情抓取进度" variant={refresh.running && progress != null ? 'determinate' : 'indeterminate'} value={progress ?? 0} />
            <Typography variant="caption" color="text.secondary">
              {refresh.running ? `${refresh.progressTotal > 0 ? `${refresh.progressCurrent ?? 0} / ${refresh.progressTotal} 个产品 · ` : ''}${progress == null ? '等待进度' : `${progress}%`}` : `等待执行${refresh.queuedRequests > 0 ? ` · ${refresh.queuedRequests} 个任务` : ''}`}
            </Typography>
          </>}
          <Typography variant="caption" color="text.secondary">
            {Number.isFinite(productInterval) ? `交易窗口内每 ${number.format(productInterval)} 分钟刷新。` : '刷新间隔待确认。'}
            {Number.isFinite(refresh?.marketOpenHourBerlin) && Number.isFinite(refresh?.marketCloseHourBerlin) && ` 交易日 ${refresh.marketOpenHourBerlin}:00–${refresh.marketCloseHourBerlin}:00（柏林时间）。`}
          </Typography>
          {!refresh?.lastFinishedAt && <Typography variant="caption" color="text.secondary">服务启动后尚无完成记录，页面可能仍使用已有缓存。</Typography>}
        </JobStatus>
        <Divider />
        <JobStatus title="数据源访问保护" state={providerState}>
          {Array.isArray(refresh?.providers) && refresh.providers.map(provider => <Box key={provider.source} sx={{ bgcolor: 'action.hover', borderRadius: 1, p: 1 }}>
            <Typography variant="caption" component="div" fontWeight={700}>
              {provider.label || (provider.source === 'api.onvista.de' ? 'Onvista' : provider.source === 'api.boerse-frankfurt.de' ? 'Börse Frankfurt' : provider.source)}
              {' · '}{provider.coolingDown ? '暂停请求' : provider.lastStatus >= 200 && provider.lastStatus < 300 ? '最近请求成功' : '等待下次尝试'}
            </Typography>
            {provider.coolingDown && <Typography variant="caption" color="text.secondary" component="div">
              {provider.lastStatus ? `HTTP ${provider.lastStatus}` : '连接或响应异常'} · 最早重试：{time(provider.retryAt)}
            </Typography>}
            <Typography variant="caption" color="text.secondary" component="div">最近请求：{time(provider.lastCheckedAt)}</Typography>
          </Box>)}
        </JobStatus>
        <Divider />
        <Typography variant="caption" color="text.secondary">以上是任务检查与抓取时间，不等于行情成交时间；数据缺失、过期和风险预警可在完整监控中查看。</Typography>
        <Stack direction="row" spacing={1} sx={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 1 }}>
          <Button size="small" startIcon={fetching ? <CircularProgress size={14} /> : <SyncRoundedIcon />} disabled={fetching} onClick={() => { monitor.refetch(); products.refetch() }}>刷新状态</Button>
          <Button size="small" variant="contained" onClick={() => { setAnchor(null); setDetailsOpen(true) }}>查看完整监控</Button>
        </Stack>
      </Stack>
    </Popover>
    <Dialog open={detailsOpen} onClose={() => setDetailsOpen(false)} maxWidth="lg" fullWidth aria-labelledby="background-monitor-details-title" slotProps={{ paper: { sx: { m: { xs: 1, sm: 4 }, width: { xs: 'calc(100% - 16px)', sm: 'calc(100% - 64px)' } } } }}>
      <DialogTitle id="background-monitor-dialog-heading" sx={{ pr: 7 }}>
        <Box component="span" id="background-monitor-details-title">后台数据与风险监控</Box>
        <IconButton aria-label="关闭完整监控" onClick={() => setDetailsOpen(false)} sx={{ position: 'absolute', right: 12, top: 12 }}><CloseRoundedIcon /></IconButton>
      </DialogTitle>
      <DialogContent dividers><PortfolioDataMonitor /></DialogContent>
    </Dialog>
  </>
}
