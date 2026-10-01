import { positive } from './numbers.js'
import { getOptionDirection } from './productCalculations.js'

// No data source supplies issuer financing terms, so these are explicit
// assumptions. Rates are annual decimals keyed by underlying quote currency.
export const CARRY_ASSUMPTIONS = {
  referenceRates: { USD: 0.04, EUR: 0.02 },
  financingSpread: 0.03,
  factorFee: 0.01,
  defaultVolatility: 0.5,
}

function isShort(item) {
  return getOptionDirection(item) === 'put'
}

function referenceRate(item, assumptions) {
  const currency = String(item?.underlyingSpotRawCurrency || '').toUpperCase()
  return assumptions.referenceRates[currency] ?? assumptions.referenceRates.EUR
}

// Long products pay reference rate plus spread on the financed amount; short
// products earn reference rate minus spread, which is negative when s > r.
function financingRate(item, assumptions) {
  const rate = referenceRate(item, assumptions)
  return isShort(item) ? rate - assumptions.financingSpread : rate + assumptions.financingSpread
}

function volatilityFraction(value) {
  const numeric = positive(value)
  if (numeric == null) return null
  return numeric <= 1 ? numeric : numeric / 100
}

function median(values) {
  if (!values.length) return null
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

// Factor products carry no implied volatility of their own, so warrants on the
// same underlying stand in for it before falling back to the default.
export function underlyingVolatility(entry, assumptions = CARRY_ASSUMPTIONS) {
  const own = volatilityFraction(entry?.item?.iv)
  if (own != null) return { volatility: own, source: 'iv' }
  const group = median((entry?.group?.derivatives || [])
    .map((row) => volatilityFraction(row?.iv))
    .filter((value) => value != null))
  if (group != null) return { volatility: group, source: 'group_iv' }
  return { volatility: assumptions.defaultVolatility, source: 'default_vol' }
}

// A turbo's financing level accrues daily: a call loses strike × ratio × (r + s)
// per year and a put gains strike × ratio × (r − s). Without a strike, the
// financed amount is price × (L − 1) for calls and price × (L + 1) for puts.
// Open-end knock-out barriers move with the financing level; closed-end ones
// are fixed.
export function turboCarry(item, leverage, days, assumptions = CARRY_ASSUMPTIONS) {
  const price = positive(item?.price)
  if (price == null || !(days > 0)) return null
  const short = isShort(item)
  const strike = positive(item?.strikePrice)
  const ratio = positive(item?.ratio)
  const financedValue = strike != null && ratio != null
    ? strike * ratio
    : leverage != null ? price * Math.max(0, short ? leverage + 1 : leverage - 1) : null
  if (financedValue == null) return null

  const drift = financingRate(item, assumptions) * days / 360
  const knockout = positive(item?.knockoutPrice)
  const openEnd = String(item?.productType || '').toLowerCase() === 'open_end_turbo'
  return {
    priceChange: (short ? 1 : -1) * financedValue * drift,
    knockoutPrice: knockout != null && openEnd ? knockout * (1 + drift) : item?.knockoutPrice,
  }
}

// A daily-reset factor with signed leverage β (L long, −L short) is worth
// (S_T/S_0)^β × exp(−½·β(β−1)·σ²·t + carry·t) under continuous rebalancing.
// The endpoint shock is modeled separately; this returns the multiplier for
// financing, index fee and volatility drag over the horizon.
export function factorCarry(item, leverage, days, volatility, assumptions = CARRY_ASSUMPTIONS) {
  if (!(days > 0) || leverage == null || volatility == null) return null
  const short = isShort(item)
  const beta = short ? -leverage : leverage
  const financedMultiple = Math.max(0, short ? leverage + 1 : leverage - 1)
  const financing = (short ? 1 : -1) * financedMultiple * financingRate(item, assumptions)
  const drag = 0.5 * beta * (beta - 1) * volatility ** 2
  const logReturn = financing * days / 360 - (assumptions.factorFee + drag) * days / 365
  return { multiplier: Math.exp(logReturn) }
}
