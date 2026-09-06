import {
  calculateDrawdown,
  calculateLeverageScenario,
  calculateTimeDecay,
  daysUntil,
  getOptionDirection,
} from './productCalculations.js'

export const PORTFOLIO_STRESS_HORIZONS = [7, 30, 90]

export const PORTFOLIO_STRESS_SCENARIOS = [
  { id: 'selloff_10', label: '普跌 -10%', movePct: -10 },
  { id: 'down_5', label: '回调 -5%', movePct: -5 },
  { id: 'flat', label: '横盘 0%', movePct: 0 },
  { id: 'up_5', label: '反弹 +5%', movePct: 5 },
  { id: 'rally_10', label: '普涨 +10%', movePct: 10 },
]

const CONFIDENCE_PENALTIES = {
  live_delta: 0,
  estimated_delta: 0.02,
  estimated_omega: 0.04,
  estimated_leverage: 0.06,
  estimated_market_value: 0.10,
  no_data: 0.25,
}

const CANDIDATE_STRATEGIES = ['defensive', 'balanced', 'elastic']
const WATCH_DATA_SCORE_THRESHOLD = 6
const WATCH_BARRIER_DISTANCE = 0.10
const MAX_PRODUCT_EXPOSURE_WEIGHT = 0.08

function finite(value) {
  if (value === null || value === undefined || value === '') return null
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : null
}

function positive(value) {
  const numeric = finite(value)
  return numeric != null && numeric > 0 ? numeric : null
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value))
}

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return 0
  const factor = 10 ** digits
  return Math.round((value + Number.EPSILON) * factor) / factor
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
  const explicit = positive(item?.marketValue)
  if (explicit != null) return explicit
  const price = positive(item?.price)
  const quantity = positive(item?.quantity)
  return price != null && quantity != null ? price * quantity : 0
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

function leverageProjection(entry, scenario, currentPrice) {
  const item = entry.item || {}
  const direction = getOptionDirection(item)
  const leverage = positive(item.leverage)
    ?? positive(item.effectiveLeverage)
    ?? positive(entry.riskLeg?.leverage)
    ?? positive(item.omega)
    ?? 1
  const result = calculateLeverageScenario(
    currentPrice,
    leverage,
    direction === 'put' ? 'put' : 'call',
    scenario.movePct,
  )
  return {
    projectedPrice: result?.projectedPrice ?? currentPrice,
    method: 'leverage',
  }
}

