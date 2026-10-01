import {
  calculateDrawdown,
  calculateLeverageScenario,
  calculateTimeDecay,
  daysUntil,
  getOptionDirection,
} from './productCalculations.js'
import { clamp, finite, positive, round } from './numbers.js'
import { factorCarry, turboCarry, underlyingVolatility } from './carryCost.js'
import {
  CANDIDATE_STRATEGIES,
  STRATEGY_DEFINITIONS,
  allocateEqualWeight,
  candidateEligible,
  candidatePolicy,
  eligibleForAnyStrategy,
  modelQualityPenalty,
  productRiskPenalty,
  productRiskSignals,
  selectDiversified,
  strategyScores,
} from '../strategies/index.js'

export const PORTFOLIO_STRESS_HORIZONS = [0, 7, 30, 90]

export function buildStressScenarios(move = 20, targetGroup = null, paths = false) {
  const magnitude = clamp(Math.abs(finite(move) ?? 20), 1, 100)
  const scenarios = [-magnitude, -magnitude / 2, 0, magnitude / 2, magnitude].map((movePct, i) => ({
    id: i === 2 ? 'flat' : `shock_${i}`, label: `${targetGroup ? '单标的' : '同步'} ${movePct > 0 ? '+' : ''}${movePct}%`, movePct, targetGroup,
  }))
  if (paths) scenarios.push(
    { id: 'recovery', label: '先跌后恢复（两步路径）', movePct: 0, targetGroup, pathMoves: [-magnitude, 0] },
    { id: 'roundtrip', label: '先涨后回落（两步路径）', movePct: 0, targetGroup, pathMoves: [magnitude, 0] },
  )
  return scenarios
}

export const PORTFOLIO_STRESS_SCENARIOS = [
  { id: 'selloff_10', label: '普跌 -10%', movePct: -10 },
  { id: 'down_5', label: '回调 -5%', movePct: -5 },
  { id: 'flat', label: '横盘 0%', movePct: 0 },
  { id: 'up_5', label: '反弹 +5%', movePct: 5 },
  { id: 'rally_10', label: '普涨 +10%', movePct: 10 },
]

export function buildDirectPriceStress(positions = [], entries = []) {
  const quotes = new Map(entries.map(entry => [entry.item?.symbol, entry.item]))
  const value = positions.reduce((sum, p) => {
    if (p.valuationSource) return sum + (finite(p.marketValue) ?? 0)
    const price = positive(quotes.get(p.symbol)?.price) ?? positive(p.lastPrice)
    return sum + (price != null && positive(p.quantity) != null && p.assetClass !== 'BOND' ? price * p.quantity : positive(p.marketValue) ?? 0)
  }, 0)
  return [-20, -50, -100].map(movePct => ({ movePct, value: round(value), pnl: round(value * movePct / 100) }))
}

function impliedVolatilityPct(value) {
  const numeric = finite(value)
  if (numeric == null || numeric < 0) return null
  return round(numeric <= 1 ? numeric * 100 : numeric, 4)
}

function productName(item) {
  return String(item?.instrument || item?.stockName || item?.displayName || item?.symbol || '未知产品').trim()
}

function groupKey(entry) {
  return String(entry?.group?.key || entry?.group?.groupName || entry?.item?.underlying || entry?.item?.symbol || 'unknown')
}

function groupName(entry) {
  return String(entry?.group?.groupName || entry?.item?.underlying || entry?.item?.symbol || '未知标的')
}

function productType(item) {
  return String(item?.productType || '').toLowerCase()
}

function currentPositionValue(item) {
  const price = positive(item?.price)
  const quantity = positive(item?.quantity)
  return price != null && quantity != null ? price * quantity : positive(item?.marketValue) ?? 0
}

