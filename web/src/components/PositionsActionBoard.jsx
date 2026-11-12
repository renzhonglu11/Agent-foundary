import { useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Chip,
  Drawer,
  LinearProgress,
  Stack,
  Tab,
  Tabs,
  Tooltip,
  Typography,
  keyframes,
  useMediaQuery,
  useTheme,
} from '@mui/material'
import { DataGrid } from '@mui/x-data-grid'
import AddCircleRoundedIcon from '@mui/icons-material/AddCircleRounded'
import AutorenewRoundedIcon from '@mui/icons-material/AutorenewRounded'
import CheckCircleRoundedIcon from '@mui/icons-material/CheckCircleRounded'
import TrendingDownRoundedIcon from '@mui/icons-material/TrendingDownRounded'
import ViewListRoundedIcon from '@mui/icons-material/ViewListRounded'

import { compactCurrency, number } from '../utils/formatters.js'
import { buildExitSignals } from '../utils/exitSignals.js'
import { RISK_SIGNAL_LABELS, confidenceLabel } from '../utils/labels.js'
import { buildOpportunityScreen } from '../utils/opportunityScreen.js'
import { buildPositionsCoverage } from '../utils/positionsCoverage.js'
import CoverageTip from './shared/CoverageTip.jsx'
import { withRowReduction } from '../utils/portfolioComparison.js'
import { EXIT_LEVEL_META } from '../utils/labels.js'
import { buildGroupShockScales } from '../utils/portfolioStress.js'
import { buildRollWhatIfs } from '../utils/rollWhatIf.js'
import { buildWatchlistGroups, canonicalGroupKey } from '../utils/watchlistGrouping.js'
import { useAlpacaDailyStats } from '../hooks/useAlpacaDailyStats.js'
import { useIvHistory } from '../hooks/useIvHistory.js'
import { useProductWatchlist } from '../hooks/useProductCandidates.js'
import { mergeOpportunityGroups } from '../utils/productCandidates.js'
import { DataHealthChip, DataHealthPanel, useDataHealth } from './DataHealthBadge.jsx'
import ExitSignalsPanel from './ExitSignalsPanel.jsx'
import OpportunitiesPanel from './OpportunitiesPanel.jsx'
import PortfolioStressTestPanel from './PortfolioStressTestPanel.jsx'
import ProductMonitoringDashboard from './ProductMonitoringDashboard.jsx'

const ALL_ACTIONS = 'ALL'
const actionDefinitions = [
  { id: ALL_ACTIONS, title: '全部', subtitle: '全部 Tier 1 产品', color: 'primary', icon: ViewListRoundedIcon },
  { id: 'SELL', title: 'SELL', subtitle: '卖出 / 降低风险', color: 'error', icon: TrendingDownRoundedIcon },
  { id: 'ROLL', title: 'ROLL', subtitle: '展期 / 换仓', color: 'warning', icon: AutorenewRoundedIcon },
  { id: 'HOLD', title: 'HOLD', subtitle: '继续持有并监控', color: 'info', icon: CheckCircleRoundedIcon },
  { id: 'BUY', title: 'BUY', subtitle: '允许买入 / 加仓', color: 'success', icon: AddCircleRoundedIcon },
]

const riskActionColors = {
  EXIT_NOW: 'error',
  REDUCE_CONCENTRATION: 'error',
  REDUCE_RISK: 'error',
  REDUCE_DERIVATIVE_RISK: 'error',
  ROLL: 'warning',
  CLOSE_OR_ROLL_DERIVATIVE: 'warning',
  HOLD_MONITOR: 'warning',
  SELL: 'error',
  HOLD: 'info',
  BUY: 'success',
  ADD_ALLOWED: 'success',
  BUY_MORE: 'success',
}

const subTabs = ['holdings', 'exits', 'plans', 'opportunities']
const SUB_TAB_STORAGE_KEY = 'positions.subTab'

function storedSubTab() {
  try {
    const value = window.localStorage.getItem(SUB_TAB_STORAGE_KEY)
    return subTabs.includes(value) ? value : 'holdings'
  } catch {
    return 'holdings'
  }
}

function storeSubTab(value) {
  try {
    window.localStorage.setItem(SUB_TAB_STORAGE_KEY, value)
  } catch {
    // Storage can be blocked; the tab then resets on reload.
  }
}

const PLAN_STORAGE_KEY = 'positions.customPlan'

// The custom plan survives a reload within this browser session only.
function storedPlan() {
  try {
    const value = JSON.parse(window.sessionStorage.getItem(PLAN_STORAGE_KEY))
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    return Object.fromEntries(Object.entries(value).filter(([, pct]) => [25, 50, 100].includes(pct)))
  } catch {
    return {}
  }
}

function storePlan(value) {
  try {
    window.sessionStorage.setItem(PLAN_STORAGE_KEY, JSON.stringify(value))
  } catch {
    // Storage can be blocked; the plan then lasts until reload.
  }
}

const rowClickedPulse = keyframes`
  0% { background-color: rgba(31, 95, 168, 0.28); }
  70% { background-color: rgba(31, 95, 168, 0.14); }
  100% { background-color: transparent; }
`

// ---- signal light helpers ----

const riskSignalColors = {
  HARD_BLOCKED: '#d32f2f',
  WATCH: '#ed6c02',
  OK: '#4caf50',
}



