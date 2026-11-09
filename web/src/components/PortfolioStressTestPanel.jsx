import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
  TextField,
  MenuItem,
  FormControlLabel,
  Switch,
} from '@mui/material'
import AutoAwesomeRoundedIcon from '@mui/icons-material/AutoAwesomeRounded'
import PortfolioDataMonitor from './PortfolioDataMonitor.jsx'
import { buildPortfolioAdjustments, buildScenarioContributions, buildShockTargets, comparePortfolioStress } from '../utils/portfolioComparison.js'
import { REDUCTION_STEPS, buildCustomPlan, buildPresetPlans, rankReductions } from '../utils/positionWhatIf.js'

import { compactCurrency, number } from '../utils/formatters.js'
import {
  PORTFOLIO_STRESS_HORIZONS,
  buildHermesStressReviewPayload,
  buildPortfolioStressReport,
  buildStressScenarios,
  buildDirectPriceStress,
  buildGroupShockScales,
} from '../utils/portfolioStress.js'

const confidenceLabels = {
  live_delta: '提供方 Delta',
  estimated_delta: '估算 Delta',
  estimated_omega: '估算 Omega',
  estimated_leverage: '估算杠杆',
  estimated_market_value: '市值估算',
  no_data: '低置信度',
}

const productTypeLabels = {
  optionsschein: '权证',
  open_end_turbo: 'Turbo',
  knock_out: 'Knock-out',
  factor_certificate: 'Factor',
}

const adjustmentLabels = {
  exit: '模拟退出',
  reduce: '减仓',
  increase: '加仓',
}

const exitLevelMeta = {
  urgent: { label: '优先复核', color: 'error' },
  warn: { label: '留意', color: 'warning' },
}
const exitLevelRank = ['urgent', 'warn', 'ok', 'unknown']
const reductionLabel = pct => (pct >= 100 ? '退出' : `减 ${pct}%`)

const selectionFlagLabels = {
  WATCH_PENALIZED: 'WATCH 降权',
  ELASTIC_ONLY: '仅高弹性',
  EXPOSURE_CAPPED_8_PCT: '敞口限至 8%',
  HELD_AT_CURRENT: '不加仓',
  MODEL_FALLBACK: '模型兜底估算',
}

function signedPercent(value) {
  const numeric = Number(value) || 0
  return `${numeric > 0 ? '+' : ''}${number.format(numeric)}%`
}

function pnlColor(value) {
  if (value > 0) return 'success.main'
  if (value < 0) return 'error.main'
  return 'text.secondary'
}

function quoteWindow(entries, field) {
  const dates = entries.map(entry => entry.item?.[field]).filter(value => value && Number.isFinite(Date.parse(value))).sort((a, b) => Date.parse(a) - Date.parse(b))
  const unknown = entries.length - dates.length
  return dates.length ? `${new Date(dates[0]).toLocaleString()} — ${new Date(dates.at(-1)).toLocaleString()}；${unknown} 项未知` : '全部未知'
}