function underlyingLevelInEur(item, value) {
  const level = finite(value)
  if (level == null) return null
  if (String(item?.underlyingSpotRawCurrency || '').toUpperCase() !== 'USD') return level

  const explicitRate = positive(item?.underlyingSpotUsdEurRate ?? item?.usdEurRate)
  if (explicitRate != null) return level * explicitRate

  const rawSpot = positive(item?.underlyingSpotRaw)
  const eurSpot = positive(item?.underlyingSpot)
  if (rawSpot != null && eurSpot != null) return level * (eurSpot / rawSpot)
  return level
}

function calculationItem(entry) {
  const item = entry.item || {}
  return {
    ...item,
    strikePrice: underlyingLevelInEur(item, item.strikePrice),
    knockoutPrice: underlyingLevelInEur(item, item.knockoutPrice),
    daysToExpiry: entry.riskLeg?.daysToExpiry ?? item.daysToExpiry,
  }
}

function expiryIntrinsicPrice(item, scenarioSpot) {
  const strike = finite(item?.strikePrice)
  const ratio = positive(item?.ratio)
  const direction = getOptionDirection(item)
  if (strike == null || ratio == null || direction == null) return null
  if (direction === 'put') return Math.max(0, strike - scenarioSpot) * ratio
  return Math.max(0, scenarioSpot - strike) * ratio
}

function barrierBreached(item, scenarioSpot) {
  const knockout = positive(item?.knockoutPrice)
  const direction = getOptionDirection(item)
  if (knockout == null || direction == null) return false
  return direction === 'put' ? scenarioSpot >= knockout : scenarioSpot <= knockout
}

function productLeverage(entry) {
  const item = entry.item || {}
  return positive(item.leverage)
    ?? positive(item.effectiveLeverage)
    ?? positive(entry.riskLeg?.leverage)
    ?? positive(item.omega)
}

function leverageProjection(entry, scenario, currentPrice) {
  const direction = getOptionDirection(entry.item || {})
  const result = calculateLeverageScenario(
    currentPrice,
    productLeverage(entry) ?? 1,
    direction === 'put' ? 'put' : 'call',
    scenario.movePct,
  )
  return {
    projectedPrice: result?.projectedPrice ?? currentPrice,
    method: productLeverage(entry) == null ? 'leverage+default_leverage' : 'leverage',
  }
}