function riskTooltipLines(leg) {
  if (!leg) return '无风险数据'
  const lines = [
    `状态: ${RISK_SIGNAL_LABELS[leg.legRiskStatus] || leg.legRiskStatus || '—'}`,
    `敞口置信度: ${confidenceLabel(leg.exposureConfidence)}`,
    `数据完整度: ${leg.dataCompletenessRiskScore ?? '—'} / 10`,
  ]
  if (leg.barrierDistancePct != null) lines.push(`障碍距离: ${(leg.barrierDistancePct * 100).toFixed(1)}%`)
  if (leg.quoteAgeHours != null) lines.push(`报价时效: ${leg.quoteAgeHours.toFixed(1)}h`)
  if (leg.daysToExpiry != null) lines.push(`距到期: ${leg.daysToExpiry} 天`)
  if (leg.delta != null) lines.push(`Delta: ${number.format(leg.delta)}`)
  return lines.join('\n')
}

// ========================================================

export default function PositionsActionBoard({ data, riskData, riskLoading, riskError, structuredProducts, structuredProductsLoading, alpacaQuotes, onAddPnlRecord }) {
  const theme = useTheme()
  const isDesktopLayout = useMediaQuery(theme.breakpoints.up('lg'))
  const isMobileDrawer = useMediaQuery('(max-width:799.95px)')
  const [activeActionId, setActiveActionId] = useState(null)
  const [selectedProduct, setSelectedProduct] = useState(null)
  const [clickedRowId, setClickedRowId] = useState(null)
  const [subTab, setSubTab] = useState(storedSubTab)
  // Panels mount on first visit and then stay mounted, so their own settings
  // survive tab switches while unopened panels skip their calculations.
  const [visitedTabs, setVisitedTabs] = useState(() => new Set([subTab]))
  const [healthOpen, setHealthOpen] = useState(false)
  // Shared by the holdings, exit signal and plan tabs: product id → % sold.
  const [customReductions, setCustomReductions] = useState(storedPlan)
  useEffect(() => storePlan(customReductions), [customReductions])
  const [planFocus, setPlanFocus] = useState(0)
  const dataHealth = useDataHealth()
  const totalMarketValue = Number(data?.summary?.totalMarketValue) || 0
  const totalCostBasis = Number(data?.summary?.totalCostBasis) || 0
  const productWatchlist = useProductWatchlist()
  const heldIsins = useMemo(() => new Set((data?.positions || []).filter(p => Math.abs(Number(p.quantity) || 0) > 1e-6).map(p => p.symbol)), [data])
  const watchlistGroups = useMemo(() => {
    const heldSymbols = new Set((data?.positions || []).filter(position => Math.abs(Number(position.quantity) || 0) > 1e-6).map(position => position.symbol))
    const heldEnrichment = (structuredProducts || []).filter(item => heldSymbols.has(item.isin))
    return buildWatchlistGroups(data, heldEnrichment, alpacaQuotes)
  }, [data, structuredProducts, alpacaQuotes])
  const tier1Groups = watchlistGroups.tier1
  const allGroups = useMemo(() => [...watchlistGroups.tier1, ...watchlistGroups.tier2, ...watchlistGroups.tier3], [watchlistGroups])
  const opportunityGroups = useMemo(() => mergeOpportunityGroups(allGroups, productWatchlist.items, heldIsins), [allGroups, productWatchlist.items, heldIsins])
  const riskByKey = useMemo(() => buildRiskMap(riskData), [riskData])
  const groupsWithRisk = useMemo(() => (
    tier1Groups
      .map((group) => {
        const riskGroup = riskByKey.get(group.key) || riskByKey.get(canonicalGroupKey(group.groupName))
        return { group, riskGroup }
      })
      .filter(({ riskGroup }) => Boolean(riskGroup))
  ), [riskByKey, tier1Groups])
  const productEntries = useMemo(() => buildProductActionEntries(groupsWithRisk, totalMarketValue), [groupsWithRisk, totalMarketValue])
  // Tier 1 underlyings first, so they are kept if the backend's symbol limit cuts the list.
  const underlyingSymbols = useMemo(() => [...new Set(opportunityGroups.map(group => group.alpacaSymbol).filter(Boolean))].slice(0, 100), [opportunityGroups])
  const dailyStats = useAlpacaDailyStats(underlyingSymbols)
  const ivHistory = useIvHistory()
  const exitReport = useMemo(() => buildExitSignals(productEntries, dailyStats.data), [productEntries, dailyStats.data])
  const opportunityScreen = useMemo(() => buildOpportunityScreen({
    groups: opportunityGroups,
    dailyStats: dailyStats.data,
    impliedByGroup: new Map(buildGroupShockScales(productEntries).groups.map(group => [group.key, group.volatilityPct != null ? group.volatilityPct / 100 : null])),
    ivHistoryByIsin: new Map(ivHistory.data.map(history => [history.isin, history])),
    exitSignals: exitReport.signals,
    totalMarketValue,
  }), [opportunityGroups, dailyStats.data, productEntries, ivHistory.data, exitReport, totalMarketValue])
  const rollWhatIfs = useMemo(() => buildRollWhatIfs(productEntries, exitReport.signals), [productEntries, exitReport])
  const coverage = useMemo(() => buildPositionsCoverage({
    positions: data?.positions,
    tier1Groups,
    shownEntries: productEntries,
  }), [data, tier1Groups, productEntries])
  const urgentExitCount = exitReport.counts?.urgent || 0
  const exitSignalById = useMemo(() => new Map(exitReport.signals.map(signal => [signal.id, signal])), [exitReport])
  const customCount = Object.values(customReductions).filter(pct => pct > 0).length
  const flaggedRollCount = rollWhatIfs.filter(roll => roll.flagged).length
  const sections = useMemo(() => (
    actionDefinitions.map((definition) => ({
      ...definition,
      entries: definition.id === ALL_ACTIONS ? productEntries : productEntries.filter((entry) => entry.primaryAction === definition.id),
    }))
  ), [productEntries])
  const resolvedActiveActionId = activeActionId ?? ALL_ACTIONS
  const activeSection = sections.find((section) => section.id === resolvedActiveActionId) || sections[0]

  const loading = Boolean(riskLoading || structuredProductsLoading)
  const handleActionChange = (actionId) => {
    if (actionId === resolvedActiveActionId) return
    setActiveActionId(actionId)
    setSelectedProduct(null)
    setClickedRowId(null)
  }

  const handleSubTabChange = (_event, value) => {
    setSubTab(value)
    setVisitedTabs(current => (current.has(value) ? current : new Set([...current, value])))
    storeSubTab(value)
  }

  const setPlanReduction = (id, pct) => setCustomReductions(current => withRowReduction(current, [id], pct))
  const showPlan = () => {
    handleSubTabChange(null, 'plans')
    setPlanFocus(current => current + 1)
  }

  const handleRowClick = (row) => {
    setClickedRowId(row.id)
    window.setTimeout(() => setClickedRowId((current) => (current === row.id ? null : current)), 650)
    setSelectedProduct((current) => {
      if (current?.item?.id === row.item.id) return null
      return row
    })
  }

  return (
    <Box sx={{ border: '1px solid #d9e2ec', borderRadius: 2, backgroundColor: '#ffffff' }}>
      {/* header */}
      <Box sx={{ px: { xs: 2, md: 2.5 }, py: 1.5, borderBottom: '1px solid #d9e2ec', backgroundColor: '#fbfdff' }}>
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={1} sx={{ justifyContent: 'space-between', alignItems: { xs: 'flex-start', md: 'center' } }}>
          <Box>
            <Typography variant="h6" fontSize="1rem">Tier 1 仓位监控</Typography>
          </Box>
          <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
            <Chip size="small" color="primary" label={`${groupsWithRisk.length} 标的组`} />
            <Chip size="small" variant="outlined" label={`${productEntries.length} 产品`} />
            <DataHealthChip health={dataHealth} open={healthOpen} onToggle={() => setHealthOpen(current => !current)} />
          </Stack>
        </Stack>
      </Box>
      <DataHealthPanel health={dataHealth} open={healthOpen} />

      {loading ? <LinearProgress /> : null}

      <Tabs
        value={subTab}
        onChange={handleSubTabChange}
        variant="scrollable"
        allowScrollButtonsMobile
        aria-label="仓位监控子页面"
        sx={{
          px: { xs: 1, md: 1.5 },
          minHeight: 44,
          borderBottom: '1px solid #d9e2ec',
          '& .MuiTab-root': { minHeight: 44, textTransform: 'none', fontWeight: 700 },
        }}
      >
        <Tab value="holdings" id="positions-tab-holdings" aria-controls="positions-panel-holdings"
          label={<TabLabel label="持仓" count={`${coverage.shownCount} / ${coverage.heldCount}`} />} />
        <Tab value="exits" id="positions-tab-exits" aria-controls="positions-panel-exits"
          label={<TabLabel label="退场信号" badge={urgentExitCount} color="error" />} />
        <Tab value="plans" id="positions-tab-plans" aria-controls="positions-panel-plans"
          label={<TabLabel label="方案对比" badge={customCount} />} />
        <Tab value="opportunities" id="positions-tab-opportunities" aria-controls="positions-panel-opportunities"
          label={<TabLabel label="机会与换仓" badge={flaggedRollCount} />} />
      </Tabs>

      <Stack spacing={1.5} useFlexGap sx={{ p: { xs: 1.5, md: 2 } }}>
        {riskError ? <Alert severity="warning" sx={{ py: 0 }}>风险数据加载失败：{riskError.message}</Alert> : null}

        <SubTabPanel value="holdings" active={subTab} visited={visitedTabs}>
          <CoverageNotice coverage={coverage} loading={loading} />
          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: { xs: '1fr', lg: 'minmax(0, 3fr) minmax(440px, 2fr)' },
              gap: 1.5,
              alignItems: 'start',
            }}
          >
            <Stack spacing={1} sx={{ minWidth: 0 }}>
              <ActionFilterBar
                sections={sections}
                activeActionId={resolvedActiveActionId}
                onChange={handleActionChange}
              />
              <Box sx={{ border: '1px solid #d9e2ec', borderRadius: 2, overflow: 'hidden' }}>
                {activeSection.entries.length ? (
                  <ProductActionTable
                    entries={activeSection.entries}
                    onRowClick={handleRowClick}
                    clickedRowId={clickedRowId}
                  />
                ) : (
                  <Box sx={{ px: 1.5, py: 2 }}>
                    <Typography variant="body2" color="text.secondary">
                      当前没有匹配的 Tier 1 产品。
                    </Typography>
                  </Box>
                )}
              </Box>
            </Stack>

            {isDesktopLayout ? (
              <Box
                sx={{
                  position: 'sticky',
                  top: 72,
                  zIndex: 5,
                  maxHeight: 'calc(100vh - 80px)',
                  overflowY: 'auto',
                  backgroundColor: '#ffffff',
                  borderRadius: 2,
                  boxShadow: '0 8px 24px rgba(15, 23, 42, 0.08)',
                  overscrollBehavior: 'contain',
                  minWidth: 0,
                }}
              >
                <ProductMonitoringDashboard
                  summary={selectedProduct ? (
                    <ProductPlanStrip
                      signal={exitSignalById.get(String(selectedProduct.item?.symbol))}
                      reduction={customReductions[String(selectedProduct.item?.symbol)] || 0}
                      onReduce={pct => setPlanReduction(String(selectedProduct.item?.symbol), pct)}
                      onShowPlan={showPlan}
                    />
                  ) : null}
                  item={selectedProduct?.item ?? null}
                  riskLeg={selectedProduct?.riskLeg ?? null}
                  onClose={() => setSelectedProduct(null)}
                  onAddPnlRecord={onAddPnlRecord}
                />
              </Box>
            ) : null}
          </Box>
        </SubTabPanel>

        <SubTabPanel value="exits" active={subTab} visited={visitedTabs}>
          {exitReport.signals.length ? (
            <ExitSignalsPanel
              report={exitReport}
              dailyStats={dailyStats.data}
              dailyStatsLoading={dailyStats.loading}
              dailyStatsError={dailyStats.error}
              dailyStatsWarnings={dailyStats.warnings}
              planReductions={customReductions}
              onPlanReduction={setPlanReduction}
              onShowPlan={showPlan}
              onSelectProduct={(id) => {
                const entry = productEntries.find(candidate => candidate.item.symbol === id)
                if (!entry) return
                setSelectedProduct(entry)
                // On desktop the detail view lives beside the holdings table.
                if (isDesktopLayout) handleSubTabChange(null, 'holdings')
              }}
            />
          ) : (
            <Typography variant="body2" color="text.secondary" sx={{ py: 1 }}>
              {loading ? '正在读取风险数据…' : '当前没有可计算退场信号的 Tier 1 产品。'}
            </Typography>
          )}
        </SubTabPanel>

        <SubTabPanel value="plans" active={subTab} visited={visitedTabs}>
          <PortfolioStressTestPanel
            exitSignals={exitReport.signals}
            positions={data.positions}
            entries={productEntries}
            loading={loading}
            totalMarketValue={totalMarketValue}
            totalCostBasis={totalCostBasis}
            customReductions={customReductions}
            onCustomReductionsChange={setCustomReductions}
            planFocus={planFocus}
          />
        </SubTabPanel>

        <SubTabPanel value="opportunities" active={subTab} visited={visitedTabs}>
          <OpportunitiesPanel
            watchlist={productWatchlist}
            entries={productEntries}
            heldIsins={heldIsins}
            ivHistory={ivHistory.data}
            screen={opportunityScreen}
            rolls={rollWhatIfs}
            loading={dailyStats.loading}
            statsError={dailyStats.error}
            ivMinObservations={ivHistory.minObservations}
          />
        </SubTabPanel>
      </Stack>

      {!isDesktopLayout ? (
        <Drawer
          anchor={isMobileDrawer ? 'bottom' : 'right'}
          open={Boolean(selectedProduct)}
          onClose={() => setSelectedProduct(null)}
          sx={{ zIndex: (currentTheme) => currentTheme.zIndex.modal }}
          slotProps={{
            paper: {
              'aria-label': '产品实时监控',
              sx: isMobileDrawer
                ? {
                    width: '100%',
                    height: '85vh',
                    borderRadius: '16px 16px 0 0',
                    p: 1,
                    backgroundColor: '#f5f7fa',
                  }
                : {
                    width: 'clamp(520px, 62vw, 720px)',
                    p: 1.5,
                    backgroundColor: '#f5f7fa',
                  },
            },
          }}
        >
          <ProductMonitoringDashboard
            summary={selectedProduct ? (
              <ProductPlanStrip
                signal={exitSignalById.get(String(selectedProduct.item?.symbol))}
                reduction={customReductions[String(selectedProduct.item?.symbol)] || 0}
                onReduce={pct => setPlanReduction(String(selectedProduct.item?.symbol), pct)}
                onShowPlan={() => { setSelectedProduct(null); showPlan() }}
              />
            ) : null}
            item={selectedProduct?.item ?? null}
            riskLeg={selectedProduct?.riskLeg ?? null}
            onClose={() => setSelectedProduct(null)}
            onAddPnlRecord={onAddPnlRecord}
          />
        </Drawer>
      ) : null}
    </Box>
  )
}