export default function PortfolioStressTestPanel({ entries, positions = [], exitSignals, loading, totalMarketValue, totalCostBasis }) {
  const [scenarioId, setScenarioId] = useState(null)
  const [stressEnabled, setStressEnabled] = useState(true)
  const [rankScope, setRankScope] = useState('product')
  const [rankReduction, setRankReduction] = useState(50)
  const [rankSort, setRankSort] = useState('efficiency')
  const [customReductions, setCustomReductions] = useState({})
  const [horizonDays, setHorizonDays] = useState(0)
  const [shock, setShock] = useState(20)
  const [target, setTarget] = useState('')
  const [shockMode, setShockMode] = useState('uniform')
  const [ivMove, setIvMove] = useState(0)
  const [fxMove, setFxMove] = useState(0)
  const groupShock = useMemo(() => buildGroupShockScales(entries), [entries])
  const volScaled = shockMode === 'volatility' && !target
  const scenarios = useMemo(() => buildStressScenarios(shock, target || null, horizonDays > 0, {
    groupScales: volScaled ? groupShock.scales : null,
    ivMovePct: ivMove,
    fxMovePct: fxMove,
    adverse: true,
  }), [shock, target, horizonDays, volScaled, groupShock, ivMove, fxMove])
  const direct = buildDirectPriceStress(positions, entries)
  const [selectedPortfolioId, setSelectedPortfolioId] = useState(null)
  const [hermesStatus, setHermesStatus] = useState({ loading: true, available: null, model: null })
  const [hermesReview, setHermesReview] = useState({ loading: false, data: null, error: null })
  const totals = useMemo(() => ({ totalMarketValue, totalCostBasis, positions }), [totalMarketValue, totalCostBasis, positions])
  // The presets are derived from the current holdings, so those are priced first.
  const holdingsReport = useMemo(
    () => buildPortfolioStressReport(entries, horizonDays, scenarios, totals, { plans: [] }),
    [entries, horizonDays, scenarios, totals],
  )
  const plans = useMemo(() => {
    const holdings = holdingsReport.portfolios[0] || null
    const held = new Set((holdings?.products || []).map(product => product.id))
    const custom = buildCustomPlan(Object.fromEntries(Object.entries(customReductions).filter(([id]) => held.has(id))))
    return [...buildPresetPlans(holdings, exitSignals), custom].filter(Boolean)
  }, [holdingsReport, exitSignals, customReductions])
  const report = useMemo(
    () => (plans.length ? buildPortfolioStressReport(entries, horizonDays, scenarios, totals, { plans }) : holdingsReport),
    [entries, horizonDays, scenarios, totals, plans, holdingsReport],
  )
  const stressEnabledRef = useRef(stressEnabled)
  stressEnabledRef.current = stressEnabled
  const reportRef = useRef(report)
  reportRef.current = report

  useEffect(() => {
    setHermesReview({ loading: false, data: null, error: null })
  }, [report])

  const defaultPortfolioId = report.portfolios.find((portfolio) => portfolio.id === 'custom')?.id
    || report.portfolios[1]?.id
    || report.portfolios[0]?.id
    || null
  const resolvedPortfolioId = report.portfolios.some((portfolio) => portfolio.id === selectedPortfolioId)
    ? selectedPortfolioId
    : defaultPortfolioId
  const selectedPortfolio = report.portfolios.find((portfolio) => portfolio.id === resolvedPortfolioId) || null
  const baseline = report.portfolios.find(portfolio => portfolio.kind === 'baseline')
  // Every held underlying can be shocked, whichever plan is selected.
  const shockTargets = useMemo(() => buildShockTargets(baseline), [baseline])
  const ranking = useMemo(() => rankReductions(baseline, { reductionPct: rankReduction, scope: rankScope, sortBy: rankSort }), [baseline, rankReduction, rankScope, rankSort])
  const exitSignalById = useMemo(() => new Map((exitSignals || []).map(signal => [signal.id, signal])), [exitSignals])
  const targetAvailable = shockTargets.some(({ key }) => key === target)

  useEffect(() => {
    if (target && !targetAvailable) setTarget('')
  }, [target, targetAvailable])

  useEffect(() => {
    const controller = new AbortController()
    fetch('/api/portfolio-stress/hermes-review', { cache: 'no-store', signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`Hermes 状态请求失败: ${response.status}`)
        return response.json()
      })
      .then((payload) => {
        setHermesStatus({ loading: false, available: Boolean(payload?.available), model: payload?.model || null })
      })
      .catch((error) => {
        if (error.name === 'AbortError') return
        setHermesStatus({ loading: false, available: false, model: null })
      })
    return () => controller.abort()
  }, [])

  const handleHorizonChange = (nextHorizon) => {
    setHorizonDays(nextHorizon)
    setHermesReview({ loading: false, data: null, error: null })
  }

  const requestHermesReview = async () => {
    setHermesReview({ loading: true, data: null, error: null })
    try {
      const response = await fetch('/api/portfolio-stress/hermes-review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildHermesStressReviewPayload(report)),
      })
      const payload = await response.json().catch(() => ({}))
      if (reportRef.current !== report || !stressEnabledRef.current) return
      if (!response.ok) throw new Error(payload?.error || `Hermes 请求失败: ${response.status}`)
      if (!payload?.available) {
        setHermesStatus((current) => ({ ...current, loading: false, available: false }))
        throw new Error(payload?.unavailableReason || '当前环境未安装 Hermes')
      }
      setHermesReview({ loading: false, data: payload, error: null })
      const preferredId = payload.selectedPortfolioIds?.[0]
      if (preferredId && report.portfolios.some((portfolio) => portfolio.id === preferredId)) {
        setSelectedPortfolioId(preferredId)
      }
    } catch (error) {
      if (reportRef.current !== report || !stressEnabledRef.current) return
      setHermesReview({ loading: false, data: null, error })
    }
  }

  if (loading && !report.portfolios.length) {
    return <Box sx={{ py: 3, textAlign: 'center' }}><CircularProgress size={24} /></Box>
  }

  const hermesReviewById = new Map(
    (hermesReview.data?.reviews || []).map((review) => [review.portfolioId, review]),
  )
  const selectedHermesReview = selectedPortfolio ? hermesReviewById.get(selectedPortfolio.id) : null

  const adjustments = buildPortfolioAdjustments(baseline, selectedPortfolio)
  const customCount = Object.values(customReductions).filter(pct => pct > 0).length
  const planReduction = row => {
    const values = new Set(row.productIds.map(id => customReductions[id] || 0))
    return values.size === 1 ? [...values][0] : null
  }
  const togglePlan = (row) => {
    const remove = planReduction(row) === rankReduction
    setCustomReductions(current => ({ ...current, ...Object.fromEntries(row.productIds.map(id => [id, remove ? 0 : rankReduction])) }))
    setSelectedPortfolioId('custom')
  }
  const worstExitLevel = row => row.productIds
    .map(id => exitSignalById.get(id)?.level)
    .filter(Boolean)
    .sort((left, right) => exitLevelRank.indexOf(left) - exitLevelRank.indexOf(right))[0]
  // Value-weighted model return of the row's products after 30 flat days.
  const flatMonthPct = (row) => {
    const signals = row.productIds.map(id => exitSignalById.get(id)).filter(signal => signal?.decay?.return30dPct != null && signal.currentValue > 0)
    const value = signals.reduce((sum, signal) => sum + signal.currentValue, 0)
    return value > 0 ? signals.reduce((sum, signal) => sum + signal.currentValue * signal.decay.return30dPct, 0) / value : null
  }
  const changed = adjustments.filter(row => row.action !== 'retain')
  const selectedScenario = selectedPortfolio?.scenarioResults.find(scenario => scenario.id === scenarioId)
    || selectedPortfolio?.scenarioResults.reduce((worst, scenario) => !worst || scenario.pnl < worst.pnl ? scenario : worst, null)
  const contributions = buildScenarioContributions(selectedPortfolio, selectedScenario?.id)
  const losses = contributions.filter(row => row.pnl < 0)
  const offsets = contributions.filter(row => row.pnl > 0).reverse()
  const selectedProducts = selectedPortfolio?.products || []
  const repricedCount = selectedProducts.filter(product => product.scenarioMethods.some(row => /^bs/.test(row.method))).length
  const fxExposedCount = selectedProducts.filter(product => product.fxExposed).length
  const selectedGroupKeys = new Set(selectedProducts.map(product => product.groupKey))
  const groupMoves = groupShock.groups.filter(group => selectedGroupKeys.has(group.key))

  return (
    <Box sx={{ border: '1px solid #dfe6ee', borderRadius: 2, overflow: 'hidden', backgroundColor: '#fbfdff' }}>
      <Stack spacing={1.25} sx={{ p: { xs: 1.5, md: 2 } }}>
        <Box>
          <Typography variant="subtitle1" fontWeight={900}>投资组合对比</Typography>
          <Typography variant="body2" color="text.secondary">比较当前持仓与减仓、退出方案在压力情景下的取舍，并排出最值得先减的仓位；方案仅作参考，不构成交易指令。</Typography>
        </Box>
        <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
          <FormControlLabel control={<Switch checked={stressEnabled} onChange={event => {
            setStressEnabled(event.target.checked)
            setHermesReview({ loading: false, data: null, error: null })
          }} />} label="冲击测试" />
          {stressEnabled && <>
            <TextField select size="small" label="冲击范围" value={targetAvailable ? target : ''} onChange={event => setTarget(event.target.value)} sx={{ minWidth: 140 }}>
              <MenuItem value="">所有标的</MenuItem>
              {shockTargets.map(({ key, name }) => <MenuItem key={key} value={key}>{name}</MenuItem>)}
            </TextField>
            <TextField select size="small" label="最大冲击" value={shock} onChange={event => setShock(Number(event.target.value))}>
              {[10, 20, 30, 50].map(value => <MenuItem key={value} value={value}>±{value}%</MenuItem>)}
            </TextField>
            <TextField select size="small" label="各标的幅度" value={volScaled ? 'volatility' : 'uniform'} disabled={Boolean(target)} onChange={event => setShockMode(event.target.value)} sx={{ minWidth: 130 }}>
              <MenuItem value="uniform">相同幅度</MenuItem>
              <MenuItem value="volatility">按波动率缩放</MenuItem>
            </TextField>
            <TextField select size="small" label="隐含波动率" value={ivMove} onChange={event => setIvMove(Number(event.target.value))} sx={{ minWidth: 110 }}>
              {[0, -20, 20].map(value => <MenuItem key={value} value={value}>{value === 0 ? '不变' : `IV ${signedPercent(value)}`}</MenuItem>)}
            </TextField>
            <TextField select size="small" label="美元兑欧元" value={fxMove} onChange={event => setFxMove(Number(event.target.value))} sx={{ minWidth: 110 }}>
              {[0, -10, -5, 5, 10].map(value => <MenuItem key={value} value={value}>{value === 0 ? '不变' : `美元 ${signedPercent(value)}`}</MenuItem>)}
            </TextField>
            {PORTFOLIO_STRESS_HORIZONS.map(days => <Button key={days} size="small" variant={horizonDays === days ? 'contained' : 'outlined'} onClick={() => handleHorizonChange(days)}>
              {days === 0 ? '即时' : `${days} 天`}
            </Button>)}
          </>}
        </Stack>
        <Typography variant="caption" color="text.secondary">
          已覆盖 {report.coverage.coveragePct}% 持仓市值 · 未覆盖 {compactCurrency(report.coverage.outsideValue)} 的风险未计入 ·
          <Box component="a" href="#portfolio-data-details" onClick={() => {
            const details = document.getElementById('portfolio-data-details')
            if (details) details.open = true
          }} sx={{ color: 'primary.main', ml: 0.5 }}>数据与计算说明</Box>
        </Typography>
      </Stack>
      <Divider />
      <Stack spacing={2} sx={{ p: { xs: 1.25, md: 1.75 } }}>
        {!report.portfolios.length ? <Alert severity="warning">暂无可计算的组合，请展开数据说明查看缺失字段与全部持仓的直接报价压力。</Alert> : <>
          <TableContainer component={Paper} variant="outlined">
            <Table size="small" aria-label="投资组合对比" sx={{ '& th': { whiteSpace: 'nowrap' }, '& th:first-of-type, & td:first-of-type': { minWidth: 145, position: 'sticky', left: 0, zIndex: 1, backgroundColor: '#fff' }, '& tr.Mui-selected td:first-of-type': { backgroundColor: '#edf4fc' } }}>
              <TableHead><TableRow>
                <TableCell>组合</TableCell><TableCell align="right">持仓市值</TableCell><TableCell align="right">释放现金</TableCell>
                {stressEnabled && <><TableCell align="right">下跌 {shock}%{volScaled ? '（基准）' : ''} 盈亏</TableCell><TableCell align="right">上涨 {shock}%{volScaled ? '（基准）' : ''} 盈亏</TableCell><TableCell align="right">最差情景盈亏</TableCell><TableCell>相较当前基准</TableCell></>}
              </TableRow></TableHead>
              <TableBody>{report.portfolios.map(portfolio => {
                const noExposure = portfolio.shockProductCount === 0 && horizonDays === 0 && !ivMove && !fxMove
                const delta = comparePortfolioStress(baseline, portfolio)
                const down = portfolio.scenarioResults.find(row => row.id === 'shock_0')
                const up = portfolio.scenarioResults.find(row => row.id === 'shock_4')
                return <TableRow key={portfolio.id} selected={portfolio.id === resolvedPortfolioId} hover onClick={() => setSelectedPortfolioId(portfolio.id)} sx={{ cursor: 'pointer' }}>
                  <TableCell>
                    <Button size="small" aria-pressed={portfolio.id === resolvedPortfolioId} onClick={() => setSelectedPortfolioId(portfolio.id)} sx={{ fontWeight: 800, justifyContent: 'flex-start', p: 0 }}>{portfolio.kind === 'baseline' ? '当前持仓基准' : portfolio.title}</Button>
                    <Typography variant="caption" component="div" color="text.secondary">{portfolio.productCount} 产品 · {portfolio.groupCount} 标的</Typography>
                    {stressEnabled && <Typography variant="caption" component="div" color="text.secondary">{portfolio.shockProductCount === 0 ? '无直接敞口' : `冲击覆盖 ${portfolio.shockProductCount} 个产品`}</Typography>}
                  </TableCell>
                  <TableCell align="right">{compactCurrency(portfolio.currentValue)}</TableCell>
                  <TableCell align="right">{compactCurrency(portfolio.cashValue)}</TableCell>
                  {stressEnabled && <>
                    {noExposure ? <TableCell colSpan={3} align="center" sx={{ color: 'text.secondary' }}>无直接敞口 · 即时盈亏不变</TableCell> : <>
                      <PnlCell value={down?.pnl} />
                      <PnlCell value={up?.pnl} />
                      <PnlCell value={portfolio.worstPnl} />
                    </>}
                    <TableCell sx={{ minWidth: 170 }}>{portfolio.kind === 'baseline' ? '比较起点' : <>
                      <Typography variant="caption" component="div">最差盈亏改善 {signedMoney(delta.worstPnlImprovement)}</Typography>
                      <Typography variant="caption" component="div">上涨盈亏变化 {signedMoney(delta.upPnlDifference)}</Typography>
                    </>}</TableCell>
                  </>}
                </TableRow>
              })}</TableBody>
            </Table>
          </TableContainer>
          <Typography variant="caption" color="text.secondary">
            各方案使用相同测试本金 {compactCurrency(report.coverage.coveredValue)}：在当前持仓上按比例卖出，卖出所得留作零收益现金，不买入其他产品；未覆盖仓位保持不变。
            {stressEnabled ? '最差盈亏改善比较各方案各自的最差情景；上涨盈亏变化比较同一上涨情景。按退场信号生成的预设方案不随冲击设置变化；“最差情景亏损前几只减半”的名单随当前情景变化。' : '开启冲击测试可比较各方案的情景盈亏，并按保护效率排序。'}
            {stressEnabled && !target ? ' 最差情景包含“各标的逆向”：每个标的各自取对该组合最不利的终点涨跌，不同标的上的多空仓位不再互相抵消。' : ''}
          </Typography>
          {stressEnabled && (volScaled || ivMove !== 0 || fxMove !== 0) && <Typography variant="caption" color="text.secondary">
            {volScaled ? `按波动率缩放：±${shock}% 是 IV 处于中位数（${groupShock.referenceVolatilityPct ?? '—'}%）的标的的幅度，其余标的按自身 IV 在 0.4–2.5 倍内放大或缩小${groupShock.unknownCount ? `；${groupShock.unknownCount} 个标的没有权证 IV，按 ±${shock}% 计算` : ''}。` : ''}
            {ivMove !== 0 ? `IV ${signedPercent(ivMove)} 为相对变化，只影响所选组合中按 Black-Scholes 重估的 ${repricedCount} 只权证。` : ''}
            {fxMove !== 0 ? `美元 ${signedPercent(fxMove)} 只作用于所选组合中 ${fxExposedCount} 只美元标的产品（共 ${selectedProducts.length} 只）；是否美元按标的行情的报价币种判断，其他币种未计汇率影响。` : ''}
          </Typography>}
        </>}

        {stressEnabled && ranking.length > 0 && <Paper variant="outlined" sx={{ p: 1.5 }}>
          <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5} sx={{ justifyContent: 'space-between', alignItems: { md: 'center' } }}>
            <Box>
              <Typography variant="body2" fontWeight={800}>减仓效果排序</Typography>
              <Typography variant="caption" color="text.secondary">每行只动这一项、其余不变。保护效率越高，说明减它换来的最差情景改善相对放弃的上涨越多；价外权证上涨弹性大，效率通常低于 1，它们的代价是时间损耗，见“横盘 30 天”一列和退场信号。</Typography>
            </Box>
            <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
              <TextField select size="small" label="范围" value={rankScope} onChange={event => setRankScope(event.target.value)} sx={{ minWidth: 110 }}>
                <MenuItem value="product">按产品</MenuItem>
                <MenuItem value="group">按标的</MenuItem>
              </TextField>
              <TextField select size="small" label="幅度" value={rankReduction} onChange={event => setRankReduction(Number(event.target.value))} sx={{ minWidth: 100 }}>
                {REDUCTION_STEPS.map(pct => <MenuItem key={pct} value={pct}>{reductionLabel(pct)}</MenuItem>)}
              </TextField>
              <TextField select size="small" label="排序" value={rankSort} onChange={event => setRankSort(event.target.value)} sx={{ minWidth: 150 }}>
                <MenuItem value="efficiency">保护效率</MenuItem>
                <MenuItem value="improvement">最差情景改善金额</MenuItem>
                <MenuItem value="riskDensity">每欧元最差亏损</MenuItem>
              </TextField>
              <Button size="small" disabled={customCount === 0} onClick={() => setCustomReductions({})}>清空自定义方案</Button>
            </Stack>
          </Stack>
          <TableContainer sx={{ maxHeight: 420, mt: 1 }}>
            <Table size="small" stickyHeader aria-label="减仓效果排序" sx={{ minWidth: 1040, '& th': { whiteSpace: 'nowrap' } }}>
              <TableHead><TableRow>
                <TableCell>{rankScope === 'group' ? '标的' : '产品 / 标的'}</TableCell>
                <TableCell align="right">市值 / 占比</TableCell>
                <TableCell align="right">释放现金</TableCell>
                <TableCell align="right">最差情景改善</TableCell>
                <TableCell align="right">放弃上涨 {shock}%{volScaled ? '（基准）' : ''} 盈利</TableCell>
                <TableCell align="right">保护效率</TableCell>
                <TableCell align="right">每欧元最差亏损</TableCell>
                <TableCell align="right">横盘 30 天</TableCell>
                <TableCell align="right">自定义方案</TableCell>
              </TableRow></TableHead>
              <TableBody>{ranking.map((row) => {
                const level = worstExitLevel(row)
                const inPlan = planReduction(row)
                const flatMonth = flatMonthPct(row)
                return <TableRow key={row.id} hover>
                  <TableCell sx={{ maxWidth: 260 }}>
                    <Typography variant="body2" fontWeight={700} noWrap title={row.name}>{row.name}</Typography>
                    <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
                      <Typography variant="caption" color="text.secondary" noWrap>{rankScope === 'group' ? `${row.productCount} 个产品` : row.groupName}</Typography>
                      {exitLevelMeta[level] && <Chip size="small" color={exitLevelMeta[level].color} label={`退场信号：${exitLevelMeta[level].label}`} sx={{ height: 18 }} />}
                    </Stack>
                  </TableCell>
                  <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>{compactCurrency(row.currentValue)}<Typography variant="caption" component="div" color="text.secondary">{number.format(row.weightPct)}%</Typography></TableCell>
                  <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>{compactCurrency(row.releasedValue)}</TableCell>
                  <PnlCell value={row.worstImprovement} />
                  <PnlCell value={-row.upGivenUp} />
                  <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>
                    {row.kind === 'tradeoff' ? <Typography variant="body2" fontWeight={700} color={row.efficiency >= 1 ? 'success.main' : 'text.primary'}>{number.format(row.efficiency)}</Typography>
                      : <Typography variant="caption" color="text.secondary">{row.kind === 'free' ? '无上涨代价' : row.kind === 'hedge' ? '对冲仓位，减仓会加大最差亏损' : '对最差情景无影响'}</Typography>}
                  </TableCell>
                  <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>{number.format(row.worstLossPct)}%</TableCell>
                  <TableCell align="right" sx={{ whiteSpace: 'nowrap', color: flatMonth != null && flatMonth <= -15 ? 'error.main' : undefined }}>{flatMonth == null ? '—' : signedPercent(Math.round(flatMonth * 10) / 10)}</TableCell>
                  <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>
                    {inPlan > 0 && inPlan !== rankReduction && <Typography variant="caption" component="div" color="text.secondary">方案中：{reductionLabel(inPlan)}</Typography>}
                    {inPlan === null && <Typography variant="caption" component="div" color="text.secondary">方案中：部分产品</Typography>}
                    <Button size="small" variant={inPlan === rankReduction ? 'contained' : 'outlined'} onClick={() => togglePlan(row)}>
                      {inPlan === rankReduction ? `已选 ${reductionLabel(rankReduction)}` : reductionLabel(rankReduction)}
                    </Button>
                  </TableCell>
                </TableRow>
              })}</TableBody>
            </Table>
          </TableContainer>
        </Paper>}

        {selectedPortfolio && <>
          <Box>
            <Typography variant="subtitle2" fontWeight={900}>{selectedPortfolio.title} · 持仓调整参考</Typography>
            <Typography variant="caption" color="text.secondary">{selectedPortfolio.description}</Typography>
          </Box>
          <Paper variant="outlined" sx={{ p: 1.5 }}>
            <Typography variant="body2" fontWeight={800}>调整差异</Typography>
            <Typography variant="body2" sx={{ mt: 0.5, mb: 1 }}>
              保留 {adjustments.filter(row => row.action === 'retain').length} 个 · 加仓 {adjustments.filter(row => row.action === 'increase').length} 个 · 减仓 {adjustments.filter(row => row.action === 'reduce').length} 个 · 模拟退出 {adjustments.filter(row => row.action === 'exit').length} 个；
              释放现金 {compactCurrency(selectedPortfolio.cashValue)}。
            </Typography>
            <Typography variant="caption" color="text.secondary">权重统一以当前可测试本金为分母，包含假设现金；以下是模型差异，未生成交易指令。</Typography>
            {changed.length ? <TableContainer sx={{ maxHeight: 320 }}><Table size="small" stickyHeader aria-label="调整差异" sx={{ minWidth: 540, '& th': { whiteSpace: 'nowrap' } }}>
              <TableHead><TableRow><TableCell>产品 / 标的</TableCell><TableCell>方案变化</TableCell><TableCell align="right">当前 → 候选权重</TableCell><TableCell align="right">金额变化</TableCell></TableRow></TableHead>
              <TableBody>{changed.map(row => <TableRow key={row.id}>
                <TableCell>{row.name}<Typography variant="caption" component="div" color="text.secondary">{row.groupName}</Typography></TableCell>
                <TableCell>{adjustmentLabels[row.action]}</TableCell>
                <TableCell align="right">{number.format(row.beforeWeight)}% → {number.format(row.afterWeight)}%</TableCell>
                <TableCell align="right">{signedMoney(row.changeValue)}</TableCell>
              </TableRow>)}</TableBody>
            </Table></TableContainer> : <Typography variant="body2" sx={{ mt: 1 }}>与当前可测试持仓一致，无调整差异。</Typography>}
          </Paper>

          {stressEnabled && <Paper variant="outlined" sx={{ p: 1.5 }}>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} sx={{ justifyContent: 'space-between', alignItems: { sm: 'center' } }}>
              <Box><Typography variant="body2" fontWeight={800}>压力来源</Typography><Typography variant="caption" color="text.secondary">默认查看所选组合的最差情景，可切换其他情景。</Typography></Box>
              <TextField select size="small" label="查看情景" value={selectedScenario?.id || ''} onChange={event => setScenarioId(event.target.value)} sx={{ minWidth: 180 }}>
                {selectedPortfolio.scenarioResults.map(row => <MenuItem key={row.id} value={row.id}>{row.label}</MenuItem>)}
              </TextField>
            </Stack>
            {selectedPortfolio.shockProductCount === 0 && <Alert severity="info" sx={{ mt: 1 }}>
              无所选标的直接敞口；模型未模拟其他标的的相关性传导。
              {horizonDays === 0 ? (ivMove || fxMove ? '即时盈亏只来自所选的 IV 与汇率冲击。' : '即时盈亏不变，组合市值并未归零。') : '当前期限仍计入时间损耗或到期支付影响。'}
            </Alert>}
            <Typography variant="body2" sx={{ my: 1 }}>
              情景盈亏 <Box component="span" sx={{ color: pnlColor(selectedScenario?.pnl), fontWeight: 800 }}>{signedMoney(selectedScenario?.pnl)}</Box> ·
              情景后保留市值 {compactCurrency(selectedScenario?.projectedValue)} · 假设现金 {compactCurrency(selectedPortfolio.cashValue)}
            </Typography>
            <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, gap: 2 }}>
              <ContributionList title="主要亏损来源" rows={losses} empty="该情景没有亏损产品" />
              <ContributionList title="收益抵消来源" rows={offsets} empty="该情景没有盈利产品" />
            </Box>
            {volScaled && groupMoves.length > 0 && <Box component="details" sx={{ mt: 1.5 }}>
              <Typography component="summary" variant="body2" sx={{ cursor: 'pointer' }}>各标的冲击幅度（{groupMoves.length} 个标的）</Typography>
              <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 0.5 }}>
                {groupMoves.map(group => `${group.name} ±${number.format(shock * group.scale)}%（${group.volatilityPct == null ? '无 IV' : `IV ${number.format(group.volatilityPct)}%`}）`).join(' · ')}
              </Typography>
            </Box>}
            <Box component="details" sx={{ mt: 1.5 }}>
              <Typography component="summary" variant="body2" sx={{ cursor: 'pointer' }}>完整情景结果</Typography>
              <TableContainer><Table size="small" aria-label="完整情景结果" sx={{ minWidth: 540 }}>
                <TableHead><TableRow><TableCell>情景</TableCell><TableCell align="right">保留市值</TableCell><TableCell align="right">盈亏变化</TableCell><TableCell align="right">统一本金回报</TableCell><TableCell align="right">障碍触发</TableCell></TableRow></TableHead>
                <TableBody>{selectedPortfolio.scenarioResults.map(row => <TableRow key={row.id}>
                  <TableCell>{row.label}</TableCell><TableCell align="right">{compactCurrency(row.projectedValue)}</TableCell><PnlCell value={row.pnl} /><TableCell align="right">{signedPercent(row.testedCapitalReturnPct)}</TableCell><TableCell align="right">{row.barrierBreaches || '—'}</TableCell>
                </TableRow>)}</TableBody>
              </Table></TableContainer>
            </Box>
          </Paper>}
          <Box component="details">
            <Typography component="summary" variant="body2" sx={{ cursor: 'pointer', mb: 1 }}>完整组合成员与权重（{selectedPortfolio.productCount} 个产品）</Typography>
            <Paper variant="outlined" sx={{ borderRadius: 2, overflow: 'hidden' }}>
              <Box sx={{ px: 1.5, py: 1, backgroundColor: '#f8fafc' }}>
                <Typography variant="body2" fontWeight={900}>组合产品与权重</Typography>
                <Typography variant="caption" color="text.secondary">
                  {selectedPortfolio.kind === 'baseline'
                    ? '当前基准沿用实际持仓数量。'
                    : '方案沿用当前持仓并按所列比例减仓，已退出的产品不再列出；只用于情景建模，未生成交易数量。'}
                </Typography>
              </Box>
              <TableContainer sx={{ maxHeight: 360 }}>
                <Table size="small" stickyHeader>
                  <TableHead>
                    <TableRow>
                      <TableCell>产品</TableCell>
                      <TableCell>标的</TableCell>
                      <TableCell>风险处理 / 置信度</TableCell>
                      <TableCell align="right">组合 / 持仓市值 / 本金</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {selectedPortfolio.products.map((product) => (
                      <TableRow key={product.id}>
                        <TableCell sx={{ maxWidth: 240 }}>
                          <Typography variant="body2" fontWeight={700} noWrap>{product.name}</Typography>
                          <Typography variant="caption" color="text.secondary">{productTypeLabels[product.productType] || product.productType}</Typography>
                        </TableCell>
                        <TableCell><Typography variant="body2" noWrap>{product.groupName}</Typography></TableCell>
                        <TableCell>
                          <Stack direction="row" spacing={0.5} useFlexGap sx={{ flexWrap: 'wrap' }}>
                            <Chip size="small" variant="outlined" label={confidenceLabels[product.confidence] || product.confidence} sx={{ height: 19 }} />
                            {(product.selectionFlags || []).map((flag) => (
                              <Chip
                                key={flag}
                                size="small"
                                color={flag === 'ELASTIC_ONLY' ? 'warning' : 'default'}
                                variant="outlined"
                                label={selectionFlagLabels[flag] || flag}
                                sx={{ height: 19 }}
                              />
                            ))}
                          </Stack>
                        </TableCell>
                        <TableCell align="right">
                          <Typography variant="body2">组合内 {number.format(product.allocationPct)}%</Typography>
                          <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                            持仓市值 {number.format(product.navWeightPct)}% · 本金 {number.format(product.capitalWeightPct)}%
                          </Typography>
                          {product.positionScalePct !== 100 ? (
                            <Typography variant="caption" color={product.positionScalePct < 100 ? 'warning.main' : 'info.main'}>按原仓位的 {number.format(product.positionScalePct)}% 配置</Typography>
                          ) : null}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            </Paper>
          </Box>
        </>}

        {stressEnabled && <Box>
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
            <Button size="small" variant="outlined" startIcon={hermesReview.loading ? <CircularProgress size={14} /> : <AutoAwesomeRoundedIcon />}
              disabled={!hermesStatus.available || hermesReview.loading || report.portfolios.length < 2 || Boolean(target)} onClick={requestHermesReview}>
              {hermesReview.loading ? '正在解释…' : 'Hermes 解释组合取舍'}
            </Button>
            <Typography variant="caption" color="text.secondary">{target ? '单标的情景暂不支持 Hermes' : hermesStatus.loading ? '检查 Hermes…' : hermesStatus.available ? hermesStatus.model || '已就绪' : '本地计算可用'}</Typography>
          </Stack>
          {hermesReview.error && <Alert severity="info" sx={{ mt: 1 }}>{hermesReview.error.message}</Alert>}
          {hermesReview.data?.summary && <Alert severity="info" sx={{ mt: 1 }}>{hermesReview.data.summary}</Alert>}
          {selectedHermesReview && <Typography variant="body2" sx={{ mt: 1 }}>{selectedHermesReview.verdict}：{selectedHermesReview.reason}{selectedHermesReview.risks?.length ? `；风险：${selectedHermesReview.risks.join('；')}` : ''}</Typography>}
        </Box>}
        <Box component="details" id="portfolio-data-details">
          <Typography component="summary" variant="body2" sx={{ cursor: 'pointer', mb: 1 }}>数据与计算说明</Typography>
        <PortfolioDataMonitor />
        <Alert severity="info" sx={{ mb: 1.5 }}>
          标的情景覆盖 {compactCurrency(report.coverage.coveredValue)}（测试估值口径 {report.coverage.coveragePct}%）；
          测试总市值 {compactCurrency(report.coverage.accountValue)} 中未覆盖部分 {compactCurrency(report.coverage.outsideValue)}，不视为零风险。
          输入中 {report.coverage.omittedCount} 个产品缺少计算字段，估值 {compactCurrency(report.coverage.omittedValue)}。
          测试仓位统一按所用报价 × 数量估值；其他仓位沿用汇总报价，债券保留汇总市值。不同来源可能仍有时间差。
          {report.coverage.omitted.map(row => <Typography key={row.name} variant="caption" component="div">{row.name}：{row.reason}</Typography>)}
        </Alert>
        <Typography variant="body2" sx={{ mb: 1.5 }}>
          全部持仓的报价直接压力（不依赖标的 / Greeks）：
          {direct.map(row => ` 产品价格 ${row.movePct}% → ${compactCurrency(row.pnl)}`).join('；')}。
          使用相同测试估值口径，不等于标的同幅下跌，也不是可成交报价。
        </Typography>
        {!report.portfolios.length && <Alert severity="warning">暂无可计算的 Tier 1 标的情景；可查看此处直接报价压力。</Alert>}
        <Typography variant="caption" component="div" sx={{ mb: 1.5 }}>
          产品市场时间（缺失表示无法验证新鲜度）：
          {quoteWindow(entries, 'priceAsOf')}。
          产品抓取 / 导入时间：{quoteWindow(entries, 'priceFetchedAt')}。
          标的时间：{quoteWindow(entries, 'underlyingPriceAsOf')}。
          单标的情景暂不发送 Hermes；新情景以本地计算为准。
        </Typography>
        {report.rollOpportunities?.length ? (
          <Alert severity="warning" sx={{ mb: 1.5, py: 0 }}>
            {report.rollOpportunities.length} 个持仓将在 7 天内到期或已标记为 ROLL：{report.rollOpportunities.map(row => row.name).join('、')}。方案只模拟卖出，不模拟换入远期合约。
          </Alert>
        ) : null}
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1.25 }}>
          对比方案都是在当前持仓上减仓或退出，卖出所得记为零收益现金，忽略交易费用、买卖价差和税；账户影响仅计已测部分的损益。冲击测试只衡量既定持仓的影响，不代表预期收益或盈利概率。保护效率 = 最差情景亏损的减少额 ÷ 最大上涨情景盈利的减少额，等于 1 表示少亏和少赚一样多；它只反映所选情景下的取舍，不含概率，仓位大小按线性缩放。即时冲击不含时间损耗，期权的凸性会让价外权证显得划算，把期限改为 30 天可以把持有成本算进去。在同步下跌情景中盈利的仓位标为对冲仓位，不参与效率排序。每欧元最差亏损 = 最差情景改善 ÷ 释放现金。到期晚于测试期限的权证用 Black-Scholes 完整重估：波动率由当前报价反推，再按情景后的标的价格、剩余期限和 IV 变化重新定价，已包含时间价值损耗；报价无法反推，或反推结果与提供方 IV 相差一倍以上（多见于深度价内、报价与标的不同步）时改用提供方 IV，两者都缺才退回 Delta / Omega 线性近似。重估假设欧式行权、无股息、情景前后波动率不随标的涨跌自动变化。按波动率缩放用各标的权证 IV 的中位数相对全部标的中位数的比值调整幅度。“各标的逆向”情景让每个标的各自取对该组合最不利的终点涨跌，是不考虑相关性的上限估计。汇率冲击只作用于美元标的产品，按到期支付以新汇率折算处理。Turbo 按假设融资利率（美元 4%、欧元 2% 参考利率 ± 3% 利差）逐日调整融资水平，开放式敲出价随之移动；Factor 计入融资、1% 年费和波动损耗，波动率优先取同标的权证 IV，缺失按 50%。两步路径是假设连续两个重置周期发生冲击、随后持平，只有 Factor 和敲出检查使用中间路径；权证仍按终点近似。敲出按保守零回收处理，未模拟具体残值、日内重置、发行人实际融资条款、发行人信用、买卖价差，以及美元以外的汇率变化。长期五档终点情景仍是假设末期单次冲击。
        </Typography>
        </Box>
      </Stack>
    </Box>
  )
}

function signedMoney(value) {
  if (value == null) return '—'
  return `${value > 0 ? '+' : ''}${compactCurrency(value)}`
}

function PnlCell({ value }) {
  return <TableCell align="right" sx={{ color: pnlColor(value), whiteSpace: 'nowrap' }}>{signedMoney(value)}</TableCell>
}

function ContributionList({ title, rows, empty }) {
  return <Box>
    <Typography variant="body2" fontWeight={700}>{title}</Typography>
    {rows.length === 0 ? <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>{empty}</Typography> : <>
      <Typography variant="caption" color="text.secondary">合计 {signedMoney(rows.reduce((sum, row) => sum + row.pnl, 0))} · 展示前 {Math.min(5, rows.length)} 个</Typography>
      <TableContainer><Table size="small" aria-label={title}><TableBody>{rows.slice(0, 5).map(row => <TableRow key={row.id}><TableCell>{row.name}<Typography variant="caption" component="div" color="text.secondary">{row.groupName}{row.movePct ? ` · 标的 ${signedPercent(row.movePct)}` : ''}</Typography></TableCell><PnlCell value={row.pnl} /></TableRow>)}</TableBody></Table></TableContainer>
    </>}
  </Box>
}
