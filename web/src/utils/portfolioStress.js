import {
  calculateDrawdown,
  calculateLeverageScenario,
  calculateTimeDecay,
  daysUntil,
  getOptionDirection,
} from './productCalculations.js'
import { clamp, finite, positive, round } from './numbers.js'
import { factorCarry, median, referenceRate, turboCarry, underlyingVolatility, volatilityFraction } from './carryCost.js'
import { IMPLIED_VOLATILITY_RANGE, blackScholesPrice, impliedVolatility } from './optionPricing.js'
import { MODEL_FALLBACK_THRESHOLD, modelQualityPenalty } from './modelQuality.js'

export const PORTFOLIO_STRESS_HORIZONS = [0, 7, 30, 90]

export const GROUP_SHOCK_SCALE_RANGE = [0.4, 2.5]

// Options: groupScales multiplies the move per underlying (ignored for a single
// target), ivMovePct shifts warrant volatility relatively, fxMovePct moves USD
// against EUR, and adverse adds the scenario where every underlying takes the
// endpoint move that hurts the portfolio most.
export function buildStressScenarios(move = 20, targetGroup = null, paths = false, options = {}) {
  const magnitude = clamp(Math.abs(finite(move) ?? 20), 1, 100)
  const groupScales = !targetGroup && options.groupScales ? options.groupScales : null
  const shared = {
    targetGroup,
    ...(groupScales ? { groupScales } : {}),
    ...(finite(options.ivMovePct) ? { ivMovePct: finite(options.ivMovePct) } : {}),
    ...(finite(options.fxMovePct) ? { fxMovePct: finite(options.fxMovePct) } : {}),
  }
  const prefix = targetGroup ? '单标的' : groupScales ? '按波动率' : '同步'
  const scenarios = [-magnitude, -magnitude / 2, 0, magnitude / 2, magnitude].map((movePct, i) => ({
    id: i === 2 ? 'flat' : `shock_${i}`, label: `${prefix} ${movePct > 0 ? '+' : ''}${movePct}%`, movePct, ...shared,
  }))
  if (paths) scenarios.push(
    { id: 'recovery', label: '先跌后恢复（两步路径）', movePct: 0, ...shared, pathMoves: [-magnitude, 0] },
    { id: 'roundtrip', label: '先涨后回落（两步路径）', movePct: 0, ...shared, pathMoves: [magnitude, 0] },
  )
  if (options.adverse && !targetGroup) scenarios.push(
    { id: 'adverse', label: `各标的逆向 ±${magnitude}%`, movePct: 0, ...shared, adverse: true },
  )
  return scenarios
}