// ---- plan strip ----

// Above the product detail: why the exit signal fired, and a one-click way to
// put the product into the custom plan without leaving the holdings tab.
function ProductPlanStrip({ signal, reduction, onReduce, onShowPlan }) {
  const flagged = signal && (signal.level === 'urgent' || signal.level === 'warn')
  const meta = signal ? EXIT_LEVEL_META[signal.level] : null
  return (
    <Box sx={{ px: 1.5, py: 1, borderBottom: '1px solid #d9e2ec', backgroundColor: flagged ? '#fff8ef' : '#f8fafc' }}>
      <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
        {meta ? <Chip size="small" color={meta.color} variant={flagged ? 'filled' : 'outlined'} label={`退场信号：${meta.label}`} /> : <Chip size="small" variant="outlined" label="无退场信号数据" />}
        {signal?.decay?.return30dPct != null ? (
          <Typography variant="caption" color={signal.decay.return30dPct <= -15 ? 'error.main' : 'text.secondary'}>
            横盘 30 天 {signal.decay.return30dPct > 0 ? '+' : ''}{number.format(signal.decay.return30dPct)}%
          </Typography>
        ) : null}
        <Stack direction="row" spacing={0.75} sx={{ ml: 'auto' }}>
          {reduction > 0 ? <>
            <Button size="small" variant="contained" onClick={onShowPlan} sx={{ textTransform: 'none' }}>
              已在方案中（{reduction >= 100 ? '退出' : `减 ${reduction}%`}）· 去对比
            </Button>
            <Button size="small" onClick={() => onReduce(0)} sx={{ textTransform: 'none' }}>移出</Button>
          </> : (
            <Button size="small" variant="outlined" onClick={() => onReduce(50)} sx={{ textTransform: 'none' }}>在方案中减 50%</Button>
          )}
        </Stack>
      </Stack>
      {flagged && signal.reasons?.length ? (
        <Typography variant="caption" component="div" sx={{ mt: 0.5 }}>
          {signal.reasons.slice(0, 2).map(reason => reason.text).join('；')}
        </Typography>
      ) : null}
    </Box>
  )
}