export function calculatePositionStress(entry, scenario, horizonDays) {
  if (scenario.targetGroup && scenario.targetGroup !== groupKey(entry)) {
    scenario = { ...scenario, movePct: 0, pathMoves: undefined }
  }
  const item = calculationItem(entry)
  const currentPrice = positive(item.price)
  const quantity = positive(item.quantity)
  const spot = positive(item.underlyingSpot)
  if (currentPrice == null || quantity == null || spot == null) return null

  const scenarioSpot = Math.max(0, spot * (1 + scenario.movePct / 100))
  const type = productType(item)
  const dte = entry.riskLeg?.daysToExpiry ?? daysUntil(item.expiry) ?? finite(item.daysToExpiry)
  let projectedPrice = currentPrice
  let method = 'unchanged'
  let breached = false
  const isTurbo = type === 'open_end_turbo' || type === 'knock_out'
  const carryDays = type === 'knock_out' && dte != null ? Math.min(horizonDays, dte) : horizonDays
  const financing = isTurbo ? turboCarry(item, productLeverage(entry), carryDays) : null
  const barrierItem = financing ? { ...item, knockoutPrice: financing.knockoutPrice } : item

  if (type === 'factor_certificate') {
    if (scenario.pathMoves?.length) {
      let previous = 100
      for (const move of scenario.pathMoves) {
        const next = Math.max(0, 100 + move)
        projectedPrice = leverageProjection(entry, { movePct: previous > 0 ? (next / previous - 1) * 100 : 0 }, projectedPrice).projectedPrice
        previous = next
      }
      method = 'factor_path'
    } else {
      const projection = leverageProjection(entry, scenario, currentPrice)
      projectedPrice = projection.projectedPrice
      method = 'factor_leverage'
    }
    if (productLeverage(entry) == null) method = `${method}+default_leverage`
    const { volatility, source } = underlyingVolatility(entry)
    const carry = factorCarry(item, productLeverage(entry) ?? 1, horizonDays, volatility)
    if (carry) {
      projectedPrice *= carry.multiplier
      method = `${method}+carry_${source}`
    }
  } else if (isTurbo && [scenario.movePct, ...(scenario.pathMoves || [])].some(move => barrierBreached(barrierItem, Math.max(0, spot * (1 + move / 100))))) {
    projectedPrice = 0
    method = 'knockout'
    breached = true
  } else if (type === 'optionsschein' && dte != null && dte <= horizonDays) {
    const intrinsic = expiryIntrinsicPrice(item, scenarioSpot)
    if (intrinsic == null) return null
    projectedPrice = intrinsic
    method = 'expiry_intrinsic'
  } else {
    // Anchor a flat shock to the observed quote even when inferred intrinsic
    // value and the asynchronously fetched spot do not agree.
    const movement = calculateDrawdown(item, scenario.movePct)
    if (movement) {
      projectedPrice = scenario.movePct === 0 ? currentPrice : movement.newPrice
      method = movement.method
    } else {
      const projection = leverageProjection(entry, scenario, currentPrice)
      projectedPrice = projection.projectedPrice
      method = projection.method
    }

    if (type === 'optionsschein' && horizonDays > 0) {
      const decay = calculateTimeDecay(item, horizonDays)
      if (decay) {
        projectedPrice = Math.max(0, projectedPrice + decay.priceChange)
        method = `${method}+${decay.method}`
      }
    }
    if (financing) {
      projectedPrice += financing.priceChange
      method = `${method}+financing`
    }
  }

  projectedPrice = Math.max(0, projectedPrice)
  const pnl = (projectedPrice - currentPrice) * quantity
  const currentValue = currentPositionValue(item)
  const returnPct = currentValue > 0 ? (pnl / currentValue) * 100 : 0

  return {
    scenarioId: scenario.id,
    scenarioLabel: scenario.label,
    movePct: scenario.movePct,
    currentPrice: round(currentPrice, 4),
    projectedPrice: round(projectedPrice, 4),
    currentValue: round(currentValue),
    pnl: round(pnl),
    returnPct: round(returnPct),
    scenarioSpot: round(scenarioSpot, 4),
    method,
    barrierBreached: breached,
  }
}

function buildProductProfile(entry, horizonDays, scenarios, portfolioTotals) {
  const results = scenarios
    .map((scenario) => calculatePositionStress(entry, scenario, horizonDays))
    .filter(Boolean)
  if (results.length !== scenarios.length) return null

  const currentValue = currentPositionValue(entry.item)
  if (currentValue <= 0) return null
  const costBasis = positive(entry.item?.costBasis) ?? 0
  const navWeightPct = portfolioTotals.totalMarketValue > 0
    ? (currentValue / portfolioTotals.totalMarketValue) * 100
    : 0
  const capitalWeightPct = portfolioTotals.totalCostBasis > 0
    ? (costBasis / portfolioTotals.totalCostBasis) * 100
    : 0
  const returns = results.map((result) => result.pnl / currentValue)
  const flat = results.find((result) => result.scenarioId === 'flat') || results[Math.floor(results.length / 2)]
  const worstReturn = Math.min(...returns)
  const bestReturn = Math.max(...returns)
  const meanReturn = returns.reduce((sum, value) => sum + value, 0) / returns.length
  const flatReturn = flat ? flat.pnl / currentValue : 0
  const riskSignals = productRiskSignals(entry)
  const modelPenalty = modelQualityPenalty(results)
  const riskPenalty = productRiskPenalty(entry, riskSignals) + modelPenalty

  return {
    id: String(entry.item?.symbol || entry.item?.id || productName(entry.item)),
    name: productName(entry.item),
    symbol: entry.item?.symbol || '',
    groupKey: groupKey(entry),
    groupName: groupName(entry),
    productType: entry.item?.productType || 'unknown',
    primaryAction: entry.primaryAction,
    riskStatus: entry.riskLeg?.legRiskStatus || 'N/A',
    confidence: entry.riskLeg?.exposureConfidence || 'no_data',
    delta: finite(entry.item?.delta),
    theta: finite(entry.item?.theta),
    ivPct: impliedVolatilityPct(entry.item?.iv),
    riskSignals,
    currentValue: round(currentValue),
    costBasis: round(costBasis),
    navWeightPct: round(navWeightPct),
    capitalWeightPct: round(capitalWeightPct),
    results,
    worstReturn,
    bestReturn,
    meanReturn,
    flatReturn,
    modelPenalty,
    riskPenalty,
    scores: strategyScores({ worstReturn, bestReturn, meanReturn, flatReturn, riskPenalty }),
  }
}

