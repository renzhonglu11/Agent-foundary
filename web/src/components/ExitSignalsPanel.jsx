import { Fragment, useState } from 'react'
import {
  Alert,
  Button,
  Box,
  Chip,
  Collapse,
  Divider,
  IconButton,
  Paper,
  Stack,
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
import { EXIT_LEVEL_META, productTypeLabel } from '../utils/labels.js'
import { Label, Section } from './shared/Disclosure.jsx'
import KeyboardArrowDownRoundedIcon from '@mui/icons-material/KeyboardArrowDownRounded'

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

const FILTERS = [
  { id: 'flagged', label: '需关注', levels: ['urgent', 'warn', 'unknown'] },
  { id: 'urgent', label: EXIT_LEVEL_META.urgent.label, levels: ['urgent'] },
  { id: 'warn', label: EXIT_LEVEL_META.warn.label, levels: ['warn'] },
  { id: 'unknown', label: EXIT_LEVEL_META.unknown.label, levels: ['unknown'] },
  { id: 'ok', label: EXIT_LEVEL_META.ok.label, levels: ['ok'] },
  { id: 'all', label: '全部', levels: ['urgent', 'warn', 'unknown', 'ok'] },
]

const TIPS = {
  signal: '按默认阈值判断：优先复核 > 留意 > 数据不足 > 未触发。阈值见下方“计算说明与默认阈值”。',
  flat: '标的 7 天 / 30 天不动时的模型估值变化：权证为时间价值损耗，Turbo 为融资成本，Factor 为融资、年费和波动损耗。',
}

function Part({ title, children }) {
  return (
    <Box>
      <Typography variant="body2" fontWeight={800} sx={{ mb: 0.25 }}>{title}</Typography>
      <Typography variant="body2" color="text.secondary" component="div">{children}</Typography>
    </Box>
  )
}

function SignalDetails({ signal, dailyStatsLoading, onSelectProduct }) {
  return (
    <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: 'repeat(3, minmax(0, 1fr))' }, gap: 2, py: 1 }}>
      <Box sx={{ minWidth: 0 }}>
        <Typography variant="caption" fontWeight={800} component="div">全部原因</Typography>
        {signal.reasons.length ? signal.reasons.map(reason => <Line key={reason.code} color={reason.severity === 'urgent' ? 'error.main' : 'text.primary'}>{reason.text}</Line>) : <Line>没有触发条件</Line>}
      </Box>
      <Box sx={{ minWidth: 0 }}>
        <Typography variant="caption" fontWeight={800} component="div">关键指标</Typography>
        <KeyMetrics signal={signal} />
      </Box>
      <Box sx={{ minWidth: 0 }}>
        <Typography variant="caption" fontWeight={800} component="div">标的趋势</Typography>
        {signal.trend ? <>
          <Typography variant="body2" color={signal.trend.state === 'against' ? 'error.main' : 'text.primary'}>{trendLabels[signal.trend.state]} · 较 50 日线 {signed(signal.trend.vsSma50Pct)}</Typography>
          <Line>20 日 {valueOrDash(signal.trend.return20dPct)} · 距一年高点 {valueOrDash(signal.trend.fromHighPct)}</Line>
        </> : <Typography variant="body2" color="text.secondary">{dailyStatsLoading ? '读取中…' : '无日线数据'}</Typography>}
        {onSelectProduct ? <Button size="small" onClick={() => onSelectProduct(signal.id)} sx={{ mt: 1, px: 0, textTransform: 'none' }}>在持仓中查看产品详情</Button> : null}
      </Box>
    </Box>
  )
}

