// European Black-Scholes pricing for warrant stress tests. Dividends are not
// modeled: calibrating volatility to the observed quote absorbs them.

// Abramowitz-Stegun 7.1.26, absolute error below 1.5e-7.
export function normalCdf(value) {
  const x = Math.abs(value) / Math.SQRT2
  const t = 1 / (1 + 0.3275911 * x)
  const polynomial = ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t
  const erf = 1 - polynomial * Math.exp(-x * x)
  return value >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf)
}

// Price per unit of underlying; spot and strike share one currency.
export function blackScholesPrice({ spot, strike, years, volatility, rate = 0, direction }) {
  const put = direction === 'put'
  if (!(strike > 0) || !Number.isFinite(spot)) return null
  const discountedStrike = strike * Math.exp(-rate * Math.max(0, years))
  if (!(spot > 0)) return put ? discountedStrike : 0
  if (!(years > 0) || !(volatility > 0)) {
    return Math.max(0, put ? discountedStrike - spot : spot - discountedStrike)
  }
  const spread = volatility * Math.sqrt(years)
  const d1 = (Math.log(spot / strike) + (rate + volatility ** 2 / 2) * years) / spread
  const d2 = d1 - spread
  return put
    ? discountedStrike * normalCdf(-d2) - spot * normalCdf(-d1)
    : spot * normalCdf(d1) - discountedStrike * normalCdf(d2)
}

export const IMPLIED_VOLATILITY_RANGE = [0.05, 3]

// Bisection on the quote. Returns null when no volatility inside the accepted
// range reproduces it, which usually means the quote and spot are out of sync
// or a contract term is wrong.
export function impliedVolatility({ price, spot, strike, years, rate = 0, direction }) {
  if (!(price > 0) || !(spot > 0) || !(strike > 0) || !(years > 0)) return null
  const value = (volatility) => blackScholesPrice({ spot, strike, years, volatility, rate, direction })
  let [low, high] = IMPLIED_VOLATILITY_RANGE
  if (price < value(low) || price > value(high)) return null
  for (let step = 0; step < 60; step += 1) {
    const middle = (low + high) / 2
    if (value(middle) < price) low = middle
    else high = middle
  }
  return (low + high) / 2
}
