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

import { compactCurrency, number } from '../utils/formatters.js'
import {
  PORTFOLIO_STRESS_HORIZONS,
  buildHermesStressReviewPayload,
  buildPortfolioStressReport,
  buildStressScenarios,
  buildDirectPriceStress,
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

export default function PortfolioStressTestPanel({ entries, positions = [], loading, totalMarketValue, totalCostBasis }) {
  const [scenarioId, setScenarioId] = useState(null)
  const [stressEnabled, setStressEnabled] = useState(false)
  const [horizonDays, setHorizonDays] = useState(0)
  const [shock, setShock] = useState(20)
  const [target, setTarget] = useState('')
  const scenarios = useMemo(() => buildStressScenarios(shock, target || null, horizonDays > 0), [shock, target, horizonDays])
  const direct = buildDirectPriceStress(positions, entries)
  const [selectedPortfolioId, setSelectedPortfolioId] = useState(null)
  const [hermesStatus, setHermesStatus] = useState({ loading: true, available: null, model: null })
  const [hermesReview, setHermesReview] = useState({ loading: false, data: null, error: null })
  const report = useMemo(
    () => buildPortfolioStressReport(entries, horizonDays, scenarios, { totalMarketValue, totalCostBasis, positions }),
    [entries, horizonDays, scenarios, totalMarketValue, totalCostBasis, positions],
  )
  const stressEnabledRef = useRef(stressEnabled)
  stressEnabledRef.current = stressEnabled
  const reportRef = useRef(report)
  reportRef.current = report

  useEffect(() => {
    setHermesReview({ loading: false, data: null, error: null })
  }, [report])

  const defaultPortfolioId = report.portfolios.find((portfolio) => portfolio.kind === 'balanced')?.id
    || report.portfolios[0]?.id
    || null
  const resolvedPortfolioId = report.portfolios.some((portfolio) => portfolio.id === selectedPortfolioId)
    ? selectedPortfolioId
    : defaultPortfolioId
  const selectedPortfolio = report.portfolios.find((portfolio) => portfolio.id === resolvedPortfolioId) || null
  // Membership does not depend on the shock settings, so the targets are stable
  // while the target itself changes.
  const shockTargets = useMemo(() => buildShockTargets(selectedPortfolio), [selectedPortfolio])
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

  const baseline = report.portfolios.find(portfolio => portfolio.kind === 'baseline')
  const adjustments = buildPortfolioAdjustments(baseline, selectedPortfolio)
  const changed = adjustments.filter(row => row.action !== 'retain')
  const selectedScenario = selectedPortfolio?.scenarioResults.find(scenario => scenario.id === scenarioId)
    || selectedPortfolio?.scenarioResults.reduce((worst, scenario) => !worst || scenario.pnl < worst.pnl ? scenario : worst, null)
  const contributions = buildScenarioContributions(selectedPortfolio, selectedScenario?.id)
  const losses = contributions.filter(row => row.pnl < 0)
  const offsets = contributions.filter(row => row.pnl > 0).reverse()

  return (
    <Box sx={{ border: '1px solid #dfe6ee', borderRadius: 2, overflow: 'hidden', backgroundColor: '#fbfdff' }}>
      <Stack spacing={1.25} sx={{ p: { xs: 1.5, md: 2 } }}>
        <Box>
          <Typography variant="subtitle1" fontWeight={900}>投资组合对比</Typography>
          <Typography variant="body2" color="text.secondary">比较当前持仓与按策略重新分配同等本金的候选方案，查看压力下的取舍；候选方案仅作参考，不构成交易指令。</Typography>
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
                <TableCell>组合</TableCell><TableCell align="right">持仓市值</TableCell><TableCell align="right">剩余现金</TableCell>
                {stressEnabled && <><TableCell align="right">下跌 {shock}% 盈亏</TableCell><TableCell align="right">上涨 {shock}% 盈亏</TableCell><TableCell align="right">最差情景盈亏</TableCell><TableCell>相较当前基准</TableCell></>}
              </TableRow></TableHead>
              <TableBody>{report.portfolios.map(portfolio => {
                const noExposure = portfolio.shockProductCount === 0 && horizonDays === 0
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
            各方案使用相同测试本金 {compactCurrency(report.coverage.coveredValue)}：候选方案把本金等权分配给选中产品，单只敞口不超过净值 8%，WATCH、卖出信号或敞口未知的产品不加仓，分不完的部分留作零收益现金；未覆盖仓位保持不变。
            {stressEnabled ? '最差盈亏改善比较各方案各自的最差情景；上涨盈亏变化比较同一上涨情景。切换测试参数不会重新选股；单标的冲击只能选择当前所选组合中的标的，切换到不含该标的的组合时恢复为所有标的。' : '开启冲击测试可比较调整后的情景盈亏。'}
          </Typography>
        </>}

        {selectedPortfolio && <>
          <Box>
            <Typography variant="subtitle2" fontWeight={900}>{selectedPortfolio.title} · 持仓调整参考</Typography>
            <Typography variant="caption" color="text.secondary">{selectedPortfolio.description}</Typography>
          </Box>
          <Paper variant="outlined" sx={{ p: 1.5 }}>
            <Typography variant="body2" fontWeight={800}>调整差异</Typography>
            <Typography variant="body2" sx={{ mt: 0.5, mb: 1 }}>
              保留 {adjustments.filter(row => row.action === 'retain').length} 个 · 加仓 {adjustments.filter(row => row.action === 'increase').length} 个 · 减仓 {adjustments.filter(row => row.action === 'reduce').length} 个 · 模拟退出 {adjustments.filter(row => row.action === 'exit').length} 个；
              剩余现金 {compactCurrency(selectedPortfolio.cashValue)}。
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
              {horizonDays === 0 ? '即时盈亏不变，组合市值并未归零。' : '当前期限仍计入时间损耗或到期支付影响。'}
            </Alert>}
            <Typography variant="body2" sx={{ my: 1 }}>
              情景盈亏 <Box component="span" sx={{ color: pnlColor(selectedScenario?.pnl), fontWeight: 800 }}>{signedMoney(selectedScenario?.pnl)}</Box> ·
              情景后保留市值 {compactCurrency(selectedScenario?.projectedValue)} · 假设现金 {compactCurrency(selectedPortfolio.cashValue)}
            </Typography>
            <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, gap: 2 }}>
              <ContributionList title="主要亏损来源" rows={losses} empty="该情景没有亏损产品" />
              <ContributionList title="收益抵消来源" rows={offsets} empty="该情景没有盈利产品" />
            </Box>
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
                    : '候选组合对超过持仓市值 8% 的单品风险敞口按比例缩放；只用于情景建模，未生成交易数量。'}
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
        {report.excludedProductCount > 0
          || report.watchIncludedProductCount > 0
          || report.exposureCappedProductCount > 0 ? (
          <Alert severity="warning" sx={{ mb: 1.5, py: 0 }}>
            风险分层：{report.excludedProductCount} 个旧合约或数据不可信产品不进入候选；
            {report.watchIncludedProductCount} 个 WATCH 按触发原因降权，临近障碍的产品仅可进入高弹性组合；
            {report.exposureCappedProductCount} 个集中仓位按持仓市值 8% 的风险敞口比例缩放。
            {report.rollOpportunities?.length
              ? ` ${report.rollOpportunities.length} 个 ROLL 旧合约已登记为换仓机会，需要同标的远期产品数据才能建立替代仓。`
              : ''}
          </Alert>
        ) : null}
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1.25 }}>
          组合按固定的 30 天、全标的 ±10% 参考情景和风险规则筛选；数据更新时重新生成。冲击测试只衡量既定组合的影响，不代表预期收益或盈利概率。计算口径：候选把相同测试本金等权分配给选中产品，分不完的部分留作零收益现金，忽略交易费用；账户影响仅计已测部分的损益。权证使用局部敏感度和时间损耗近似，30/90 天误差可能很大。Turbo 按假设融资利率（美元 4%、欧元 2% 参考利率 ± 3% 利差）逐日调整融资水平，开放式敲出价随之移动；Factor 计入融资、1% 年费和波动损耗，波动率优先取同标的权证 IV，缺失按 50%。两步路径是假设连续两个重置周期发生冲击、随后持平，只有 Factor 和敲出检查使用中间路径；权证仍按终点近似。敲出按保守零回收处理，未模拟具体残值、日内重置、发行人实际融资条款、发行人信用、买卖价差及汇率变化。长期五档终点情景仍是假设末期单次冲击。
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
      <TableContainer><Table size="small" aria-label={title}><TableBody>{rows.slice(0, 5).map(row => <TableRow key={row.id}><TableCell>{row.name}<Typography variant="caption" component="div" color="text.secondary">{row.groupName}</Typography></TableCell><PnlCell value={row.pnl} /></TableRow>)}</TableBody></Table></TableContainer>
    </>}
  </Box>
}