export default function ExitSignalsPanel({ report, dailyStats, dailyStatsLoading, dailyStatsError, dailyStatsWarnings = [], onSelectProduct, planReductions = {}, onPlanReduction, onShowPlan }) {
  const planCount = Object.values(planReductions).filter(pct => pct > 0).length
  const [filterId, setFilterId] = useState('flagged')
  const [expandedId, setExpandedId] = useState(null)
  const staleCount = (dailyStats || []).filter(stats => stats.stale).length
  const latestAsOf = (dailyStats || []).map(stats => stats.asOf).filter(Boolean).sort().at(-1)
  const thresholds = EXIT_SIGNAL_DEFAULTS

  if (!report.signals.length) return null

  const countOf = filter => filter.levels.reduce((sum, level) => sum + (report.counts[level] || 0), 0)
  const valueOf = filter => filter.levels.reduce((sum, level) => sum + (report.values[level] || 0), 0)
  const filter = FILTERS.find(item => item.id === filterId) || FILTERS[0]
  const rows = report.signals.filter(signal => filter.levels.includes(signal.level))
  const columnCount = onPlanReduction ? 6 : 5

  return (
    <Box sx={{ border: '1px solid #d9e2ec', borderRadius: 2, overflow: 'hidden', backgroundColor: '#fbfdff' }}>
      <Stack spacing={1.25} sx={{ p: { xs: 1.5, md: 2 } }}>
        <Box>
          <Typography variant="subtitle1" fontWeight={900}>退场信号</Typography>
          <Typography variant="body2" color="text.secondary">按敲出、保本、时间损耗和标的趋势标出值得复核的持仓。概率来自模型假设，不是预测，也不是交易指令。</Typography>
        </Box>
        <Stack direction="row" spacing={0.75} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
          {FILTERS.filter(item => countOf(item) > 0 || item.id === 'flagged').map(item => {
            const selected = item.id === filter.id
            const tone = item.levels.length === 1 ? EXIT_LEVEL_META[item.levels[0]].color : 'primary'
            return (
              <Chip
                key={item.id}
                size="small"
                clickable
                color={tone}
                variant={selected ? 'filled' : 'outlined'}
                aria-pressed={selected}
                onClick={() => { setFilterId(item.id); setExpandedId(null) }}
                label={`${item.label} ${countOf(item)}${item.id === 'all' ? '' : ` · ${compactCurrency(valueOf(item))}`}`}
              />
            )
          })}
          {onShowPlan && planCount > 0 ? <Button size="small" onClick={onShowPlan} sx={{ ml: 'auto', textTransform: 'none' }}>自定义方案 {planCount} 只 · 去方案对比</Button> : null}
        </Stack>
        {dailyStatsError && <Alert severity="warning" sx={{ py: 0 }}>标的日线统计读取失败，趋势与历史波动率不可用；概率只使用权证隐含波动率。</Alert>}
      </Stack>
      <Divider />
      <Stack spacing={1.5} sx={{ p: { xs: 1.25, md: 1.75 } }}>
        {rows.length === 0 ? <Typography variant="body2" color="text.secondary">该筛选下没有持仓。</Typography> : (
          <TableContainer component={Paper} variant="outlined" sx={{ maxHeight: 620 }}>
            <Table size="small" stickyHeader aria-label="退场信号" sx={{ minWidth: onPlanReduction ? 760 : 620, '& th': { whiteSpace: 'nowrap' }, '& td': { verticalAlign: 'top' } }}>
              <TableHead><TableRow>
                <TableCell padding="checkbox" />
                <TableCell>产品 / 标的</TableCell>
                <TableCell><Label tip={TIPS.signal}>信号与主要原因</Label></TableCell>
                <TableCell align="right"><Label tip={TIPS.flat}>横盘 7 / 30 天</Label></TableCell>
                <TableCell align="right">市值 / 浮盈亏</TableCell>
                {onPlanReduction ? <TableCell align="right">方案</TableCell> : null}
              </TableRow></TableHead>
              <TableBody>{rows.map(signal => {
                const expanded = expandedId === signal.id
                const meta = EXIT_LEVEL_META[signal.level]
                const [firstReason, ...moreReasons] = signal.reasons
                return (
                  <Fragment key={signal.id}>
                    <TableRow hover selected={expanded} onClick={() => setExpandedId(expanded ? null : signal.id)} sx={{ cursor: 'pointer', '& > td': { borderBottom: expanded ? 'none' : undefined } }}>
                      <TableCell padding="checkbox">
                        <IconButton size="small" aria-label={expanded ? '收起详情' : '展开详情'} aria-expanded={expanded} onClick={event => { event.stopPropagation(); setExpandedId(expanded ? null : signal.id) }}>
                          <KeyboardArrowDownRoundedIcon fontSize="small" sx={{ transform: expanded ? 'rotate(180deg)' : 'none', transition: 'transform 150ms' }} />
                        </IconButton>
                      </TableCell>
                      <TableCell sx={{ maxWidth: 240 }}>
                        <Typography variant="body2" fontWeight={700} noWrap title={signal.name}>{signal.name}</Typography>
                        <Line>{productTypeLabel(signal.productType)} · {signal.groupName}{signal.daysToExpiry != null ? ` · ${signal.daysToExpiry} 天到期` : ''}</Line>
                      </TableCell>
                      <TableCell sx={{ minWidth: 240, maxWidth: 360 }}>
                        <Chip size="small" color={meta.color} variant={signal.level === 'urgent' || signal.level === 'warn' ? 'filled' : 'outlined'} label={meta.label} sx={{ height: 20, mb: 0.25 }} />
                        {firstReason ? <Line color={firstReason.severity === 'urgent' ? 'error.main' : 'text.primary'}>{firstReason.text}</Line> : null}
                        {moreReasons.length ? <Line>另有 {moreReasons.length} 条，展开查看</Line> : null}
                      </TableCell>
                      <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>
                        <Typography variant="body2">{valueOrDash(signal.decay.return7dPct)}</Typography>
                        <Line color={signal.decay.return30dPct != null && signal.decay.return30dPct <= -15 ? 'error.main' : 'text.secondary'}>{valueOrDash(signal.decay.return30dPct)}</Line>
                      </TableCell>
                      <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>
                        <Typography variant="body2">{compactCurrency(signal.currentValue)}</Typography>
                        {signal.unrealizedPct != null && <Line color={signal.unrealizedPct < 0 ? 'error.main' : 'success.main'}>{signed(signal.unrealizedPct)}</Line>}
                      </TableCell>
                      {onPlanReduction ? (
                        <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>
                          {planReductions[signal.id] > 0 ? (
                            <Button size="small" variant="contained" aria-pressed="true" onClick={event => { event.stopPropagation(); onPlanReduction(signal.id, 0) }} sx={{ textTransform: 'none' }}>
                              已加入 · {planReductions[signal.id] >= 100 ? '退出' : `减 ${planReductions[signal.id]}%`}
                            </Button>
                          ) : (
                            <Button size="small" variant="outlined" aria-pressed="false" onClick={event => { event.stopPropagation(); onPlanReduction(signal.id, 50) }} sx={{ textTransform: 'none' }}>
                              加入方案 · 减 50%
                            </Button>
                          )}
                        </TableCell>
                      ) : null}
                    </TableRow>
                    <TableRow>
                      <TableCell colSpan={columnCount} sx={{ py: 0, borderBottom: expanded ? undefined : 'none' }}>
                        <Collapse in={expanded} unmountOnExit>
                          <SignalDetails signal={signal} dailyStatsLoading={dailyStatsLoading} onSelectProduct={onSelectProduct} />
                        </Collapse>
                      </TableCell>
                    </TableRow>
                  </Fragment>
                )
              })}</TableBody>
            </Table>
          </TableContainer>
        )}
        <Section
          title="计算说明与默认阈值"
          summary={`${report.withHistoryCount} / ${report.signals.length} 个持仓有标的日线统计${latestAsOf ? `，最新日线 ${latestAsOf}` : ''}${staleCount ? `，${staleCount} 个标的日线未更新` : ''}`}
        >
          <Stack spacing={1.25}>
            <Part title="波动率">
              有三个读数：标的 20 日和 60 日历史波动率（年化），以及同标的权证隐含波动率的中位数。敲出和 Factor 单日风险取三者中最高的，偏保守；保本与归零概率用隐含波动率，没有时才用 60 日历史值，因为更高的波动率反而会抬高价外权证的保本概率。没有日线的标的只用隐含波动率，都没有则列为数据不足。
            </Part>
            <Part title="敲出概率">
              标的在连续观察下触及敲出价的概率，按无漂移的对数正态路径计算；开放式 Turbo 的敲出价按假设融资成本上移。没有模拟跳空、日内与盘前盘后差异和发行人条款细节。
            </Part>
            <Part title="保本与归零概率">
              保本概率是到期时标的越过保本位（行权价 ± 当前价格 ÷ 比率）的概率，归零概率是到期时处于价外的概率。这是到期口径，中途卖出的盈亏不在其内。
            </Part>
            <Part title="横盘成本">{TIPS.flat}</Part>
            <Part title="趋势">
              要求标的现价偏离 50 日均线至少 {thresholds.trendMinGapPct}%，且 20 日均线在 50 日均线同侧，再对照持仓方向。日线为 Alpaca IEX 复权数据，以上市币种计。
            </Part>
            <Part title="默认阈值（用于排序提示，不是你的个人风险限额）">
              优先复核：7 天敲出概率 ≥ {number.format(thresholds.knockoutUrgentProbability7d * 100)}%，保本概率 ≤ {number.format(thresholds.breakEvenUrgentProbability * 100)}%（或 {thresholds.shortDatedDays} 天内到期且 ≤ {number.format(thresholds.breakEvenWarnProbability * 100)}%），权证 {thresholds.expiryUrgentDays} 天内到期，横盘 7 天 ≤ {thresholds.decayUrgentReturn7dPct}% 或 30 天 ≤ {thresholds.decayUrgentReturn30dPct}%。
              <br />
              留意：30 天敲出概率 ≥ {number.format(thresholds.knockoutWarnProbability30d * 100)}%，保本概率 ≤ {number.format(thresholds.breakEvenWarnProbability * 100)}%，权证 {thresholds.shortDatedDays} 天内到期，横盘 30 天 ≤ {thresholds.decayWarnReturn30dPct}%，Factor 的 2σ 单日亏损 ≥ {thresholds.factorWarnTwoSigmaDayLossPct}% 或年内最大单日逆向波动足以归零，标的趋势与持仓方向相反。
            </Part>
            {dailyStatsWarnings.length > 0 ? <Part title="日线数据提示">{dailyStatsWarnings.slice(0, 5).join('；')}{dailyStatsWarnings.length > 5 ? ` 等 ${dailyStatsWarnings.length} 条` : ''}</Part> : null}
          </Stack>
        </Section>
      </Stack>
    </Box>
  )
}