// Scales each underlying's shock by its implied volatility relative to the
// median underlying, so the stated magnitude is the move of a typical holding.
// Underlyings without any warrant IV keep the stated magnitude.
export function buildGroupShockScales(entries = []) {
  const groups = new Map()
  for (const entry of Array.isArray(entries) ? entries : []) {
    const key = groupKey(entry)
    const group = groups.get(key) ?? { key, name: groupName(entry), volatilities: new Map() }
    groups.set(key, group)
    for (const row of [entry.item, ...(entry.group?.derivatives || [])]) {
      const volatility = volatilityFraction(row?.iv)
      if (volatility != null) group.volatilities.set(row.symbol ?? row.id ?? group.volatilities.size, volatility)
    }
  }
  const rows = [...groups.values()].map(({ key, name, volatilities }) => ({ key, name, volatility: median([...volatilities.values()]) }))
  const reference = median(rows.map(row => row.volatility).filter(value => value != null))
  const [minimum, maximum] = GROUP_SHOCK_SCALE_RANGE
  const scaled = rows.map(row => ({
    key: row.key,
    name: row.name,
    volatilityPct: row.volatility != null ? round(row.volatility * 100, 1) : null,
    scale: row.volatility != null && reference ? round(clamp(row.volatility / reference, minimum, maximum), 4) : 1,
  }))
  return {
    referenceVolatilityPct: reference != null ? round(reference * 100, 1) : null,
    unknownCount: scaled.filter(row => row.volatilityPct == null).length,
    groups: scaled,
    scales: Object.fromEntries(scaled.map(row => [row.key, row.scale])),
  }
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

export function groupKey(entry) {
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

export function calculationItem(entry) {
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

function usdUnderlying(item) {
  return String(item?.underlyingSpotRawCurrency || '').toUpperCase() === 'USD'
}

// Volatility for pricing a warrant, calibrated to the observed quote. Deep in
// the money a small quote/spot mismatch calibrates to an absurd volatility, so
// a result more than 2x away from the provider IV, or no result at all, hands
// over to the provider IV. `item` carries strike and spot in one currency.
export function warrantVolatility(item, currentPrice, spot, dte) {
  const strike = positive(item?.strikePrice)
  const ratio = positive(item?.ratio)
  const direction = getOptionDirection(item)
  if (strike == null || ratio == null || direction == null || !(currentPrice > 0) || !(spot > 0) || !(dte > 0)) return null

  const rate = referenceRate(item)
  const years = dte / 365
  const [minimum, maximum] = IMPLIED_VOLATILITY_RANGE
  const quoted = volatilityFraction(item?.iv)
  const provider = quoted != null && quoted >= minimum && quoted <= maximum ? quoted : null
  const implied = impliedVolatility({ price: currentPrice / ratio, spot, strike, years, rate, direction })
  const calibrated = implied != null && (provider == null || (implied >= provider / 2 && implied <= provider * 2)) ? implied : null
  const volatility = calibrated ?? provider
  return volatility == null ? null : { volatility, calibrated: calibrated != null, strike, ratio, direction, rate, years }
}

// Full Black-Scholes revaluation of a warrant that outlives the horizon. The
// model change is added to the quote, so an unchanged scenario returns the
// quote; when the model value exceeds the quote the change is scaled down to
// the quote's size, which keeps a mismatched ratio or stale spot from wiping
// out the position.
function repriceWarrant(item, scenario, currentPrice, spot, scenarioSpot, dte, horizonDays) {
  if (dte == null || dte <= horizonDays) return null
  const model = warrantVolatility(item, currentPrice, spot, dte)
  if (!model) return null
  const { volatility, strike, ratio, direction, rate, years } = model

  const shocked = Math.max(0.01, volatility * (1 + (finite(scenario.ivMovePct) ?? 0) / 100))
  const base = blackScholesPrice({ spot, strike, years, volatility, rate, direction })
  const next = blackScholesPrice({ spot: scenarioSpot, strike, years: (dte - horizonDays) / 365, volatility: shocked, rate, direction })
  const anchor = base * ratio > currentPrice ? currentPrice / (base * ratio) : 1
  return {
    projectedPrice: Math.max(0, currentPrice + (next - base) * ratio * anchor),
    method: model.calibrated ? 'bs' : 'bs_iv',
  }
}

function barrierBreached(item, scenarioSpot) {
  const knockout = positive(item?.knockoutPrice)
  const direction = getOptionDirection(item)
  if (knockout == null || direction == null) return false
  return direction === 'put' ? scenarioSpot >= knockout : scenarioSpot <= knockout
}

export function productLeverage(entry) {
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
  const scale = positive(scenario.groupScales?.[groupKey(entry)])
  if (scale != null && scale !== 1) {
    scenario = { ...scenario, movePct: scenario.movePct * scale, pathMoves: scenario.pathMoves?.map(move => move * scale) }
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
  const repriced = type === 'optionsschein'
    ? repriceWarrant(item, scenario, currentPrice, spot, scenarioSpot, dte, horizonDays)
    : null

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
  } else if (repriced) {
    projectedPrice = repriced.projectedPrice
    method = repriced.method
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

  // The payoff of a USD underlying converts to EUR at the shocked rate.
  const fxMovePct = finite(scenario.fxMovePct) ?? 0
  if (fxMovePct && usdUnderlying(item)) projectedPrice *= Math.max(0, 1 + fxMovePct / 100)

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
  const daysToExpiry = finite(entry.riskLeg?.daysToExpiry)

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
    fxExposed: usdUnderlying(entry.item),
    daysToExpiry,
    // The current contract is about to end, whatever is done with the exposure.
    isRoll: entry.primaryAction === 'ROLL' || (daysToExpiry != null && daysToExpiry >= 0 && daysToExpiry < 7),
    currentValue: round(currentValue),
    costBasis: round(costBasis),
    navWeightPct: round(navWeightPct),
    capitalWeightPct: round(capitalWeightPct),
    results,
    modelPenalty: modelQualityPenalty(results),
  }
}

// For each adverse scenario, every underlying takes the endpoint move that
// costs this portfolio most, so opposite positions on different underlyings no
// longer offset. The choice depends on the portfolio's own sizing.
function withAdverseResults(profiles, scenarios) {
  const adverse = scenarios.filter(scenario => scenario.adverse)
  if (!adverse.length) return profiles
  const endpointIds = scenarios.filter(scenario => !scenario.adverse && !scenario.pathMoves?.length).map(scenario => scenario.id)
  const groupPnl = new Map()
  for (const profile of profiles) {
    const totals = groupPnl.get(profile.groupKey) ?? new Map()
    groupPnl.set(profile.groupKey, totals)
    for (const result of profile.results) {
      if (result && endpointIds.includes(result.scenarioId)) totals.set(result.scenarioId, (totals.get(result.scenarioId) ?? 0) + result.pnl)
    }
  }
  const worstId = new Map([...groupPnl].map(([key, totals]) => [
    key,
    endpointIds.reduce((selected, id) => (totals.get(id) ?? 0) < (totals.get(selected) ?? 0) ? id : selected, endpointIds[0]),
  ]))
  return profiles.map(profile => {
    const source = profile.results.find(result => result?.scenarioId === worstId.get(profile.groupKey))
    return {
      ...profile,
      results: [...profile.results, ...(source ? adverse.map(scenario => ({ ...source, scenarioId: scenario.id, scenarioLabel: scenario.label })) : [])],
    }
  })
}

function aggregatePortfolio(id, title, description, inputProfiles, scenarios, horizonDays, kind) {
  const profiles = withAdverseResults(inputProfiles, scenarios)
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
      daysToExpiry: profile.daysToExpiry,
      currentValue: round(profile.currentValue),
      allocationPct: round(currentValue > 0 ? (profile.currentValue / currentValue) * 100 : 0),
      navWeightPct: profile.navWeightPct,
      capitalWeightPct: profile.capitalWeightPct,
      positionScalePct: profile.positionScalePct ?? 100,
      selectionFlags: profile.modelPenalty >= MODEL_FALLBACK_THRESHOLD ? ['MODEL_FALLBACK'] : [],
      fxExposed: profile.fxExposed,
      scenarioPnls: profile.results.map(result => ({ scenarioId: result.scenarioId, pnl: result.pnl, movePct: round(result.movePct) })),
      scenarioMethods: profile.results.map((result) => ({
        scenarioId: result.scenarioId,
        method: result.method,
      })),
    })),
  }
}

