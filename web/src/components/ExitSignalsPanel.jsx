import { useState } from 'react'
import {
  Alert,
  Box,
  Chip,
  Divider,
  FormControlLabel,
  Paper,
  Stack,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material'

import { compactCurrency, number } from '../utils/formatters.js'
import { EXIT_SIGNAL_DEFAULTS } from '../utils/exitSignals.js'

const levelMeta = {
  urgent: { label: '优先复核', color: 'error' },
  warn: { label: '留意', color: 'warning' },
  ok: { label: '未触发', color: 'success' },
  unknown: { label: '数据不足', color: 'default' },
}

const productTypeLabels = {
  optionsschein: '权证',
  open_end_turbo: 'Turbo',
  knock_out: 'Knock-out',
  factor_certificate: 'Factor',
}

const trendLabels = { against: '逆向', with: '顺向', mixed: '不明确' }
const volatilitySourceLabels = { realized20: '20 日历史', realized60: '60 日历史', implied: '权证隐含' }

const signed = value => `${value > 0 ? '+' : ''}${number.format(value)}%`
const probability = value => (value == null ? '—' : `${number.format(Math.round(value * 100))}%`)
const valueOrDash = (value, format = signed) => (value == null ? '—' : format(value))

function Line({ children, color = 'text.secondary' }) {
  return <Typography variant="caption" component="div" color={color}>{children}</Typography>
}

function KeyMetrics({ signal }) {
  const { barrier, breakEven, factor, volatility } = signal
  // Warrants are judged on pay-off odds, everything else on ruin risk.
  const [usedPct, usedSource] = breakEven ? [volatility.payoffPct, volatility.payoffSource] : [volatility.riskPct, volatility.riskSource]
  return <>
    {barrier && <>
      <Typography variant="body2">障碍距离 {number.format(barrier.distancePct)}%{barrier.dailySigmas != null ? ` · ${number.format(barrier.dailySigmas)} 个日波动` : ''}</Typography>
      <Line>敲出概率 7 天 {probability(barrier.probability7d)} · 30 天 {probability(barrier.probability30d)}</Line>
    </>}
    {breakEven && <>
      <Typography variant="body2">
        {(signal.direction === 'put' ? breakEven.requiredMovePct < 0 : breakEven.requiredMovePct > 0)
          ? `保本需标的 ${signed(breakEven.requiredMovePct)}`
          : '标的已过保本位'}
        {breakEven.expectedMovePct != null ? ` · 1σ ±${number.format(breakEven.expectedMovePct)}%` : ''}
      </Typography>
      <Line>保本概率 {probability(breakEven.probability)} · 归零概率 {probability(breakEven.worthlessProbability)} · 时间价值占 {number.format(breakEven.timeValuePct)}%</Line>
    </>}
    {factor && <>
      <Typography variant="body2">{number.format(factor.leverage)} 倍 · 单日逆向 {number.format(factor.wipeoutMovePct)}% 归零</Typography>
      <Line>
        2σ 单日约亏 {valueOrDash(factor.twoSigmaDayLossPct, value => `${number.format(value)}%`)}
        {factor.worstDayMovePct != null ? ` · 年内最大单日逆向 ${signed(factor.worstDayMovePct)}` : ''}
      </Line>
    </>}
    {!barrier && !breakEven && !factor && <Typography variant="body2" color="text.secondary">缺少条款数据</Typography>}
    <Line>
      {usedPct != null
        ? `波动率 ${number.format(usedPct)}%（${volatilitySourceLabels[usedSource]}）`
        : '无波动率数据，概率无法计算'}
      {[['20 日', volatility.realized20Pct], ['60 日', volatility.realized60Pct], ['隐含', volatility.impliedPct]]
        .filter(([, value]) => value != null).length > 1
        ? ` · ${[['20 日', volatility.realized20Pct], ['60 日', volatility.realized60Pct], ['隐含', volatility.impliedPct]].filter(([, value]) => value != null).map(([label, value]) => `${label} ${number.format(value)}%`).join(' / ')}`
        : ''}
    </Line>
  </>
}

export default function ExitSignalsPanel({ report, dailyStats, dailyStatsLoading, dailyStatsError, dailyStatsWarnings = [], onSelectProduct }) {
  const [showAll, setShowAll] = useState(false)
  const flagged = report.counts.urgent + report.counts.warn + report.counts.unknown
  const rows = showAll ? report.signals : report.signals.filter(signal => signal.level !== 'ok')
  const staleCount = (dailyStats || []).filter(stats => stats.stale).length
  const latestAsOf = (dailyStats || []).map(stats => stats.asOf).filter(Boolean).sort().at(-1)
  const thresholds = EXIT_SIGNAL_DEFAULTS

  if (!report.signals.length) return null

  return (
    <Box sx={{ border: '1px solid #dfe6ee', borderRadius: 2, overflow: 'hidden', backgroundColor: '#fbfdff' }}>
      <Stack spacing={1.25} sx={{ p: { xs: 1.5, md: 2 } }}>
        <Box>
          <Typography variant="subtitle1" fontWeight={900}>退场信号</Typography>
          <Typography variant="body2" color="text.secondary">按敲出概率、保本概率、时间损耗和标的趋势标出值得优先复核的持仓；概率来自模型假设，不是预测，也不构成交易指令。</Typography>
        </Box>
        <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
          {['urgent', 'warn', 'ok', 'unknown'].filter(level => report.counts[level] > 0).map(level => (
            <Chip key={level} size="small" color={levelMeta[level].color} variant={level === 'ok' || level === 'unknown' ? 'outlined' : 'filled'}
              label={`${levelMeta[level].label} ${report.counts[level]} 个 · ${compactCurrency(report.values[level])}`} />
          ))}
          <FormControlLabel sx={{ ml: 0.5 }} control={<Switch size="small" checked={showAll} onChange={event => setShowAll(event.target.checked)} />} label="显示全部" />
        </Stack>
        {dailyStatsError && <Alert severity="warning" sx={{ py: 0 }}>标的日线统计读取失败，趋势与历史波动率不可用；以下概率只使用权证隐含波动率。</Alert>}
      </Stack>
      <Divider />
      <Box sx={{ p: { xs: 1.25, md: 1.75 } }}>
        {rows.length === 0 ? <Typography variant="body2" color="text.secondary">当前没有触发信号的持仓。</Typography> : (
          <TableContainer component={Paper} variant="outlined" sx={{ maxHeight: 520 }}>
            <Table size="small" stickyHeader aria-label="退场信号" sx={{ minWidth: 900, '& th': { whiteSpace: 'nowrap' }, '& td': { verticalAlign: 'top' } }}>
              <TableHead><TableRow>
                <TableCell>产品 / 标的</TableCell><TableCell>信号</TableCell><TableCell>关键指标</TableCell>
                <TableCell align="right">横盘成本</TableCell><TableCell>标的趋势</TableCell><TableCell align="right">市值 / 浮盈亏</TableCell>
              </TableRow></TableHead>
              <TableBody>{rows.map(signal => (
                <TableRow key={signal.id} hover onClick={() => onSelectProduct?.(signal.id)} sx={{ cursor: onSelectProduct ? 'pointer' : 'default' }}>
                  <TableCell sx={{ maxWidth: 230 }}>
                    <Typography variant="body2" fontWeight={700} noWrap title={signal.name}>{signal.name}</Typography>
                    <Line>{productTypeLabels[signal.productType] || signal.productType} · {signal.groupName}{signal.daysToExpiry != null ? ` · ${signal.daysToExpiry} 天到期` : ''}</Line>
                  </TableCell>
                  <TableCell sx={{ minWidth: 260, maxWidth: 380 }}>
                    <Chip size="small" color={levelMeta[signal.level].color} variant={signal.level === 'urgent' || signal.level === 'warn' ? 'filled' : 'outlined'} label={levelMeta[signal.level].label} sx={{ height: 20, mb: 0.25 }} />
                    {signal.reasons.map(reason => <Line key={reason.code} color={reason.severity === 'urgent' ? 'error.main' : 'text.primary'}>{reason.text}</Line>)}
                  </TableCell>
                  <TableCell sx={{ minWidth: 250 }}><KeyMetrics signal={signal} /></TableCell>
                  <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>
                    <Typography variant="body2">7 天 {valueOrDash(signal.decay.return7dPct)}</Typography>
                    <Line>30 天 {valueOrDash(signal.decay.return30dPct)}</Line>
                  </TableCell>
                  <TableCell sx={{ whiteSpace: 'nowrap' }}>
                    {signal.trend ? <>
                      <Typography variant="body2" color={signal.trend.state === 'against' ? 'error.main' : 'text.primary'}>{trendLabels[signal.trend.state]} · 较 50 日线 {signed(signal.trend.vsSma50Pct)}</Typography>
                      <Line>20 日 {valueOrDash(signal.trend.return20dPct)} · 距一年高点 {valueOrDash(signal.trend.fromHighPct)}</Line>
                    </> : <Typography variant="body2" color="text.secondary">{dailyStatsLoading ? '读取中…' : '无日线数据'}</Typography>}
                  </TableCell>
                  <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>
                    <Typography variant="body2">{compactCurrency(signal.currentValue)}</Typography>
                    {signal.unrealizedPct != null && <Line color={signal.unrealizedPct < 0 ? 'error.main' : 'success.main'}>{signed(signal.unrealizedPct)}</Line>}
                  </TableCell>
                </TableRow>
              ))}</TableBody>
            </Table>
          </TableContainer>
        )}
        {!showAll && flagged < report.signals.length && <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>另有 {report.signals.length - flagged} 个持仓未触发信号，打开“显示全部”查看。</Typography>}
        <Box component="details" sx={{ mt: 1.5 }}>
          <Typography component="summary" variant="body2" sx={{ cursor: 'pointer', mb: 1 }}>计算说明与默认阈值</Typography>
          <Typography variant="caption" color="text.secondary" component="div">
            波动率有三个读数：标的 20 日和 60 日历史波动率（年化），以及同标的权证隐含波动率的中位数。敲出和 Factor 单日风险取三者中最高的，偏保守；保本与归零概率用隐含波动率（即市场定价口径），没有时才用 60 日历史值，因为更高的波动率反而会抬高价外权证的保本概率。
            {report.withHistoryCount} / {report.signals.length} 个持仓有标的日线统计{latestAsOf ? `，最新日线 ${latestAsOf}` : ''}{staleCount ? `，其中 ${staleCount} 个标的的日线未能更新` : ''}；没有日线的标的只用隐含波动率，都没有则列为数据不足。
            敲出概率是标的在连续观察下触及敲出价的概率，按无漂移的对数正态路径计算，开放式 Turbo 的敲出价按假设融资成本上移；没有模拟跳空、日内与盘前盘后差异和发行人条款细节。
            保本概率是到期时标的越过保本位（行权价 ± 当前价格 ÷ 比率）的概率，归零概率是到期时处于价外的概率；这是到期口径，中途卖出的盈亏不在其内。
            横盘成本是标的不动时 7 天与 30 天后的模型估值变化，权证为时间价值损耗，Turbo 为融资成本，Factor 为融资、年费和波动损耗。
            趋势要求标的现价偏离 50 日均线至少 {thresholds.trendMinGapPct}%，且 20 日均线在 50 日均线同侧，再对照持仓方向；日线为 Alpaca IEX 复权数据，以上市币种计。
          </Typography>
          <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 0.75 }}>
            默认阈值（用于排序提示，不是你的个人风险限额）：
            优先复核：7 天敲出概率 ≥ {number.format(thresholds.knockoutUrgentProbability7d * 100)}%，保本概率 ≤ {number.format(thresholds.breakEvenUrgentProbability * 100)}%（或 {thresholds.shortDatedDays} 天内到期且 ≤ {number.format(thresholds.breakEvenWarnProbability * 100)}%），权证 {thresholds.expiryUrgentDays} 天内到期，横盘 7 天 ≤ {thresholds.decayUrgentReturn7dPct}% 或 30 天 ≤ {thresholds.decayUrgentReturn30dPct}%。
            留意：30 天敲出概率 ≥ {number.format(thresholds.knockoutWarnProbability30d * 100)}%，保本概率 ≤ {number.format(thresholds.breakEvenWarnProbability * 100)}%，权证 {thresholds.shortDatedDays} 天内到期，横盘 30 天 ≤ {thresholds.decayWarnReturn30dPct}%，Factor 的 2σ 单日亏损 ≥ {thresholds.factorWarnTwoSigmaDayLossPct}% 或年内最大单日逆向波动足以归零，标的趋势与持仓方向相反。
          </Typography>
          {dailyStatsWarnings.length > 0 && <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 0.75 }}>日线数据提示：{dailyStatsWarnings.slice(0, 5).join('；')}{dailyStatsWarnings.length > 5 ? ` 等 ${dailyStatsWarnings.length} 条` : ''}</Typography>}
        </Box>
      </Box>
    </Box>
  )
}