// ---- sub tabs ----

function TabLabel({ label, count, badge, color = 'primary' }) {
  return (
    <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
      <span>{label}</span>
      {count ? <Typography component="span" variant="caption" color="text.secondary" sx={{ fontVariantNumeric: 'tabular-nums' }}>{count}</Typography> : null}
      {badge > 0 ? <Chip component="span" size="small" color={color} label={badge} sx={{ height: 18, fontSize: 11, '& .MuiChip-label': { px: 0.75 } }} /> : null}
    </Stack>
  )
}

// Hidden with `display: none` rather than the `hidden` attribute, which the
// Stack's own display rule would override.
function SubTabPanel({ value, active, visited, children }) {
  if (!visited.has(value)) return null
  return (
    <Stack
      spacing={1.5}
      role="tabpanel"
      id={`positions-panel-${value}`}
      aria-labelledby={`positions-tab-${value}`}
      sx={{ display: value === active ? 'flex' : 'none', minWidth: 0 }}
    >
      {children}
    </Stack>
  )
}

// What the product table leaves out, so a partial view is never mistaken for
// the whole account.
function CoverageNotice({ coverage, loading }) {
  const [open, setOpen] = useState(false)
  if (loading || !coverage.heldCount) return null
  const { missingRisk, tier1Stocks, otherTiers } = coverage
  const hiddenCount = coverage.heldCount - coverage.shownCount
  const parts = [
    missingRisk.count ? `${missingRisk.count} 个 Tier 1 产品缺少风险数据（${compactCurrency(missingRisk.value)}）` : null,
    tier1Stocks.count ? `${tier1Stocks.count} 个 Tier 1 股票 / ETF 不在本表（${compactCurrency(tier1Stocks.value)}）` : null,
    otherTiers.count ? `${otherTiers.count} 个 Tier 2 / 3 持仓（${compactCurrency(otherTiers.value)}）` : null,
  ].filter(Boolean)
  const listed = missingRisk.rows.slice(0, 12)
  return (
    <Alert
      severity={missingRisk.count ? 'warning' : 'info'}
      sx={{ py: 0.25, '& .MuiAlert-message': { minWidth: 0 } }}
      action={missingRisk.count ? (
        <Button size="small" color="inherit" aria-expanded={open} onClick={() => setOpen(current => !current)}>
          {open ? '收起' : '查看缺失产品'}
        </Button>
      ) : null}
    >
      <Typography variant="body2">
        持仓表覆盖 <b>{number.format(coverage.shownValuePct)}%</b><CoverageTip current="table" />：显示 <b>{coverage.shownCount} / {coverage.heldCount}</b> 个持仓
        {hiddenCount > 0 ? `；未显示 ${hiddenCount} 个：${parts.join('；')}。` : '，全部持仓都已显示。'}
      </Typography>
      {open ? (
        <Box component="ul" sx={{ m: 0, mt: 0.5, pl: 2.5 }}>
          {listed.map(row => (
            <Typography component="li" variant="caption" key={row.symbol}>
              {row.name} · {row.groupName} · {compactCurrency(row.marketValue)}
            </Typography>
          ))}
          {missingRisk.rows.length > listed.length ? (
            <Typography component="li" variant="caption">另有 {missingRisk.rows.length - listed.length} 个</Typography>
          ) : null}
        </Box>
      ) : null}
    </Alert>
  )
}