// Scales a position and everything derived from its size.
function scaleProfile(profile, scale, totals) {
  const costBasis = profile.costBasis * scale
  return {
    ...profile,
    // Unrounded so the plan's total matches the capital it keeps invested exactly.
    currentValue: profile.currentValue * scale,
    costBasis: round(costBasis),
    navWeightPct: round(profile.navWeightPct * scale),
    capitalWeightPct: round(totals.totalCostBasis > 0 ? costBasis / totals.totalCostBasis * 100 : 0),
    results: profile.results.map((result) => ({
      ...result,
      currentValue: round(result.currentValue * scale),
      pnl: round(result.pnl * scale),
    })),
    positionScalePct: round(scale * 100),
  }
}

// A plan trims the current holdings: `reductions` maps a product id to the
// percentage sold. The proceeds stay in the plan as zero-return cash and a
// product sold completely leaves it.
function applyReductions(profiles, reductions = {}, totals) {
  return profiles.flatMap((profile) => {
    const reductionPct = clamp(finite(reductions[profile.id]) ?? 0, 0, 100)
    if (reductionPct >= 100) return []
    if (reductionPct <= 0) return [profile]
    return [scaleProfile(profile, 1 - reductionPct / 100, totals)]
  })
}

// Compares the current holdings with `options.plans`
// ([{ id, title, description, reductions }]).
export function buildPortfolioStressReport(
  entries,
  horizonDays = 30,
  scenarios = PORTFOLIO_STRESS_SCENARIOS,
  portfolioTotals = {},
  options = {},
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
  // A product is covered when the fixed reference scenarios and a 90-day flat
  // scenario can all be priced, so changing the stress controls or the horizon
  // cannot add or remove members.
  const profiles = inputEntries.map((entry) => {
    const profile = buildProductProfile(entry, 30, PORTFOLIO_STRESS_SCENARIOS, totals)
    if (!profile || !calculatePositionStress(entry, { id: 'flat', movePct: 0 }, 90)) return null
    return {
      ...profile,
      results: scenarios.filter(scenario => !scenario.adverse).map((scenario) => calculatePositionStress(entry, scenario, horizon)),
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
  const rollOpportunities = profiles
    .filter(profile => profile.isRoll)
    .map((profile) => ({
      id: profile.id,
      name: profile.name,
      groupName: profile.groupName,
      daysToExpiry: profile.daysToExpiry,
    }))

  if (!profiles.length) {
    return {
      modelMode: 'stress_only',
      horizonDays: horizon,
      scenarios,
      portfolios: [],
      coverage,
      productCount: 0,
      rollOpportunities: [],
    }
  }

  const portfolios = [
    aggregatePortfolio(
      'current',
      '当前监控基准',
      '全部可计算的 Tier 1 仓位，作为各减仓方案的比较起点。',
      profiles,
      scenarios,
      horizon,
      'baseline',
    ),
  ]

  for (const plan of options.plans || []) {
    portfolios.push(aggregatePortfolio(
      String(plan.id),
      plan.title,
      plan.description || '',
      applyReductions(profiles, plan.reductions, totals),
      scenarios,
      horizon,
      'plan',
    ))
  }

  return {
    modelMode: 'stress_only',
    coverage,
    horizonDays: horizon,
    scenarios,
    portfolios: portfolios.map(portfolio => ({
      ...portfolio,
      cashValue: round(Math.max(0, coveredValue - portfolio.currentValue)),
      scenarioResults: portfolio.scenarioResults.map(result => ({ ...result, accountImpactPct: round(totals.totalMarketValue > 0 ? result.pnl / totals.totalMarketValue * 100 : 0), testedCapitalReturnPct: round(coveredValue > 0 ? result.pnl / coveredValue * 100 : 0) })),
    })),
    productCount: profiles.length,
    rollOpportunities,
  }
}

const signed = value => `${value > 0 ? '+' : ''}${value}%`

// The product list sent to Hermes is truncated, so each plan states its size here.
function planSummaries(report) {
  const baseline = report.portfolios.find(portfolio => portfolio.kind === 'baseline')
  return report.portfolios.filter(portfolio => portfolio.kind === 'plan').slice(0, 7).map((portfolio) => {
    const reduced = portfolio.products.filter(product => product.positionScalePct < 100).length
    return `${portfolio.id}: ${(baseline?.productCount ?? 0) - portfolio.productCount} sold, ${reduced} reduced.`
  }).join(' ')
}

// Plain-language statement of the shock settings for the Hermes review.
function stressAssumptions(report) {
  const scenarios = report.scenarios || []
  const { groupScales, ivMovePct, fxMovePct } = scenarios[0] || {}
  return [
    'Warrants outliving the horizon: Black-Scholes endpoint revaluation, volatility calibrated to the quote (bs) or provider IV (bs_iv).',
    groupScales ? 'Each underlying moves by the stated move x its IV / median IV (0.4-2.5x); scenario movePct is the stated move.' : '',
    ivMovePct ? `Warrant IV ${signed(ivMovePct)} relative in every scenario.` : '',
    fxMovePct ? `USD ${signed(fxMovePct)} vs EUR in every scenario, applied to products on USD underlyings only.` : '',
    scenarios.some(scenario => scenario.adverse) ? 'Scenario "adverse": each underlying takes the endpoint move that hurts that portfolio most; its movePct 0 is a placeholder.' : '',
    report.portfolios.some(portfolio => portfolio.kind === 'plan') ? `Portfolios other than "current" trim the current holdings; proceeds are zero-return cash and nothing is bought. ${planSummaries(report)}` : '',
  ].filter(Boolean).join(' ')
}

export function buildHermesStressReviewPayload(report) {
  return {
    modelMode: report.modelMode,
    horizonDays: report.horizonDays,
    assumptions: stressAssumptions(report),
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
