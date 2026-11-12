import { useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Box, CircularProgress, Divider, Stack, Typography } from '@mui/material'
import { buildShockTargets, rowReduction, withRowReduction } from '../utils/portfolioComparison.js'
import { buildCustomPlan, buildPresetPlans, rankReductions } from '../utils/positionWhatIf.js'
import { number } from '../utils/formatters.js'
import {
  buildHermesStressReviewPayload,
  buildPortfolioStressReport,
  buildStressScenarios,
  buildDirectPriceStress,
  buildGroupShockScales,
} from '../utils/portfolioStress.js'
import StressScenarioBar from './stress/StressScenarioBar.jsx'
import { PlanComparisonTable, PlanSummaryTiles } from './stress/PlanComparison.jsx'
import TradeoffChart from './stress/TradeoffChart.jsx'
import { CustomPlanTray, ReductionRankingTable } from './stress/ReductionRanking.jsx'
import { PlanAdjustments, PlanMembers, PressureSources } from './stress/PlanDetails.jsx'
import { StressDataNotes, StressMethodology } from './stress/StressMethodology.jsx'
import HermesReview from './stress/HermesReview.jsx'
import { Section } from './stress/shared.jsx'

const DEFAULT_SETTINGS = { shock: 20, horizonDays: 30, target: '', shockMode: 'uniform', ivMove: 0, fxMove: 0 }
const EMPTY_REVIEW = { loading: false, data: null, error: null, at: null, report: null }
const exitLevelRank = ['urgent', 'warn', 'ok', 'unknown']