export function calculatePositionStress(entry, scenario, horizonDays) {
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

  if (type === 'factor_certificate') {
    const projection = leverageProjection(entry, scenario, currentPrice)
    projectedPrice = projection.projectedPrice
    method = 'factor_leverage'
  } else if ((type === 'open_end_turbo' || type === 'knock_out') && barrierBreached(item, scenarioSpot)) {
    projectedPrice = 0
    method = 'knockout'
    breached = true
  } else if (type === 'optionsschein' && dte != null && dte <= horizonDays) {
    const intrinsic = expiryIntrinsicPrice(item, scenarioSpot)
    if (intrinsic == null) return null
    projectedPrice = intrinsic
    method = 'expiry_intrinsic'
  } else {
    const movement = calculateDrawdown(item, scenario.movePct)
    if (movement) {
      projectedPrice = movement.newPrice
      method = movement.method
    } else {
      const projection = leverageProjection(entry, scenario, currentPrice)
      projectedPrice = projection.projectedPrice
      method = projection.method
    }

    if (type === 'optionsschein') {
      const decay = calculateTimeDecay(item, horizonDays)
      if (decay) {
        projectedPrice = Math.max(0, projectedPrice + decay.priceChange)
        method = `${method}+${decay.method}`
      }
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

function productRiskSignals(entry) {
  const confidence = entry.riskLeg?.exposureConfidence || 'no_data'
  const completenessScore = finite(entry.riskLeg?.dataCompletenessRiskScore) ?? 10
  const daysToExpiry = finite(entry.riskLeg?.daysToExpiry)
  const barrierDistancePct = finite(entry.riskLeg?.barrierDistancePct)
  const exposureWeightPct = finite(entry.riskLeg?.exposureWeightPct)
  return {
    riskStatus: entry.riskLeg?.legRiskStatus || 'N/A',
    confidence,
    completenessScore,
    daysToExpiry,
    barrierDistancePct,
    exposureWeightPct,
    isRoll: entry.primaryAction === 'ROLL'
      || (daysToExpiry != null && daysToExpiry >= 0 && daysToExpiry < 7),
    hasUntrustedData: confidence === 'no_data' || completenessScore >= WATCH_DATA_SCORE_THRESHOLD,
    isNearBarrier: barrierDistancePct != null && barrierDistancePct < WATCH_BARRIER_DISTANCE,
    isOverexposed: exposureWeightPct != null && exposureWeightPct > MAX_PRODUCT_EXPOSURE_WEIGHT,
  }
}

function productRiskPenalty(entry, signals) {
  const completeness = clamp(signals.completenessScore / 10, 0, 1)
  const confidencePenalty = CONFIDENCE_PENALTIES[signals.confidence] ?? 0.12
  const actionPenalty = entry.primaryAction === 'HOLD' ? 0.02 : entry.primaryAction === 'BUY' ? 0 : 0.20
  const concentrationPenalty = entry.riskGroup?.groupActionLabel === 'REDUCE_CONCENTRATION' ? 0.08 : 0
  const watchPenalty = signals.riskStatus === 'WATCH' ? 0.05 : 0
  const barrierPenalty = signals.isNearBarrier ? 0.10 : 0
  const exposurePenalty = signals.isOverexposed ? 0.08 : 0
  return confidencePenalty
    + completeness * 0.08
    + actionPenalty
    + concentrationPenalty
    + watchPenalty
    + barrierPenalty
    + exposurePenalty
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
  const riskSignals = productRiskSignals(entry)
  const riskPenalty = productRiskPenalty(entry, riskSignals)

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
    flatReturn: flat ? flat.pnl / currentValue : 0,
    riskPenalty,
    scores: {
      defensive: worstReturn + (flat ? flat.pnl / currentValue : 0) * 0.15 - riskPenalty,
      balanced: meanReturn + worstReturn * 0.45 - riskPenalty,
      elastic: bestReturn - Math.abs(worstReturn) * 0.25 - riskPenalty,
    },
  }
}

function candidatePolicy(profile) {
  const signals = profile.riskSignals
  if (profile.riskStatus === 'HARD_BLOCKED') {
    return { eligibleStrategies: [], excludedReason: 'hard_blocked' }
  }
  if (signals.isRoll) {
    return { eligibleStrategies: [], excludedReason: 'roll_current_contract' }
  }
  if (signals.hasUntrustedData) {
    return { eligibleStrategies: [], excludedReason: 'untrusted_data' }
  }
  if (profile.primaryAction === 'SELL' && profile.riskStatus !== 'WATCH') {
    return { eligibleStrategies: [], excludedReason: 'sell' }
  }
  if (profile.riskStatus === 'WATCH' && signals.isNearBarrier) {
    return { eligibleStrategies: ['elastic'], excludedReason: null }
  }
  return { eligibleStrategies: CANDIDATE_STRATEGIES, excludedReason: null }
}

function candidateEligible(profile, strategy) {
  return candidatePolicy(profile).eligibleStrategies.includes(strategy)
}

function sizeCandidateProfile(profile) {
  const exposureWeight = profile.riskSignals.exposureWeightPct
  const positionScale = profile.riskSignals.isOverexposed
    ? clamp(MAX_PRODUCT_EXPOSURE_WEIGHT / exposureWeight, 0, 1)
    : 1
  const selectionFlags = []
  if (profile.riskStatus === 'WATCH') selectionFlags.push('WATCH_PENALIZED')
  if (profile.riskSignals.isNearBarrier) selectionFlags.push('ELASTIC_ONLY')
  if (positionScale < 1) selectionFlags.push('EXPOSURE_CAPPED_8_PCT')

  if (positionScale >= 1) {
    return { ...profile, positionScalePct: 100, selectionFlags }
  }
  return {
    ...profile,
    currentValue: round(profile.currentValue * positionScale),
    costBasis: round(profile.costBasis * positionScale),
    navWeightPct: round(profile.navWeightPct * positionScale),
    capitalWeightPct: round(profile.capitalWeightPct * positionScale),
    results: profile.results.map((result) => ({
      ...result,
      currentValue: round(result.currentValue * positionScale),
      pnl: round(result.pnl * positionScale),
    })),
    positionScalePct: round(positionScale * 100),
    selectionFlags,
  }
}

function selectDiversified(profiles, score, limit) {
  const ranked = [...profiles].sort((left, right) => right.scores[score] - left.scores[score])
  const selected = []
  const usedGroups = new Set()

  for (const profile of ranked) {
    if (selected.length >= limit) break
    if (usedGroups.has(profile.groupKey)) continue
    selected.push(profile)
    usedGroups.add(profile.groupKey)
  }

  if (selected.length < Math.min(3, limit)) {
    for (const profile of ranked) {
      if (selected.length >= limit) break
      if (selected.some((item) => item.id === profile.id)) continue
      selected.push(profile)
    }
  }
  return selected
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
      groupName: profile.groupName,
      productType: profile.productType,
      primaryAction: profile.primaryAction,
      riskStatus: profile.riskStatus,
      confidence: profile.confidence,
      delta: profile.delta,
      theta: profile.theta,
      ivPct: profile.ivPct,
      daysToExpiry: profile.riskSignals.daysToExpiry,
      currentValue: profile.currentValue,
      allocationPct: round(currentValue > 0 ? (profile.currentValue / currentValue) * 100 : 0),
      navWeightPct: profile.navWeightPct,
      capitalWeightPct: profile.capitalWeightPct,
      positionScalePct: profile.positionScalePct ?? 100,
      selectionFlags: profile.selectionFlags || [],
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
  const profiles = (Array.isArray(entries) ? entries : [])
    .map((entry) => buildProductProfile(entry, horizon, scenarios, totals))
    .filter(Boolean)
  const candidatePools = Object.fromEntries(CANDIDATE_STRATEGIES.map((strategy) => [
    strategy,
    profiles.filter((profile) => candidateEligible(profile, strategy)).map(sizeCandidateProfile),
  ]))
  const eligible = profiles.filter((profile) => CANDIDATE_STRATEGIES.some((strategy) => candidateEligible(profile, strategy)))
  const excluded = profiles.filter((profile) => !CANDIDATE_STRATEGIES.some((strategy) => candidateEligible(profile, strategy)))
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
      `current-${horizon}`,
      '当前监控基准',
      '保留全部可计算 Tier 1 仓位，用于对比候选组合。',
      profiles,
      scenarios,
      horizon,
      'baseline',
    ),
  ]

  const strategyCandidates = [
    {
      strategy: 'defensive',
      id: `defensive-${horizon}`,
      title: '稳健组合',
      description: '优先控制双向压力下的最差损失；WATCH 按原因降权，集中仓位按风险敞口限制。',
      limit: 5,
    },
    {
      strategy: 'balanced',
      id: `balanced-${horizon}`,
      title: '均衡组合',
      description: '兼顾五档情景表现、最差损失和数据可信度，对 WATCH 保持风险扣分。',
      limit: 8,
    },
    {
      strategy: 'elastic',
      id: `elastic-${horizon}`,
      title: '高弹性组合',
      description: '提高有利情景收益；可纳入临近障碍的 WATCH 仓位，但会大幅降权并保留归零压力。',
      limit: 6,
    },
  ]
  for (const definition of strategyCandidates) {
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
        selected,
        scenarios,
        horizon,
        definition.strategy,
      ))
    }
  }

  return {
    modelMode: 'stress_only',
    horizonDays: horizon,
    scenarios,
    portfolios: candidates,
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
      description: portfolio.description,
      productCount: portfolio.productCount,
      groupCount: portfolio.groupCount,
      currentValue: portfolio.currentValue,
      worstPnl: portfolio.worstPnl,
      worstReturnPct: portfolio.worstReturnPct,
      bestPnl: portfolio.bestPnl,
      bestReturnPct: portfolio.bestReturnPct,
      flatPnl: portfolio.flatPnl,
      scenarioCoveragePct: portfolio.scenarioCoveragePct,
      navWeightPct: portfolio.navWeightPct,
      capitalWeightPct: portfolio.capitalWeightPct,
      scenarios: portfolio.scenarioResults.map((scenario) => ({
        id: scenario.id,
        label: scenario.label,
        movePct: scenario.movePct,
        pnl: scenario.pnl,
        returnPct: scenario.returnPct,
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
        allocationPct: product.allocationPct,
        navWeightPct: product.navWeightPct,
        capitalWeightPct: product.capitalWeightPct,
        positionScalePct: product.positionScalePct,
        selectionFlags: product.selectionFlags,
        scenarioMethods: product.scenarioMethods,
      })),
    })),
  }
}
