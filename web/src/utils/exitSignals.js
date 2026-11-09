// Exit signals for held structured products: how close a position is to a
// knock-out, how likely a warrant is to pay back its price, what waiting costs
// and whether the underlying is trending against it. Probabilities come from a
// lognormal model with the stated volatility; they rank positions for review
// and are not forecasts or trade instructions.

import { referenceRate, turboCarry } from './carryCost.js'
import { number } from './formatters.js'
import { finite, positive, round } from './numbers.js'
import { normalCdf } from './optionPricing.js'
import { buildGroupShockScales, calculatePositionStress, calculationItem, groupKey, productLeverage } from './portfolioStress.js'
import { daysUntil, getOptionDirection } from './productCalculations.js'

const TRADING_DAYS_PER_YEAR = 252

// Defaults for flagging a position, not personal risk limits.
export const EXIT_SIGNAL_DEFAULTS = {
  knockoutUrgentProbability7d: 0.25,
  knockoutWarnProbability30d: 0.25,
  breakEvenUrgentProbability: 0.1,
  breakEvenWarnProbability: 0.25,
  shortDatedDays: 30,
  expiryUrgentDays: 7,
  decayUrgentReturn7dPct: -10,
  decayWarnReturn30dPct: -15,
  decayUrgentReturn30dPct: -30,
  factorWarnTwoSigmaDayLossPct: 50,
  trendMinGapPct: 3,
}

export const EXIT_SIGNAL_LEVELS = ['urgent', 'warn', 'ok', 'unknown']

// Probability that the underlying touches the barrier within `years`, for a
// lognormal path without drift in price terms, monitored continuously.
export function barrierTouchProbability({ spot, barrier, volatility, years }) {
  if (!(spot > 0) || !(barrier > 0) || !(volatility > 0) || !(years > 0)) return null
  const distance = Math.abs(Math.log(barrier / spot))
  if (distance === 0) return 1
  // Log drift is −σ²/2; measured towards the barrier it is +σ²/2 below and −σ²/2 above.
  const drift = (barrier < spot ? 1 : -1) * volatility ** 2 / 2
  const spread = volatility * Math.sqrt(years)
  return Math.min(1, normalCdf((-distance + drift * years) / spread)
    + Math.exp(2 * drift * distance / volatility ** 2) * normalCdf((-distance - drift * years) / spread))
}

// Probability that the underlying ends beyond `level` (above for calls, below for puts).
export function finishBeyondProbability({ spot, level, volatility, years, rate = 0, direction }) {
  if (!(spot > 0) || !(level > 0) || !(volatility > 0) || !(years > 0)) return null
  const d2 = (Math.log(spot / level) + (rate - volatility ** 2 / 2) * years) / (volatility * Math.sqrt(years))
  return normalCdf(direction === 'put' ? -d2 : d2)
}

const pct = (value, digits = 1) => round(value * 100, digits)
const signed = value => `${value > 0 ? '+' : ''}${number.format(value)}%`

// Two readings of the underlying's volatility. Ruin risk (knock-out, one-day
// wipe-out) takes the highest available figure, so neither a calm history nor
// a cheap warrant market can hide it. Pay-off odds to expiry follow what the
// warrant market prices and fall back to the steadier 60-day history; a
// higher figure there would flatter out-of-the-money warrants.
function underlyingVolatility(stats, impliedVolatility) {
  const readings = [
    ['realized20', positive(stats?.realizedVol20d)],
    ['realized60', positive(stats?.realizedVol60d)],
    ['implied', positive(impliedVolatility)],
  ].filter(([, value]) => value != null)
  const byName = Object.fromEntries(readings)
  const [riskSource, risk] = readings.reduce((highest, reading) => (!highest || reading[1] > highest[1] ? reading : highest), null) ?? [null, null]
  const payoffSource = ['implied', 'realized60', 'realized20'].find(name => byName[name] != null) ?? null
  const payoff = payoffSource ? byName[payoffSource] : null
  return {
    risk,
    riskPct: risk != null ? pct(risk) : null,
    riskSource,
    payoff,
    payoffPct: payoff != null ? pct(payoff) : null,
    payoffSource,
    realized20Pct: byName.realized20 != null ? pct(byName.realized20) : null,
    realized60Pct: byName.realized60 != null ? pct(byName.realized60) : null,
    impliedPct: byName.implied != null ? pct(byName.implied) : null,
  }
}