export default function PortfolioStressTestPanel({ entries, positions = [], exitSignals, loading, totalMarketValue, totalCostBasis }) {
  const [settings, setSettings] = useState(DEFAULT_SETTINGS)
  const [rankSettings, setRankSettings] = useState({ scope: 'product', reduction: 50, sort: 'efficiency' })
  const [customReductions, setCustomReductions] = useState({})
  const [selectedPortfolioId, setSelectedPortfolioId] = useState(null)
  const [scenarioId, setScenarioId] = useState(null)
  const [hermesStatus, setHermesStatus] = useState({ loading: true, available: null, model: null })
  const [hermesReview, setHermesReview] = useState(EMPTY_REVIEW)
  const { shock, horizonDays, target, shockMode, ivMove, fxMove } = settings

  const groupShock = useMemo(() => buildGroupShockScales(entries), [entries])
  const volScaled = shockMode === 'volatility' && !target
  const scenarios = useMemo(() => buildStressScenarios(shock, target || null, horizonDays > 0, {
    groupScales: volScaled ? groupShock.scales : null,
    ivMovePct: ivMove,
    fxMovePct: fxMove,
    adverse: true,
  }), [shock, target, horizonDays, volScaled, groupShock, ivMove, fxMove])
  const direct = useMemo(() => buildDirectPriceStress(positions, entries), [positions, entries])
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

  // A Hermes review stays valid while the question is the same: the scenario
  // settings and the set of plans. Background price refreshes only mark it as
  // based on older data instead of discarding it.
  const reviewKey = JSON.stringify([settings, plans.map(plan => plan.id), customReductions])
  const reviewKeyRef = useRef(reviewKey)
  reviewKeyRef.current = reviewKey
  useEffect(() => {
    setHermesReview(EMPTY_REVIEW)
  }, [reviewKey])

  const baseline = report.portfolios.find(portfolio => portfolio.kind === 'baseline')
  const defaultPortfolioId = report.portfolios.find(portfolio => portfolio.id === 'custom')?.id
    || report.portfolios[1]?.id
    || report.portfolios[0]?.id
    || null
  const resolvedPortfolioId = report.portfolios.some(portfolio => portfolio.id === selectedPortfolioId) ? selectedPortfolioId : defaultPortfolioId
  const selectedPortfolio = report.portfolios.find(portfolio => portfolio.id === resolvedPortfolioId) || null
  const customPortfolio = report.portfolios.find(portfolio => portfolio.id === 'custom') || null
  // Every held underlying can be shocked, whichever plan is selected.
  const shockTargets = useMemo(() => buildShockTargets(baseline), [baseline])
  const ranking = useMemo(
    () => rankReductions(baseline, { reductionPct: rankSettings.reduction, scope: rankSettings.scope, sortBy: rankSettings.sort }),
    [baseline, rankSettings],
  )
  const exitSignalById = useMemo(() => new Map((exitSignals || []).map(signal => [signal.id, signal])), [exitSignals])
  const targetAvailable = shockTargets.some(({ key }) => key === target)

  useEffect(() => {
    if (target && !targetAvailable) setSettings(current => ({ ...current, target: '' }))
  }, [target, targetAvailable])

  useEffect(() => {
    const controller = new AbortController()
    fetch('/api/portfolio-stress/hermes-review', { cache: 'no-store', signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`Hermes 状态请求失败: ${response.status}`)
        return response.json()
      })
      .then(payload => setHermesStatus({ loading: false, available: Boolean(payload?.available), model: payload?.model || null }))
      .catch((error) => {
        if (error.name === 'AbortError') return
        setHermesStatus({ loading: false, available: false, model: null })
      })
    return () => controller.abort()
  }, [])

  const requestHermesReview = async () => {
    const key = reviewKey
    const requestedReport = report
    setHermesReview({ ...EMPTY_REVIEW, loading: true })
    try {
      const response = await fetch('/api/portfolio-stress/hermes-review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildHermesStressReviewPayload(requestedReport)),
      })
      const payload = await response.json().catch(() => ({}))
      if (reviewKeyRef.current !== key) return
      if (!response.ok) throw new Error(payload?.error || `Hermes 请求失败: ${response.status}`)
      if (!payload?.available) {
        setHermesStatus(current => ({ ...current, loading: false, available: false }))
        throw new Error(payload?.unavailableReason || '当前环境未安装 Hermes')
      }
      setHermesReview({ loading: false, data: payload, error: null, at: Date.now(), report: requestedReport })
      const preferredId = payload.selectedPortfolioIds?.[0]
      if (preferredId && requestedReport.portfolios.some(portfolio => portfolio.id === preferredId)) setSelectedPortfolioId(preferredId)
    } catch (error) {
      if (reviewKeyRef.current !== key) return
      setHermesReview({ ...EMPTY_REVIEW, error })
    }
  }

  if (loading && !report.portfolios.length) {
    return <Box sx={{ py: 3, textAlign: 'center' }}><CircularProgress size={24} /></Box>
  }

  const updateSettings = patch => setSettings(current => ({ ...current, ...patch }))
  const setRowReduction = (row, pct) => {
    setCustomReductions(current => withRowReduction(current, row.productIds, pct))
    setSelectedPortfolioId('custom')
  }
  const toggleRow = row => setRowReduction(row, rowReduction(customReductions, row.productIds) !== 0 ? 0 : rankSettings.reduction)
  const clearCustom = () => setCustomReductions({})
  const customCount = Object.values(customReductions).filter(pct => pct > 0).length
  const exitLevelOf = row => row.productIds
    .map(id => exitSignalById.get(id)?.level)
    .filter(Boolean)
    .sort((left, right) => exitLevelRank.indexOf(left) - exitLevelRank.indexOf(right))[0]
  // Value-weighted model return of the row's products after 30 flat days.
  const flatMonthOf = (row) => {
    const signals = row.productIds.map(id => exitSignalById.get(id)).filter(signal => signal?.decay?.return30dPct != null && signal.currentValue > 0)
    const value = signals.reduce((sum, signal) => sum + signal.currentValue, 0)
    return value > 0 ? signals.reduce((sum, signal) => sum + signal.currentValue * signal.decay.return30dPct, 0) / value : null
  }
  const best = ranking.find(row => row.kind === 'free' || row.kind === 'tradeoff')
  const instantWithoutMoves = horizonDays === 0 && !ivMove && !fxMove
  const hermesDisabledReason = target ? '只冲击单个标的时暂不支持 Hermes' : report.portfolios.length < 2 ? '至少需要两个方案才能比较' : null
  const review = { ...hermesReview, stale: Boolean(hermesReview.data && hermesReview.report !== report) }

  return (
    <Box sx={{ border: '1px solid #dfe6ee', borderRadius: 2, backgroundColor: '#fbfdff' }}>
      <Stack spacing={1.25} sx={{ p: { xs: 1.5, md: 2 } }}>
        <Box>
          <Typography variant="subtitle1" fontWeight={900}>方案对比</Typography>
          <Typography variant="body2" color="text.secondary">比较当前持仓与减仓、退出方案在压力情景下的取舍。方案只是模型，不构成交易指令。</Typography>
        </Box>
        <StressScenarioBar
          settings={{ ...settings, target: targetAvailable ? target : '' }}
          onChange={updateSettings}
          shockTargets={shockTargets}
          groupShock={groupShock}
          coverage={report.coverage}
          selectedProducts={selectedPortfolio?.products || []}
        />
      </Stack>
      <Divider />
      <Stack spacing={1.5} sx={{ p: { xs: 1.25, md: 1.75 } }}>
        {!report.portfolios.length ? (
          <Alert severity="warning">暂无可计算的组合，请展开“数据说明”查看缺失字段与全部持仓的直接报价压力。</Alert>
        ) : <>
          <Box>
            <Typography variant="body2" fontWeight={800} sx={{ mb: 0.75 }}>
              {selectedPortfolio?.kind === 'baseline' ? '当前持仓' : selectedPortfolio?.title}
              <Typography component="span" variant="caption" color="text.secondary" sx={{ ml: 1 }}>{selectedPortfolio?.kind === 'baseline' ? '比较起点' : '相对当前持仓'}</Typography>
            </Typography>
            <PlanSummaryTiles baseline={baseline} plan={selectedPortfolio} />
          </Box>
          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'minmax(0, 1fr)', lg: 'minmax(0, 1.15fr) minmax(0, 1fr)' }, gap: 1.5, alignItems: 'start' }}>
            <Stack spacing={0.75} sx={{ minWidth: 0 }}>
              <PlanComparisonTable
                portfolios={report.portfolios}
                baseline={baseline}
                selectedId={resolvedPortfolioId}
                onSelect={setSelectedPortfolioId}
                instantWithoutMoves={instantWithoutMoves}
              />
              <Typography variant="caption" color="text.secondary">
                各方案用同一笔可测本金比较，卖出部分记为零收益现金。预设方案来自退场信号；“最差情景亏损前几只减半”的名单随情景变化。
              </Typography>
            </Stack>
            <TradeoffChart rows={ranking} reductions={customReductions} reductionPct={rankSettings.reduction} onToggle={toggleRow} />
          </Box>
          <HermesReview status={hermesStatus} review={review} selectedPortfolioId={resolvedPortfolioId} disabledReason={hermesDisabledReason} onRequest={requestHermesReview} />
        </>}

        {ranking.length ? (
          <Section
            title="减仓排序明细"
            summary={`${ranking.length} 行${best ? ` · 效率最高：${best.name}（${best.kind === 'free' ? '无上涨代价' : number.format(best.efficiency)}）` : ''}${customCount ? ` · 自定义方案 ${customCount} 只` : ''}`}
          >
            <ReductionRankingTable
              rows={ranking}
              reductions={customReductions}
              onRowReduction={setRowReduction}
              settings={rankSettings}
              onSettings={patch => setRankSettings(current => ({ ...current, ...patch }))}
              exitLevelOf={exitLevelOf}
              flatMonthOf={flatMonthOf}
              shock={shock}
              onClear={clearCustom}
            />
          </Section>
        ) : null}
        {selectedPortfolio ? <>
          {selectedPortfolio.kind !== 'baseline' ? (
            <Section title="调整差异" summary={`${selectedPortfolio.title} 相对当前持仓动了哪些仓位`}>
              <PlanAdjustments baseline={baseline} plan={selectedPortfolio} />
            </Section>
          ) : null}
          <Section title="压力来源" summary="默认显示所选方案的最差情景，可切换其他情景">
            <PressureSources plan={selectedPortfolio} scenarioId={scenarioId} onScenario={setScenarioId} horizonDays={horizonDays} otherShocks={Boolean(ivMove || fxMove)} />
          </Section>
          <Section title="成员与权重" summary={`${selectedPortfolio.productCount} 个产品`}>
            <PlanMembers plan={selectedPortfolio} />
          </Section>
        </> : null}
        <Section title="数据说明" summary="覆盖缺口、报价直接压力和行情时间">
          <StressDataNotes coverage={report.coverage} direct={direct} entries={entries} rollOpportunities={report.rollOpportunities} />
        </Section>
        <Section title="计算方法" summary="情景、排序指标、权证定价、Turbo 与 Factor，以及没有模拟的部分">
          <StressMethodology />
        </Section>
        <CustomPlanTray
          baseline={baseline}
          plan={customPortfolio}
          count={customCount}
          selected={resolvedPortfolioId === 'custom'}
          onSelect={() => setSelectedPortfolioId('custom')}
          onClear={clearCustom}
        />
      </Stack>
    </Box>
  )
}