function aggregatePortfolio(id, title, description, profiles, scenarios, horizonDays, kind) {
  const currentValue = profiles.reduce((sum, profile) => sum + profile.currentValue, 0)
  const navWeightPct = profiles.reduce((sum, profile) => sum + profile.navWeightPct, 0)
  const capitalWeightPct = profiles.reduce((sum, profile) => sum + profile.capitalWeightPct, 0)
  const scenarioResults = scenarios.map((scenario) => {
    const productResults = profiles
      .map((profile) => ({ profile, result: profile.results.find((result) => result.scenarioId === scenario.id) }))
      .filter(({ result }) => Boolean(result))
    const pnl = productResults.reduce((sum, { result }) => sum + result.pnl, 0)
    return {
      ...scenario,
      pnl: round(pnl),
      returnPct: round(currentValue > 0 ? (pnl / currentValue) * 100 : 0),
      projectedValue: round(Math.max(0, currentValue + pnl)),
      barrierBreaches: productResults.filter(({ result }) => result.barrierBreached).length,
    }
  })

  const worst = scenarioResults.reduce((selected, result) => (result.pnl < selected.pnl ? result : selected), scenarioResults[0])
  const best = scenarioResults.reduce((selected, result) => (result.pnl > selected.pnl ? result : selected), scenarioResults[0])
  const flat = scenarioResults.find((result) => result.id === 'flat') || scenarioResults[Math.floor(scenarioResults.length / 2)]
  const positiveScenarioCount = scenarioResults.filter((result) => result.pnl > 0).length

  return {
    id,
    kind,
    title,
    description,
    horizonDays,
    currentValue: round(currentValue),
    navWeightPct: round(navWeightPct),
    capitalWeightPct: round(capitalWeightPct),
    shockProductCount: profiles.filter(profile => scenarios.some(scenario =>
      !scenario.targetGroup || scenario.targetGroup === profile.groupKey)).length,
    productCount: profiles.length,
    groupCount: new Set(profiles.map((profile) => profile.groupKey)).size,
    worstPnl: worst?.pnl ?? 0,
    worstReturnPct: worst?.returnPct ?? 0,
    worstScenarioLabel: worst?.label || '—',
    bestPnl: best?.pnl ?? 0,
    bestReturnPct: best?.returnPct ?? 0,
    bestScenarioLabel: best?.label || '—',
    flatPnl: flat?.pnl ?? 0,
    scenarioCoveragePct: round((positiveScenarioCount / scenarioResults.length) * 100, 0),
    scenarioResults,
    products: profiles.map((profile) => ({
      id: profile.id,
      name: profile.name,
      symbol: profile.symbol,
      groupKey: profile.groupKey,
      groupName: profile.groupName,
      productType: profile.productType,
      primaryAction: profile.primaryAction,
      riskStatus: profile.riskStatus,
      confidence: profile.confidence,
      delta: profile.delta,
      theta: profile.theta,
      ivPct: profile.ivPct,
      daysToExpiry: profile.riskSignals.daysToExpiry,
      currentValue: round(profile.currentValue),
      allocationPct: round(currentValue > 0 ? (profile.currentValue / currentValue) * 100 : 0),
      navWeightPct: profile.navWeightPct,
      capitalWeightPct: profile.capitalWeightPct,
      positionScalePct: profile.positionScalePct ?? 100,
      selectionFlags: profile.selectionFlags || [],
      scenarioPnls: profile.results.map(result => ({ scenarioId: result.scenarioId, pnl: result.pnl })),
      scenarioMethods: profile.results.map((result) => ({
        scenarioId: result.scenarioId,
        method: result.method,
      })),
    })),
  }
}

