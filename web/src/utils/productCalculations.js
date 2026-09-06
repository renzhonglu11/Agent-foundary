/**
 * Pure calculation functions for the product monitoring dashboard.
 * No React dependencies — all functions accept plain data and return plain results.
 * Returns null when required inputs are missing.
 */

// ---- helpers ----

function finite(value) {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function positive(value) {
  const n = finite(value)
  return n != null && n > 0 ? n : null
}

export function daysUntil(dateString) {
  if (!dateString) return null
  const target = new Date(dateString)
  if (!Number.isFinite(target.getTime())) return null
  const now = new Date()
  const diffMs = target.getTime() - now.getTime()
  return Math.max(0, Math.ceil(diffMs / 86_400_000))
}

export function getOptionDirection(item) {
  if (!item) return null
  // Prefer the explicit optionType field if present
  if (item.optionType === 'call' || item.optionType === 'put') return item.optionType
  // Otherwise detect from name text
  const text = `${item.stockName || ''} ${item.instrument || ''} ${item.displayName || ''} ${item.underlying || ''}`.toLowerCase()
  if (/put|bear|short|turbop|fakts/i.test(text)) return 'put'
  if (/call|bull|long|turboc|faktl/i.test(text)) return 'call'
  return null
}

// ========================================================
// Scenario prices
// ========================================================

export const DEFAULT_SCENARIO_PCTS = [-10, -5, -3, 0, 3, 5, 10]

export function generateScenarioPrices(spot, customPcts) {
  const pcts = customPcts || DEFAULT_SCENARIO_PCTS
  const spotNum = finite(spot)
  if (spotNum == null) return []
  return pcts.map((pct) => {
    const price = spotNum * (1 + pct / 100)
    return {
      pct,
      price: Math.max(0, price),
      label: pct > 0 ? `+${pct}%` : `${pct}%`,
    }
  })
}

export function getAdverseScenarioPcts(direction) {
  // For CALL: adverse = underlying drops (negative %)
  // For PUT:  adverse = underlying rises (positive %)
  if (direction === 'put') return [1, 2, 3, 5, 10]
  return [-1, -2, -3, -5, -10]
}

/**
 * Apply a single-period leveraged return to the current product price.
 *
 * This is suitable for endpoint stress/scenario views. It deliberately does
 * not compound across days because Factor Certificates reset daily and are
 * path-dependent.
 */
export function calculateLeverageScenario(currentPrice, leverage, direction, underlyingChangePct) {
  const price = finite(currentPrice)
  const factor = positive(leverage)
  const pct = finite(underlyingChangePct)
  const directionSign = direction === 'put' ? -1 : direction === 'call' ? 1 : null

  if (price == null || factor == null || pct == null || directionSign == null) return null

  const projectedReturn = directionSign * factor * (pct / 100)
  const projectedPrice = Math.max(0, price * (1 + projectedReturn))
  return {
    currentPrice: price,
    projectedPrice,
    priceChange: projectedPrice - price,
    projectedReturn,
    leverage: factor,
    direction,
  }
}

// ========================================================
// Expiry P&L
// ========================================================

/**
 * Calculate P&L at expiry for a given scenario underlying price.
 *
 * CALL: intrinsic = max(0, scenarioUnderlying - strike) * ratio * payoutFxRate
 * PUT:  intrinsic = max(0, strike - scenarioUnderlying) * ratio * payoutFxRate
 * pnl = (intrinsic - avgCost) * quantity
 *
 * scenarioPrice and strike must be in the same underlying currency. payoutFxRate
 * converts the underlying payoff currency into the product quote currency.
 */
export function calculateExpiryPnl(item, scenarioPrice, options = {}) {
  if (item?.productType === 'factor_certificate') return null

  const strike = finite(item?.strikePrice)
  const ratio = positive(item?.ratio)
  const quantity = finite(item?.quantity)
  const avgCost = finite(item?.avgCost ?? (item?.costBasis && item?.quantity ? item.costBasis / item.quantity : null))
  const direction = getOptionDirection(item)
  const scenario = finite(scenarioPrice)
  const payoutFxRate = positive(options?.payoutFxRate) ?? 1

  if (strike == null || ratio == null || quantity == null || scenario == null || direction == null) return null

  let intrinsicUnderlying
  if (direction === 'call') {
    intrinsicUnderlying = Math.max(0, scenario - strike) * ratio
  } else {
    intrinsicUnderlying = Math.max(0, strike - scenario) * ratio
  }
  const intrinsic = intrinsicUnderlying * payoutFxRate

  const costPerUnit = avgCost ?? 0
  const pnl = (intrinsic - costPerUnit) * quantity
  const totalCost = costPerUnit * quantity
  const pnlPct = totalCost > 0 ? (pnl / totalCost) * 100 : 0

  return { intrinsic, intrinsicUnderlying, pnl, pnlPct, scenario, strike, ratio, direction, payoutFxRate }
}

// ========================================================
// Time Decay
// ========================================================

/**
 * Derive time-decay periods from days-to-expiry so the table always
 * shows sensible horizons relative to the product's remaining life.
 */
export function getTimeDecayPeriods(dte) {
  if (dte == null || dte <= 0) {
    return [
      { label: '1天', days: 1 },
      { label: '3天', days: 3 },
      { label: '1周', days: 7 },
    ]
  }
  if (dte <= 14) {
    return [
      { label: '1天', days: 1 },
      { label: '3天', days: 3 },
      { label: '1周', days: 7 },
    ]
  }
  if (dte <= 60) {
    return [
      { label: '3天', days: 3 },
      { label: '1周', days: 7 },
      { label: '2周', days: 14 },
      { label: '1月', days: 30 },
    ]
  }
  if (dte <= 180) {
    return [
      { label: '1周', days: 7 },
      { label: '2周', days: 14 },
      { label: '1月', days: 30 },
      { label: '3月', days: 90 },
    ]
  }
  if (dte <= 365) {
    return [
      { label: '2周', days: 14 },
      { label: '1月', days: 30 },
      { label: '3月', days: 90 },
      { label: '6月', days: 180 },
    ]
  }
  return [
    { label: '1月', days: 30 },
    { label: '3月', days: 90 },
    { label: '6月', days: 180 },
    { label: '12月', days: 365 },
  ]
}

/**
 * Estimate price after N days of time decay.
 *
 * Priority:
 * 1. Theta-based: priceChange = theta * days (adjusted for ratio if per-underlying)
 * 2. Linear amortization: timeValue / daysToExpiry * days
 * 3. Approximation: currentPrice * (days / daysToExpiry) * 0.5
 */
export function calculateTimeDecay(item, days) {
  if (item?.productType === 'factor_certificate') return null

  const currentPrice = finite(item?.price)
  const strike = finite(item?.strikePrice)
  const ratio = positive(item?.ratio)
  const direction = getOptionDirection(item)
  const dte = daysUntil(item?.expiry) ?? finite(item?.daysToExpiry)
  const rawTheta = finite(item?.theta)

  if (currentPrice == null || days == null || days <= 0) return null

  let method = 'approx'
  let priceChange = 0
  const effectiveDays = dte != null ? Math.min(days, dte) : days

  // Try Theta first
  if (rawTheta != null && dte != null && dte > 0) {
    let theta = rawTheta
    // Heuristic: if theta * ratio is very large relative to price, theta is per-underlying
    if (ratio != null && Math.abs(theta * ratio) > currentPrice * 0.5) {
      theta = theta / ratio
    }
    // Check if theta is per-day per warrant (typical magnitude check)
    if (Math.abs(theta) < currentPrice * 0.1) {
      priceChange = theta * effectiveDays
      method = 'theta'
    }
  }

  // Fallback to linear amortization if theta didn't work
  if (method === 'approx' && strike != null && ratio != null && direction != null && dte != null && dte > 0) {
    let intrinsic
    if (direction === 'call') {
      intrinsic = Math.max(0, (finite(item?.underlyingSpot) ?? 0) - strike) * ratio
    } else {
      intrinsic = Math.max(0, strike - (finite(item?.underlyingSpot) ?? 0)) * ratio
    }
    const timeValue = Math.max(0, currentPrice - intrinsic)
    if (timeValue > 0) {
      const dailyDecay = timeValue / dte
      priceChange = -dailyDecay * effectiveDays
      method = 'linear'
    }
  }

  // Final fallback: simple approximation
  if (method === 'approx' && dte != null && dte > 0) {
    priceChange = -currentPrice * (effectiveDays / dte) * 0.5
  }

  const newPrice = Math.max(0, currentPrice + priceChange)
  const effectivePriceChange = newPrice - currentPrice
  const quantity = finite(item?.quantity) ?? 0
  const pnlChange = effectivePriceChange * quantity

  return {
    currentPrice,
    newPrice,
    priceChange: effectivePriceChange,
    pnlChange,
    method,
    days: effectiveDays,
    dte,
  }
}

// ========================================================
// Drawdown
// ========================================================

/**
 * Estimate position impact when underlying moves by changePct%.
 *
 * For CALL: adverse is negative %; for PUT: adverse is positive %.
 *
 * Priority:
 * 1. Factor Certificate: signed single-period leverage applied to current price
 * 2. Delta-based: priceChange = delta * underlyingChange * ratio
 * 3. Omega-based: pctChange = omega * (underlyingPctChange / 100)
 * 4. Intrinsic-only: assume extrinsic constant, recompute intrinsic at new spot
 */
export function calculateDrawdown(item, underlyingChangePct) {
  const currentPrice = finite(item?.price)
  const spot = finite(item?.underlyingSpot)
  const delta = finite(item?.delta)
  const omega = finite(item?.omega)
  const productType = String(item?.productType || '').toLowerCase()
  const leverage = positive(item?.leverage) ?? positive(item?.effectiveLeverage)
  const ratio = positive(item?.ratio)
  const strike = finite(item?.strikePrice)
  const direction = getOptionDirection(item)
  const quantity = finite(item?.quantity) ?? 0
  const pct = finite(underlyingChangePct)

  if (currentPrice == null || spot == null || pct == null) return null

  let method = 'intrinsic'
  let priceChange = 0

  // Factor Certificates reset daily and do not have option intrinsic value.
  if (productType === 'factor_certificate') {
    const factorScenario = calculateLeverageScenario(currentPrice, leverage, direction, pct)
    if (factorScenario == null) return null
    priceChange = factorScenario.priceChange
    method = 'factor_leverage'
  }
  // Priority 2: Delta
  else if (delta != null && ratio != null) {
    const underlyingChange = spot * (pct / 100)
    priceChange = delta * underlyingChange * ratio
    method = 'delta'
  }
  // Priority 3: Omega
  else if (omega != null) {
    const signedOmega = direction === 'put' ? -Math.abs(omega) : Math.abs(omega)
    const pctChange = signedOmega * (pct / 100)
    priceChange = currentPrice * pctChange
    method = 'omega'
  }
  // Priority 4: Intrinsic-only
  else if (strike != null && ratio != null && direction != null) {
    const newSpot = spot * (1 + pct / 100)
    let currentIntrinsic, newIntrinsic
    if (direction === 'call') {
      currentIntrinsic = Math.max(0, spot - strike) * ratio
      newIntrinsic = Math.max(0, newSpot - strike) * ratio
    } else {
      currentIntrinsic = Math.max(0, strike - spot) * ratio
      newIntrinsic = Math.max(0, strike - newSpot) * ratio
    }
    // Extrinsic assumed constant
    const extrinsic = Math.max(0, currentPrice - currentIntrinsic)
    const newPrice = newIntrinsic + extrinsic
    priceChange = newPrice - currentPrice
    method = 'intrinsic'
  } else {
    return null
  }

  const newPrice = Math.max(0, currentPrice + priceChange)
  const effectivePriceChange = newPrice - currentPrice
  const pnl = effectivePriceChange * quantity
  const currentMarketValue = currentPrice * quantity
  const pnlPct = currentMarketValue > 0 ? (pnl / currentMarketValue) * 100 : null

  return {
    currentPrice,
    newPrice,
    priceChange: effectivePriceChange,
    pnl,
    pnlPct,
    method,
    spot,
    newSpot: spot * (1 + pct / 100),
    underlyingChangePct: pct,
  }
}

// ========================================================
// Method display
// ========================================================

export const METHOD_META = {
  theta:    { label: 'Theta',  color: 'success', description: '使用实时 Theta 计算' },
  linear:   { label: '线性',   color: 'warning', description: '时间价值线性摊销估算' },
  approx:   { label: '近似',   color: 'default', description: '简化近似估算，准确度较低' },
  factor_leverage: { label: 'Factor', color: 'success', description: '按当前产品价格和单周期 Factor 杠杆估算' },
  delta:    { label: 'Delta',  color: 'success', description: '使用实时 Delta 估算' },
  omega:    { label: 'Omega',  color: 'warning', description: '使用 Omega 弹性估算' },
  intrinsic:{ label: '内在价值',color: 'default', description: '仅用内在价值估算，假设外在价值不变' },
}