// ---- action filter ----

function ActionFilterBar({ sections, activeActionId, onChange }) {
  return (
    <Box sx={{ border: '1px solid #d9e2ec', borderRadius: 2, backgroundColor: '#f8fafc', overflow: 'hidden' }}>
      <Stack
        direction="row"
        spacing={0.75}
        sx={{
          p: 1,
          overflowX: 'auto',
          overscrollBehaviorX: 'contain',
          scrollbarWidth: 'thin',
          '&::-webkit-scrollbar': { height: 5 },
          '&::-webkit-scrollbar-thumb': { backgroundColor: '#cbd5e1', borderRadius: 999 },
        }}
      >
        {sections.map((section) => {
          const Icon = section.icon
          const active = section.id === activeActionId

          return (
            <Tooltip key={section.id} title={section.subtitle} arrow enterDelay={400}>
              <Button
                size="small"
                variant={active ? 'contained' : 'outlined'}
                color={section.color}
                startIcon={(
                  <Icon
                    fontSize="small"
                    sx={{ color: active ? 'inherit' : `${section.color}.main` }}
                  />
                )}
                onClick={() => onChange(section.id)}
                aria-pressed={active}
                aria-label={`${section.title} ${section.subtitle}，${section.entries.length} 个产品`}
                sx={{
                  minWidth: 'max-content',
                  px: 1.25,
                  py: 0.6,
                  borderRadius: 1.5,
                  borderColor: active ? undefined : '#d8e0e8',
                  color: active ? undefined : 'text.primary',
                  boxShadow: 'none',
                  textTransform: 'none',
                  whiteSpace: 'nowrap',
                  '&:hover': {
                    borderColor: `${section.color}.main`,
                    backgroundColor: active ? undefined : `${section.color}.light`,
                    boxShadow: 'none',
                  },
                  '& .MuiButton-startIcon': { mr: 0.75 },
                }}
              >
                <Typography
                  component="span"
                  variant="body2"
                  fontWeight={900}
                  sx={{ fontVariantNumeric: 'tabular-nums' }}
                >
                  {section.title}
                  {section.id !== ALL_ACTIONS ? (
                    <Box component="span" sx={{ display: { xs: 'none', md: 'inline' }, fontWeight: 500, ml: 0.75, opacity: 0.75 }}>{section.subtitle}</Box>
                  ) : null}
                  <Box component="span" sx={{ ml: 0.75 }}>{section.entries.length}</Box>
                </Typography>
              </Button>
            </Tooltip>
          )
        })}
      </Stack>
    </Box>
  )
}