export function buildPortfolioStressReport(
  entries,
  horizonDays = 30,
  scenarios = PORTFOLIO_STRESS_SCENARIOS,
  portfolioTotals = {},
) {
  const horizon = PORTFOLIO_STRESS_HORIZONS.includes(Number(horizonDays)) ? Number(horizonDays) : 30
  const totals = {
    totalMarketValue: positive(portfolioTotals?.totalMarketValue) ?? 0,
    totalCostBasis: positive(portfolioTotals?.totalCostBasis) ?? 0,
  }
  const inputEntries = Array.isArray(entries) ? entries : []
  if (portfolioTotals.positions?.length) {
    totals.totalMarketValue = buildDirectPriceStress(portfolioTotals.positions, inputEntries)[0].value
  }
  const inputValue = inputEntries.reduce((sum, entry) => sum + currentPositionValue(entry.item), 0)
  // Rank against a fixed reference, independent of the optional stress controls.
  // Require expiry inputs up front so changing the horizon cannot remove members.
  const profiles = inputEntries.map((entry) => {
    const profile = buildProductProfile(entry, 30, PORTFOLIO_STRESS_SCENARIOS, totals)
    if (!profile || !calculatePositionStress(entry, { id: 'flat', movePct: 0 }, 90)) return null
    return {
      ...profile,
      results: scenarios.map((scenario) => calculatePositionStress(entry, scenario, horizon)),
    }
  }).filter(Boolean)
  const coveredValue = profiles.reduce((sum, profile) => sum + profile.currentValue, 0)
  const coverage = {
    coveredValue: round(coveredValue),
    omittedCount: inputEntries.length - profiles.length,
    omittedValue: round(Math.max(0, inputValue - coveredValue)),
    accountValue: round(totals.totalMarketValue),
    coveragePct: round(totals.totalMarketValue > 0 ? coveredValue / totals.totalMarketValue * 100 : 0),
    outsideValue: round(Math.max(0, totals.totalMarketValue - coveredValue)),
    omitted: inputEntries.filter(entry => !profiles.some(p => p.id === String(entry.item?.symbol || entry.item?.id || productName(entry.item)))).map(entry => ({ name: productName(entry.item), value: round(currentPositionValue(entry.item)), reason: '缺少有效报价、数量、标的价格或到期支付参数' })),
  }
  const candidatePools = Object.fromEntries(CANDIDATE_STRATEGIES.map((strategy) => [
    strategy,
    profiles.filter((profile) => candidateEligible(profile, strategy)),
  ]))
  const eligible = profiles.filter(eligibleForAnyStrategy)
  const excluded = profiles.filter((profile) => !eligibleForAnyStrategy(profile))
  const rollOpportunities = profiles
    .filter((profile) => candidatePolicy(profile).excludedReason === 'roll_current_contract')
    .map((profile) => ({
      id: profile.id,
      name: profile.name,
      groupName: profile.groupName,
      daysToExpiry: profile.riskSignals.daysToExpiry,
    }))

  if (!profiles.length) {
    return {
      modelMode: 'stress_only',
      horizonDays: horizon,
      scenarios,
      portfolios: [],
      coverage,
      productCount: 0,
      eligibleProductCount: 0,
      excludedProductCount: 0,
      watchIncludedProductCount: 0,
      exposureCappedProductCount: 0,
      rollOpportunities: [],
    }
  }

  const candidates = [
    aggregatePortfolio(
      'current',
      '当前监控基准',
      '保留全部可计算 Tier 1 仓位，用于对比候选组合。',
      profiles,
      scenarios,
      horizon,
      'baseline',
    ),
  ]

  for (const definition of STRATEGY_DEFINITIONS) {
    const selected = selectDiversified(
      candidatePools[definition.strategy],
      definition.strategy,
      definition.limit,
    )
    if (selected.length) {
      candidates.push(aggregatePortfolio(
        definition.id,
        definition.title,
        definition.description,
        allocateEqualWeight(selected, coveredValue, totals),
        scenarios,
        horizon,
        definition.strategy,
      ))
    }
  }

  return {
    modelMode: 'stress_only',
    coverage,
    horizonDays: horizon,
    scenarios,
    portfolios: candidates.map(candidate => ({
      ...candidate,
      cashValue: round(Math.max(0, coveredValue - candidate.currentValue)),
      scenarioResults: candidate.scenarioResults.map(result => ({ ...result, accountImpactPct: round(totals.totalMarketValue > 0 ? result.pnl / totals.totalMarketValue * 100 : 0), testedCapitalReturnPct: round(coveredValue > 0 ? result.pnl / coveredValue * 100 : 0) })),
    })),
    productCount: profiles.length,
    eligibleProductCount: eligible.length,
    excludedProductCount: excluded.length,
    watchIncludedProductCount: eligible.filter((profile) => profile.riskStatus === 'WATCH').length,
    exposureCappedProductCount: eligible.filter((profile) => profile.riskSignals.isOverexposed).length,
    rollOpportunities,
  }
}