function barrierMetrics(item, entry, direction, spot, volatility) {
  const knockout = positive(item.knockoutPrice)
  if (knockout == null || direction == null) return null
  const distancePct = (direction === 'put' ? knockout - spot : spot - knockout) / spot * 100
  if (distancePct <= 0) return { distancePct: round(distancePct), dailySigmas: 0, probability7d: 1, probability30d: 1, breached: true }
  const touch = (days) => {
    // Open-end barriers creep towards the spot as financing accrues.
    const barrier = positive(turboCarry(item, productLeverage(entry), days)?.knockoutPrice) ?? knockout
    return barrierTouchProbability({ spot, barrier, volatility, years: days / 365 })
  }
  return {
    distancePct: round(distancePct),
    dailySigmas: volatility ? round(Math.abs(Math.log(knockout / spot)) / (volatility / Math.sqrt(TRADING_DAYS_PER_YEAR)), 1) : null,
    probability7d: volatility ? touch(7) : null,
    probability30d: volatility ? touch(30) : null,
    breached: false,
  }
}

function breakEvenMetrics(item, direction, spot, volatility, daysToExpiry) {
  const strike = positive(item.strikePrice)
  const ratio = positive(item.ratio)
  const price = positive(item.price)
  if (strike == null || ratio == null || price == null || direction == null || !(daysToExpiry > 0)) return null
  const put = direction === 'put'
  const level = put ? strike - price / ratio : strike + price / ratio
  const intrinsic = Math.max(0, put ? strike - spot : spot - strike) * ratio
  const years = daysToExpiry / 365
  const model = { spot, volatility, years, rate: referenceRate(item), direction }
  const inTheMoney = volatility ? finishBeyondProbability({ ...model, level: strike }) : null
  return {
    level: round(level, 4),
    // Underlying move still needed for the payoff at expiry to cover today's price.
    requiredMovePct: level > 0 ? round((level / spot - 1) * 100) : null,
    expectedMovePct: volatility ? round(volatility * Math.sqrt(years) * 100) : null,
    probability: volatility && level > 0 ? finishBeyondProbability({ ...model, level }) : volatility ? 0 : null,
    worthlessProbability: inTheMoney != null ? 1 - inTheMoney : null,
    timeValuePct: round(Math.max(0, price - intrinsic) / price * 100),
  }
}

function factorMetrics(entry, direction, volatility, stats) {
  const leverage = productLeverage(entry)
  if (leverage == null) return null
  const adverseDay = direction === 'put' ? finite(stats?.bestDayPct) : finite(stats?.worstDayPct)
  return {
    leverage,
    // One-day underlying move that would erase the product, before any issuer reset.
    wipeoutMovePct: round(100 / leverage),
    twoSigmaDayLossPct: volatility ? round(Math.min(100, leverage * 2 * volatility / Math.sqrt(TRADING_DAYS_PER_YEAR) * 100)) : null,
    worstDayLossPct: adverseDay != null ? round(Math.min(100, leverage * Math.abs(adverseDay))) : null,
    worstDayMovePct: adverseDay != null ? round(adverseDay) : null,
  }
}