// ---- table columns ----

const GROUP_ACTION_LABELS = {
  SELL: '卖出',
  BUY: '买入',
  HOLD: '持有',
  EXIT_NOW: '立即退出',
  REDUCE_CONCENTRATION: '降低集中度',
  REDUCE_RISK: '降低风险',
  REDUCE_DERIVATIVE_RISK: '降衍生品风险',
  ROLL: '展期',
  CLOSE_OR_ROLL_DERIVATIVE: '平仓或展期',
  HOLD_MONITOR: '持有观察',
  ADD_ALLOWED: '允许加仓',
  BUY_MORE: '主动加仓',
  'N/A': '无评估',
}

const actionDescriptions = {
  SELL: '产品风险、到期、障碍价、数据质量或单品敞口触发卖出/减仓',
  BUY: '产品风险预算、Delta、杠杆、期限和敞口满足买入/加仓条件',
  HOLD: '当前无紧急风险，但买入条件不够强',
  EXIT_NOW: '风险已越过退出阈值，优先平仓或清理该产品',
  REDUCE_CONCENTRATION: '该标的敞口集中度过高，建议减持',
  REDUCE_RISK: '衍生品数据质量、杠杆、障碍价或单腿敞口触发风险降档',
  REDUCE_DERIVATIVE_RISK: '衍生品数据缺失或障碍价临近，建议降低风险敞口',
  ROLL: '产品临近到期，建议展期或换到更远期限',
  CLOSE_OR_ROLL_DERIVATIVE: '衍生品临近到期，建议平仓或展期',
  HOLD_MONITOR: '当前无紧急风险，继续持有并监控',
  ADD_ALLOWED: '风险检查通过，允许加仓但不是主动买入建议',
  BUY_MORE: '敞口、Delta、杠杆、期限和组级仓位均满足主动加仓条件',
}

const tableColumns = [
  // All content-bearing columns share flex:1 so widths stay even;
  // only the ultra-narrow signal and DTE stay fixed.
  // valueGetter extracts the raw sortable value from nested row data.
  {
    field: 'productName',
    headerName: '产品名称',
    flex: 2.2,
    minWidth: 260,
    valueGetter: (_, row) => productDisplayName(row.item),
    renderCell: ({ row }) => {
      const fullName = productDisplayName(row.item)
      return (
        <Tooltip title={fullName} arrow placement="top" slotProps={{ tooltip: { sx: { cursor: 'default' } } }}>
          <Box sx={{ minWidth: 0, py: 0.25 }}>
            <Typography
              variant="body2"
              fontWeight={700}
              sx={{ whiteSpace: 'normal', overflowWrap: 'anywhere', lineHeight: 1.25 }}
            >
              {fullName}
            </Typography>
            <Typography variant="caption" color="text.secondary" noWrap>{row.item.symbol}</Typography>
          </Box>
        </Tooltip>
      )
    },
  },
  {
    field: 'groupAction',
    headerName: '组动作',
    description: '整个标的组的风险动作，来自组级风险检查；可能与上方按单个产品划分的 SELL / ROLL / HOLD / BUY 不同。',
    flex: 1,
    minWidth: 104,
    valueGetter: (_, row) => row.riskGroup?.action?.groupActionLabel || row.riskGroup?.groupActionLabel || '',
    renderCell: ({ row }) => {
      const action = row.riskGroup?.action?.groupActionLabel || row.riskGroup?.groupActionLabel || 'N/A'
      const label = GROUP_ACTION_LABELS[action] || String(action).replace(/_/g, ' ')
      const desc = actionDescriptions[action] || '暂无风险评估'
      return (
        <Tooltip title={desc} arrow placement="top" slotProps={{ tooltip: { sx: { cursor: 'default' } } }}>
          <Chip size="small" color={riskActionColors[action] || 'default'}
            variant={action === 'N/A' ? 'outlined' : 'filled'}
            label={label}
            sx={{ height: 20, '& .MuiChip-label': { px: 0.75, fontSize: '0.7rem' } }}
          />
        </Tooltip>
      )
    },
  },
  {
    field: 'marketValue',
    headerName: '市值',
    type: 'number',
    flex: 1,
    minWidth: 80,
    valueGetter: (_, row) => Number(row.item?.marketValue) || 0,
    renderCell: ({ row }) => (
      <Typography variant="body2" sx={{ fontVariantNumeric: 'tabular-nums' }}>
        {compactCurrency(row.item.marketValue || 0)}
      </Typography>
    ),
  },
  {
    field: 'deltaExposure',
    headerName: 'Δ 敞口',
    type: 'number',
    flex: 1,
    minWidth: 90,
    valueGetter: (_, row) => Number(row.riskLeg?.deltaExposure ?? row.item?.deltaExposureEur) || 0,
    renderCell: ({ row }) => (
      <Typography variant="body2" sx={{ fontVariantNumeric: 'tabular-nums' }}>
        {compactCurrency(row.riskLeg?.deltaExposure ?? row.item.deltaExposureEur)}
      </Typography>
    ),
  },
  {
    field: 'exposurePct',
    headerName: '敞口%',
    type: 'number',
    flex: 1,
    minWidth: 70,
    valueGetter: (_, row) => Number(row.exposurePct) || 0,
    renderCell: ({ row }) => (
      <Typography variant="body2" sx={{ fontVariantNumeric: 'tabular-nums' }}>
        {formatSignedWeight(row.exposurePct)}
      </Typography>
    ),
  },
  {
    field: 'delta',
    headerName: 'Delta',
    type: 'number',
    flex: 1,
    minWidth: 58,
    valueGetter: (_, row) => row.item?.delta ?? null,
    renderCell: ({ row }) => {
      const d = row.item.delta
      return d != null
        ? <Typography variant="body2" sx={{ fontVariantNumeric: 'tabular-nums' }}>{number.format(d)}</Typography>
        : <Typography variant="body2" color="text.disabled">—</Typography>
    },
  },
  {
    field: 'omega',
    headerName: 'Omega',
    type: 'number',
    flex: 1,
    minWidth: 58,
    valueGetter: (_, row) => row.item?.omega ?? null,
    renderCell: ({ row }) => {
      const o = row.item.omega
      return o != null
        ? <Typography variant="body2" sx={{ fontVariantNumeric: 'tabular-nums' }}>{number.format(o)}</Typography>
        : <Typography variant="body2" color="text.disabled">—</Typography>
    },
  },
  {
    field: 'leverage',
    headerName: '杠杆',
    type: 'number',
    flex: 1,
    minWidth: 58,
    valueGetter: (_, row) => Number(row.item?.leverage || row.item?.effectiveLeverage) || 0,
    renderCell: ({ row }) => {
      const lev = row.item.leverage || row.item.effectiveLeverage
      return lev != null
        ? <Typography variant="body2" sx={{ fontVariantNumeric: 'tabular-nums' }}>{number.format(lev)}</Typography>
        : <Typography variant="body2" color="text.disabled">—</Typography>
    },
  },
  {
    field: 'iv',
    headerName: 'IV',
    type: 'number',
    flex: 1,
    minWidth: 58,
    valueGetter: (_, row) => Number(row.item?.iv) || null,
    renderCell: ({ row }) => {
      const iv = row.item.iv
      return iv != null
        ? <Typography variant="body2" sx={{ fontVariantNumeric: 'tabular-nums' }}>{(Number(iv) * 100).toFixed(0)}%</Typography>
        : <Typography variant="body2" color="text.disabled">—</Typography>
    },
  },
  {
    field: 'daysToExpiry',
    headerName: 'DTE',
    type: 'number',
    width: 56,
    valueGetter: (_, row) => row.riskLeg?.daysToExpiry ?? null,
    renderCell: ({ row }) => <DteCell dte={row.riskLeg?.daysToExpiry} />,
  },
  {
    field: 'riskStatus',
    headerName: '信号',
    width: 48,
    valueGetter: (_, row) => row.riskLeg?.legRiskStatus || '',
    renderCell: ({ row }) => <RiskSignal leg={row.riskLeg} />,
  },
  {
    field: 'quantity',
    headerName: '数量',
    type: 'number',
    flex: 1,
    minWidth: 65,
    valueGetter: (_, row) => Number(row.item?.quantity) || 0,
    renderCell: ({ row }) => (
      <Typography variant="body2" sx={{ fontVariantNumeric: 'tabular-nums' }}>
        {number.format(row.item.quantity ?? 0)}
      </Typography>
    ),
  },
]