export function buildHermesStressReviewPayload(report) {
  return {
    modelMode: report.modelMode,
    horizonDays: report.horizonDays,
    portfolios: report.portfolios.slice(0, 8).map((portfolio) => ({
      id: portfolio.id,
      title: portfolio.title,
      description: `Tested capital EUR ${report.coverage?.coveredValue ?? portfolio.currentValue}; cash EUR ${portfolio.cashValue ?? 0}; untested EUR ${report.coverage?.outsideValue ?? 0}. Returns use tested capital incl cash. Paths: two reset steps then flat; options endpoint only.`,
      productCount: portfolio.productCount,
      groupCount: portfolio.groupCount,
      currentValue: report.coverage?.coveredValue ?? portfolio.currentValue,
      worstPnl: portfolio.worstPnl,
      worstReturnPct: Math.min(...portfolio.scenarioResults.map(s => s.testedCapitalReturnPct ?? s.returnPct)),
      bestPnl: portfolio.bestPnl,
      bestReturnPct: Math.max(...portfolio.scenarioResults.map(s => s.testedCapitalReturnPct ?? s.returnPct)),
      flatPnl: portfolio.flatPnl,
      scenarioCoveragePct: portfolio.scenarioCoveragePct,
      navWeightPct: portfolio.navWeightPct,
      capitalWeightPct: portfolio.capitalWeightPct,
      scenarios: portfolio.scenarioResults.map((scenario) => ({
        id: scenario.id,
        label: scenario.label,
        movePct: scenario.movePct,
        pnl: scenario.pnl,
        returnPct: scenario.testedCapitalReturnPct ?? scenario.returnPct,
        barrierBreaches: scenario.barrierBreaches,
      })),
      products: portfolio.products.slice(0, 20).map((product) => ({
        id: product.id,
        name: product.name,
        groupName: product.groupName,
        productType: product.productType,
        primaryAction: product.primaryAction,
        riskStatus: product.riskStatus,
        confidence: product.confidence,
        delta: product.delta,
        theta: product.theta,
        ivPct: product.ivPct,
        daysToExpiry: product.daysToExpiry,
        allocationPct: round(report.coverage?.coveredValue > 0 ? product.currentValue / report.coverage.coveredValue * 100 : product.allocationPct),
        navWeightPct: product.navWeightPct,
        capitalWeightPct: product.capitalWeightPct,
        positionScalePct: product.positionScalePct,
        selectionFlags: product.selectionFlags,
        scenarioMethods: product.scenarioMethods,
      })),
    })),
  }
}
