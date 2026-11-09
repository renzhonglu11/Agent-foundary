// What rolling a warrant into a longer-dated contract would look like. No
// product search exists, so the alternatives are theoretical contracts on the
// same underlying, priced with Black-Scholes. They show which kind of contract
// would change the odds and the cost of waiting; real quotes add the issuer's
// spread and a volatility that differs by strike and expiry.

import { finishBeyondProbability } from './exitSignals.js'
import { finite, positive, round } from './numbers.js'
import { blackScholesDelta, blackScholesPrice } from './optionPricing.js'
import { buildGroupShockScales, calculationItem, groupKey, warrantVolatility } from './portfolioStress.js'
import { daysUntil } from './productCalculations.js'

export const ROLL_EXTENSION_DAYS = 182
const ROLL_REASON_CODES = new Set(['expiry', 'break_even', 'decay_7d', 'decay_30d'])
const HORIZON_DAYS = 30
const SHOCK_PCT = 20

// Strike as a multiple of the spot, mirrored for puts.
export const ROLL_TEMPLATES = [
  { id: 'extend', label: '同行权价，延长 6 个月', moneyness: null },
  { id: 'atm', label: '平值，延长 6 个月', moneyness: 1 },
  { id: 'itm', label: '价内 10%，延长 6 个月', moneyness: 0.9 },
]

// Model figures of one contract. `price` is the observed quote for the held
// contract and the theoretical value otherwise; every change is the ratio of
// two model values, so a held contract's figures stay anchored to its quote.
function contractMetrics({ spot, strike, ratio, days, volatility, payoffVolatility, rate, direction, quote = null }) {
  const value = (atSpot, atDays) => blackScholesPrice({ spot: atSpot, strike, years: Math.max(0, atDays) / 365, volatility, rate, direction })
  const model = value(spot, days)
  if (!(model > 0)) return null
  const price = quote ?? model * ratio
  const change = (atSpot) => round((value(atSpot, days - HORIZON_DAYS) / model - 1) * 100)
  const put = direction === 'put'
  const breakEven = put ? strike - price / ratio : strike + price / ratio
  const delta = blackScholesDelta({ spot, strike, years: days / 365, volatility, rate, direction })
  return {
    days,
    price: round(price, 4),
    volatilityPct: round(volatility * 100, 1),
    // Percentage move of the contract per 1% move of the underlying.
    leverage: round(Math.abs(delta) * spot / model, 1),
    requiredMovePct: breakEven > 0 ? round((breakEven / spot - 1) * 100) : null,
    breakEvenProbability: breakEven > 0
      ? finishBeyondProbability({ spot, level: breakEven, volatility: payoffVolatility, years: days / 365, rate, direction })
      : 0,
    flatPct: change(spot),
    upPct: change(spot * (1 + SHOCK_PCT / 100)),
    downPct: change(spot * (1 - SHOCK_PCT / 100)),
  }
}

// Held contract and theoretical alternatives for one warrant, or null when the
// warrant cannot be priced.
export function buildRollWhatIf(entry, { impliedVolatility = null, exitSignal = null } = {}) {
  const item = calculationItem(entry)
  if (String(item.productType || '').toLowerCase() !== 'optionsschein') return null
  const spot = positive(item.underlyingSpot)
  const quote = positive(item.price)
  const days = finite(entry.riskLeg?.daysToExpiry) ?? daysUntil(item.expiry) ?? finite(item.daysToExpiry)
  const model = warrantVolatility(item, quote, spot, days)
  if (!model) return null

  const { strike, ratio, direction, rate } = model
  // The held contract keeps its own volatility; alternatives use the median of
  // the warrants on the underlying, which is less distorted by a far strike.
  const marketVolatility = positive(impliedVolatility) ?? model.volatility
  const shared = { spot, ratio, rate, direction, payoffVolatility: marketVolatility }
  const current = contractMetrics({ ...shared, strike, days, volatility: model.volatility, quote })
  if (!current) return null

  // Strikes are shown in the underlying's quote currency.
  const rawSpot = positive(entry.item?.underlyingSpotRaw) ?? spot
  const rawStrike = positive(entry.item?.strikePrice) ?? strike
  const alternatives = ROLL_TEMPLATES.map((template) => {
    const moneyness = template.moneyness == null ? strike / spot : direction === 'put' ? 2 - template.moneyness : template.moneyness
    const metrics = contractMetrics({ ...shared, strike: spot * moneyness, days: days + ROLL_EXTENSION_DAYS, volatility: marketVolatility })
    return metrics && { id: template.id, label: template.label, strike: round(template.moneyness == null ? rawStrike : rawSpot * moneyness), ...metrics }
  }).filter(Boolean)

  const reasons = (exitSignal?.reasons || []).filter(reason => ROLL_REASON_CODES.has(reason.code))
  const currentValue = quote * (positive(item.quantity) ?? 0)
  return {
    id: String(item.symbol || item.id || ''),
    name: String(item.instrument || item.stockName || item.displayName || item.symbol || '未知产品').trim(),
    groupName: String(entry.group?.groupName || item.underlying || ''),
    direction,
    currency: String(entry.item?.underlyingSpotRawCurrency || 'EUR').toUpperCase(),
    spot: round(rawSpot),
    currentValue: round(currentValue),
    calibrated: model.calibrated,
    exitLevel: exitSignal?.level ?? null,
    flagged: reasons.length > 0,
    reasons: reasons.map(reason => reason.text),
    current: { id: 'current', label: '当前合约', strike: round(rawStrike), ...current },
    alternatives,
  }
}

// Warrants whose exit signal points at time or odds come first; the rest are
// kept so every warrant can be inspected.
export function buildRollWhatIfs(entries = [], exitSignals = []) {
  const input = Array.isArray(entries) ? entries : []
  const signalById = new Map((exitSignals || []).map(signal => [signal.id, signal]))
  const impliedByGroup = new Map(buildGroupShockScales(input).groups.map(group => [group.key, group.volatilityPct != null ? group.volatilityPct / 100 : null]))
  return input
    .map(entry => buildRollWhatIf(entry, {
      impliedVolatility: impliedByGroup.get(groupKey(entry)),
      exitSignal: signalById.get(String(entry.item?.symbol || entry.item?.id || '')),
    }))
    .filter(Boolean)
    .sort((left, right) => Number(right.flagged) - Number(left.flagged) || right.currentValue - left.currentValue)
}

export const ROLL_ASSUMPTIONS = { horizonDays: HORIZON_DAYS, shockPct: SHOCK_PCT }