// ---- table ----

// Greeks and quantity are one click away; the default view fits without
// horizontal scrolling.
const DEFAULT_HIDDEN_COLUMNS = { delta: false, omega: false, leverage: false, iv: false, quantity: false }
const COLUMN_STORAGE_KEY = 'positions.columnVisibility'

function storedColumnVisibility() {
  try {
    const value = JSON.parse(window.localStorage.getItem(COLUMN_STORAGE_KEY))
    return value && typeof value === 'object' && !Array.isArray(value) ? value : DEFAULT_HIDDEN_COLUMNS
  } catch {
    return DEFAULT_HIDDEN_COLUMNS
  }
}

function ProductActionTable({ entries, onRowClick, clickedRowId }) {
  const rows = useMemo(() => entries.map((entry, index) => ({
    id: `${entry.primaryAction}-${entry.item.id ?? index}`,
    ...entry,
  })), [entries])
  const [columnVisibility, setColumnVisibility] = useState(storedColumnVisibility)
  const changeColumnVisibility = (model) => {
    setColumnVisibility(model)
    try {
      window.localStorage.setItem(COLUMN_STORAGE_KEY, JSON.stringify(model))
    } catch {
      // Storage can be blocked; the choice then lasts for this visit.
    }
  }
  const showingMore = Object.keys(DEFAULT_HIDDEN_COLUMNS).some(field => columnVisibility[field] !== false)
  const toggleMore = () => changeColumnVisibility(showingMore
    ? { ...columnVisibility, ...DEFAULT_HIDDEN_COLUMNS }
    : { ...columnVisibility, ...Object.fromEntries(Object.keys(DEFAULT_HIDDEN_COLUMNS).map(field => [field, true])) })

  return (
    <Box sx={{ width: '100%' }}>
      <DataGrid
        rows={rows}
        columns={tableColumns}
        columnVisibilityModel={columnVisibility}
        onColumnVisibilityModelChange={changeColumnVisibility}
        density="compact"
        disableRowSelectionOnClick
        onRowClick={({ row }) => onRowClick?.(row)}
        autoHeight
        getRowHeight={() => 'auto'}
        getEstimatedRowHeight={() => 56}
        hideFooter={rows.length <= 25}
        initialState={{
          sorting: { sortModel: [{ field: 'marketValue', sort: 'desc' }] },
          pagination: { paginationModel: { pageSize: 25, page: 0 } },
        }}
        pageSizeOptions={[10, 25, 50]}
        sx={{
          border: 'none',
          fontSize: '0.8rem',
          '& .MuiDataGrid-columnHeaders': { fontSize: '0.75rem' },
          '& .MuiDataGrid-row': { cursor: 'pointer' },
          '& .MuiDataGrid-cell': { py: 0.75, px: 1, display: 'flex', alignItems: 'center' },
          '& .MuiDataGrid-columnHeader': { backgroundColor: '#f8fafc', px: 1 },
          ...(clickedRowId && {
            [`& .MuiDataGrid-row[data-id="${clickedRowId}"]`]: {
              animation: `${rowClickedPulse} 650ms ease-out`,
            },
          }),
        }}
      />
      <Box sx={{ px: 1, py: 0.5, borderTop: '1px solid #d9e2ec' }}>
        <Button size="small" onClick={toggleMore} aria-pressed={showingMore} sx={{ textTransform: 'none' }}>
          {showingMore ? '收起 Delta、Omega、杠杆、IV、数量' : '+ 更多列：Delta、Omega、杠杆、IV、数量'}
        </Button>
      </Box>
    </Box>
  )
}