// Trend of the underlying in its listing currency, read against the position's direction.
function trendMetrics(item, direction, stats, minGapPct) {
  if (!stats) return null
  const spot = positive(item.underlyingSpotRaw) ?? positive(stats.lastClose)
  const sma20 = positive(stats.sma20)
  const sma50 = positive(stats.sma50)
  if (spot == null || sma50 == null) return null
  // A price hugging its average is not a trend.
  const gap = spot / sma50 - 1
  const below = gap <= -minGapPct / 100 && (sma20 == null || sma20 < sma50)
  const above = gap >= minGapPct / 100 && (sma20 == null || sma20 > sma50)
  const state = direction == null || (!below && !above) ? 'mixed' : (direction === 'put' ? above : below) ? 'against' : 'with'
  return {
    state,
    vsSma50Pct: round(gap * 100),
    return20dPct: finite(stats.return20dPct) != null ? round(stats.return20dPct) : null,
    fromHighPct: positive(stats.high52w) != null ? round((spot / stats.high52w - 1) * 100) : null,
    asOf: stats.asOf ?? null,
    stale: Boolean(stats.stale),
  }
}

function decayMetrics(entry) {
  const flat = days => calculatePositionStress(entry, { id: 'flat', movePct: 0 }, days)?.returnPct ?? null
  return { return7dPct: flat(7), return30dPct: flat(30) }
}

function collectReasons(signal, thresholds) {
  const reasons = []
  const add = (severity, code, text) => reasons.push({ severity, code, text })
  const { barrier, breakEven, factor, decay, trend, daysToExpiry, productType } = signal
  const percent = probability => `${round(probability * 100, 0)}%`

  if (barrier?.breached) add('urgent', 'barrier_breached', '标的已触及敲出价')
  else if (barrier?.probability7d != null && barrier.probability7d >= thresholds.knockoutUrgentProbability7d) {
    add('urgent', 'knockout_7d', `7 天内敲出的模型概率 ${percent(barrier.probability7d)}`)
  } else if (barrier?.probability30d != null && barrier.probability30d >= thresholds.knockoutWarnProbability30d) {
    add('warn', 'knockout_30d', `30 天内敲出的模型概率 ${percent(barrier.probability30d)}`)
  }

  if (productType === 'optionsschein' && daysToExpiry != null) {
    if (daysToExpiry <= thresholds.expiryUrgentDays) add('urgent', 'expiry', `剩余 ${daysToExpiry} 天到期`)
    else if (daysToExpiry <= thresholds.shortDatedDays) add('warn', 'expiry', `剩余 ${daysToExpiry} 天到期，时间价值加速损耗`)
  }

  if (breakEven?.probability != null) {
    const shortDated = daysToExpiry != null && daysToExpiry <= thresholds.shortDatedDays
    const text = `到期保本的模型概率 ${percent(breakEven.probability)}`
    if (breakEven.probability <= thresholds.breakEvenUrgentProbability
      || (shortDated && breakEven.probability <= thresholds.breakEvenWarnProbability)) add('urgent', 'break_even', text)
    else if (breakEven.probability <= thresholds.breakEvenWarnProbability) add('warn', 'break_even', text)
  }

  if (barrier?.breached) {
    // The knocked-out value already says everything the decay figures would.
  } else if (decay.return7dPct != null && decay.return7dPct <= thresholds.decayUrgentReturn7dPct) {
    add('urgent', 'decay_7d', `标的横盘 7 天，模型估值 ${signed(decay.return7dPct)}`)
  } else if (decay.return30dPct != null && decay.return30dPct <= thresholds.decayUrgentReturn30dPct) {
    add('urgent', 'decay_30d', `标的横盘 30 天，模型估值 ${signed(decay.return30dPct)}`)
  } else if (decay.return30dPct != null && decay.return30dPct <= thresholds.decayWarnReturn30dPct) {
    add('warn', 'decay_30d', `标的横盘 30 天，模型估值 ${signed(decay.return30dPct)}`)
  }

  if (factor?.worstDayLossPct != null && factor.worstDayLossPct >= 100) {
    add('warn', 'factor_wipeout', `过去一年最大单日逆向波动 ${signed(factor.worstDayMovePct)}，按 ${number.format(factor.leverage)} 倍杠杆足以归零`)
  } else if (factor?.twoSigmaDayLossPct != null && factor.twoSigmaDayLossPct >= thresholds.factorWarnTwoSigmaDayLossPct) {
    add('warn', 'factor_day', `两个标准差的单日逆向波动约亏 ${number.format(factor.twoSigmaDayLossPct)}%`)
  }

  if (trend?.state === 'against') {
    add('warn', 'trend', '标的趋势与持仓方向相反')
  }
  return reasons
}