// ---- cell renderers ----

function DteCell({ dte }) {
  if (dte == null) return <Typography variant="body2" color="text.disabled" fontSize="inherit">—</Typography>
  const color = dte < 7 ? '#d32f2f' : dte < 30 ? '#ed6c02' : undefined
  return (
    <Typography variant="body2" fontWeight={dte < 7 ? 700 : 400} sx={{ color, fontVariantNumeric: 'tabular-nums' }} fontSize="inherit">
      {dte}
    </Typography>
  )
}

function RiskSignal({ leg }) {
  if (!leg) return <Typography variant="body2" color="text.disabled" fontSize="inherit">—</Typography>

  const status = leg.legRiskStatus || '—'
  const color = riskSignalColors[status] || '#9e9e9e'
  const tooltip = riskTooltipLines(leg)

  return (
    <Tooltip title={<Box component="span" sx={{ whiteSpace: 'pre-line', fontSize: '0.8rem' }}>{tooltip}</Box>} arrow placement="right" slotProps={{ tooltip: { sx: { cursor: 'default' } } }}>
      <Box
        sx={{
          width: 12, height: 12, borderRadius: '50%',
          backgroundColor: color,
          boxShadow: `0 0 6px ${color}66`,
          flexShrink: 0,
        }}
      />
    </Tooltip>
  )
}

function buildRiskMap(riskData) {
  const map = new Map()
  if (!Array.isArray(riskData)) return map
  riskData.forEach((riskGroup) => {
    const key = canonicalGroupKey(riskGroup?.symbol)
    if (key && key !== 'unknown') map.set(key, riskGroup)
  })
  return map
}

function buildProductActionEntries(groupsWithRisk, totalMarketValue) {
  return groupsWithRisk.flatMap(({ group, riskGroup }) => {
    const riskLegByIsin = new Map((riskGroup?.legs || []).map((leg) => [leg.isin, leg]))
    return group.derivatives.map((item) => {
      const riskLeg = riskLegByIsin.get(item.symbol)
      const exposure = Number(riskLeg?.deltaExposure ?? item.deltaExposureEur)
      return {
        group, riskGroup, item, riskLeg,
        exposurePct: totalMarketValue > 0 && Number.isFinite(exposure) ? exposure / totalMarketValue : null,
        primaryAction: primaryActionForProduct(riskGroup, riskLeg),
      }
    })
  })
}

function primaryActionForProduct(riskGroup, riskLeg) {
  const groupAction = riskGroup?.action?.groupActionLabel || riskGroup?.groupActionLabel
  const daysToExpiry = Number(riskLeg?.daysToExpiry)
  const status = riskLeg?.legRiskStatus
  const confidence = riskLeg?.exposureConfidence
  const allowed = new Set(Array.isArray(riskGroup?.action?.allowedActions) ? riskGroup.action.allowedActions : [])
  const legAction = normalizeProductAction(riskLeg?.primaryAction)

  if (['SELL', 'ROLL', 'HOLD', 'BUY'].includes(legAction)) return legAction
  if (allowed.has('ROLL') && Number.isFinite(daysToExpiry) && daysToExpiry >= 0 && daysToExpiry < 7) return 'ROLL'
  if (status === 'HARD_BLOCKED') return 'SELL'
  if (status === 'WATCH') return 'SELL'
  if (groupAction === 'REDUCE_DERIVATIVE_RISK') return 'SELL'
  if (groupAction === 'CLOSE_OR_ROLL_DERIVATIVE') return 'HOLD'
  if (groupAction === 'ADD_ALLOWED' || ((allowed.has('BUY_MORE') || allowed.has('BUY')) && status === 'OK' && confidence !== 'no_data')) return 'HOLD'
  return 'HOLD'
}

function normalizeProductAction(action) {
  if (action === 'SELL' || action === 'ROLL' || action === 'HOLD' || action === 'BUY') return action
  if (action === 'EXIT_NOW' || action === 'REDUCE_RISK' || action === 'REDUCE_DERIVATIVE_RISK') return 'SELL'
  if (action === 'HOLD_MONITOR' || action === 'CLOSE_OR_ROLL_DERIVATIVE') return 'HOLD'
  if (action === 'ADD_ALLOWED' || action === 'BUY_MORE') return 'BUY'
  return null
}

function productDisplayName(item) {
  const instrument = String(item?.instrument || '').trim()
  if (instrument) return instrument
  return String(item?.stockName || item?.symbol || '').split(' · ')[0]
}

function formatSignedWeight(value) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return '—'
  const sign = numeric * 100 > 0 ? '+' : ''
  return `${sign}${number.format(numeric * 100)}%`
}