export function buildExitSignal(entry, { stats = null, impliedVolatility = null, thresholds = EXIT_SIGNAL_DEFAULTS } = {}) {
  const item = calculationItem(entry)
  const productType = String(item.productType || '').toLowerCase()
  const direction = getOptionDirection(item)
  const spot = positive(item.underlyingSpot)
  const daysToExpiry = finite(entry.riskLeg?.daysToExpiry) ?? daysUntil(item.expiry) ?? finite(item.daysToExpiry)
  const volatility = underlyingVolatility(stats, impliedVolatility)
  const price = positive(item.price)
  const quantity = positive(item.quantity)
  const turbo = productType === 'open_end_turbo' || productType === 'knock_out'

  const signal = {
    id: String(item.symbol || item.id || ''),
    name: String(item.instrument || item.stockName || item.displayName || item.symbol || '未知产品').trim(),
    groupKey: groupKey(entry),
    groupName: String(entry.group?.groupName || item.underlying || ''),
    productType,
    direction,
    daysToExpiry,
    currentValue: price != null && quantity != null ? round(price * quantity) : round(positive(item.marketValue) ?? 0),
    unrealizedPct: finite(item.unrealizedPct) != null ? round(item.unrealizedPct) : null,
    volatility,
    barrier: spot != null && turbo ? barrierMetrics(item, entry, direction, spot, volatility.risk) : null,
    breakEven: spot != null && productType === 'optionsschein' ? breakEvenMetrics(item, direction, spot, volatility.payoff, daysToExpiry) : null,
    factor: productType === 'factor_certificate' ? factorMetrics(entry, direction, volatility.risk, stats) : null,
    decay: decayMetrics(entry),
    trend: trendMetrics(item, direction, stats, thresholds.trendMinGapPct),
  }
  const reasons = collectReasons(signal, thresholds)
  // Without any volatility no probability can be stated, so silence is not a pass.
  const level = reasons.some(reason => reason.severity === 'urgent') ? 'urgent'
    : reasons.length ? 'warn'
      : spot != null && volatility.risk != null ? 'ok' : 'unknown'
  return { ...signal, reasons, level }
}

// `dailyStats` is the backend's per-symbol list; each entry's underlying is
// matched through its group's Alpaca symbol.
export function buildExitSignals(entries = [], dailyStats = [], thresholds = EXIT_SIGNAL_DEFAULTS) {
  const input = Array.isArray(entries) ? entries : []
  const statsBySymbol = new Map((Array.isArray(dailyStats) ? dailyStats : []).map(stats => [String(stats.symbol).toUpperCase(), stats]))
  const impliedByGroup = new Map(buildGroupShockScales(input).groups.map(group => [group.key, group.volatilityPct != null ? group.volatilityPct / 100 : null]))
  const signals = input.map(entry => buildExitSignal(entry, {
    stats: statsBySymbol.get(String(entry.group?.alpacaSymbol || '').toUpperCase()) ?? null,
    impliedVolatility: impliedByGroup.get(groupKey(entry)) ?? null,
    thresholds,
  })).sort((left, right) => EXIT_SIGNAL_LEVELS.indexOf(left.level) - EXIT_SIGNAL_LEVELS.indexOf(right.level)
    || right.currentValue - left.currentValue)
  const value = level => round(signals.filter(signal => signal.level === level).reduce((sum, signal) => sum + signal.currentValue, 0))
  return {
    signals,
    counts: Object.fromEntries(EXIT_SIGNAL_LEVELS.map(level => [level, signals.filter(signal => signal.level === level).length])),
    values: Object.fromEntries(EXIT_SIGNAL_LEVELS.map(level => [level, value(level)])),
    withHistoryCount: signals.filter(signal => signal.trend).length,
  }
}
