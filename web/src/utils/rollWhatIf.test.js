import assert from 'node:assert/strict'
import test from 'node:test'

import { blackScholesDelta, blackScholesPrice } from './optionPricing.js'
import { ROLL_EXTENSION_DAYS, buildRollWhatIf, buildRollWhatIfs } from './rollWhatIf.js'

function assertClose(actual, expected, tolerance = 1e-3) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} is not within ${tolerance} of ${expected}`)
}

const terms = { spot: 100, strike: 130, years: 90 / 365, volatility: 0.5, rate: 0.02, direction: 'call' }

// A call 30% out of the money with 90 days left, quoted at its Black-Scholes value.
function warrant(item = {}, overrides = {}) {
  const direction = item.optionType || 'call'
  const strike = item.strikePrice ?? 130
  return {
    item: {
      symbol: 'WARRANT',
      instrument: 'Test Call',
      productType: 'optionsschein',
      optionType: direction,
      quantity: 100,
      underlyingSpot: 100,
      strikePrice: strike,
      ratio: 0.1,
      iv: 0.5,
      price: blackScholesPrice({ ...terms, strike, direction }) * 0.1,
      ...item,
    },
    group: { key: overrides.groupKey || 'test', groupName: 'Test' },
    riskLeg: { daysToExpiry: 90 },
    primaryAction: 'HOLD',
  }
}

test('the held contract is described from its quote and calibrated volatility', () => {
  const roll = buildRollWhatIf(warrant())
  const { current } = roll
  assert.equal(roll.calibrated, true)
  assert.deepEqual([current.id, current.strike, current.days], ['current', 130, 90])
  assertClose(current.volatilityPct, 50, 0.1)
  const model = blackScholesPrice(terms)
  assertClose(current.price, model * 0.1, 1e-4)
  assertClose(current.leverage, blackScholesDelta(terms) * 100 / model, 0.06)
  assertClose(current.requiredMovePct, 30 + model, 0.01)
  // Thirty flat days leave 60 of the 90 days.
  assertClose(current.flatPct, (blackScholesPrice({ ...terms, years: 60 / 365 }) / model - 1) * 100, 0.01)
  assert.ok(current.upPct > 100 && current.downPct < -80)
})

test('alternatives extend the expiry and move the strike, which raises the odds and slows the decay', () => {
  const roll = buildRollWhatIf(warrant())
  const [extend, atm, itm] = roll.alternatives
  assert.deepEqual(roll.alternatives.map(row => [row.id, row.strike, row.days]), [
    ['extend', 130, 90 + ROLL_EXTENSION_DAYS], ['atm', 100, 90 + ROLL_EXTENSION_DAYS], ['itm', 90, 90 + ROLL_EXTENSION_DAYS],
  ])
  assertClose(atm.price, blackScholesPrice({ ...terms, strike: 100, years: (90 + ROLL_EXTENSION_DAYS) / 365 }) * 0.1, 1e-4)

  // More time and a closer strike: slower decay, lower leverage, better odds.
  assert.ok(roll.current.flatPct < extend.flatPct && extend.flatPct < atm.flatPct && atm.flatPct < itm.flatPct)
  assert.ok(roll.current.leverage > extend.leverage && extend.leverage > atm.leverage && atm.leverage > itm.leverage)
  assert.ok(roll.current.breakEvenProbability < atm.breakEvenProbability && atm.breakEvenProbability < itm.breakEvenProbability)
  assert.ok(itm.requiredMovePct < atm.requiredMovePct && atm.requiredMovePct < roll.current.requiredMovePct)
})

test('puts mirror the strikes, USD strikes stay in USD, and alternatives use the market volatility', () => {
  const put = buildRollWhatIf(warrant({ optionType: 'put', instrument: 'Test Put', strikePrice: 80 }))
  assert.deepEqual(put.alternatives.map(row => row.strike), [80, 100, 110])
  assert.ok(put.current.requiredMovePct < -20)

  // Spot 100 EUR is 125 USD; the EUR value of the contract is the same.
  const usd = buildRollWhatIf(warrant({ strikePrice: 162.5, underlyingSpotRaw: 125, underlyingSpotRawCurrency: 'USD', underlyingSpotUsdEurRate: 0.8, price: blackScholesPrice({ ...terms, rate: 0.04 }) * 0.1 }))
  assert.equal(usd.currency, 'USD')
  assert.deepEqual([usd.spot, usd.current.strike, ...usd.alternatives.map(row => row.strike)], [125, 162.5, 162.5, 125, 112.5])

  const market = buildRollWhatIf(warrant(), { impliedVolatility: 0.3 })
  assert.equal(market.current.volatilityPct, 50)
  assert.ok(market.alternatives.every(row => row.volatilityPct === 30))
})

test('only warrants are measured, and those flagged for time or odds come first', () => {
  assert.equal(buildRollWhatIf(warrant({ productType: 'open_end_turbo', knockoutPrice: 80 })), null)
  assert.equal(buildRollWhatIf(warrant({ underlyingSpot: null })), null)

  const entries = [
    warrant({ symbol: 'BIG', quantity: 1000 }, { groupKey: 'a' }),
    warrant({ symbol: 'DECAYING', quantity: 10 }, { groupKey: 'b' }),
    warrant({ symbol: 'TRENDING', quantity: 500 }, { groupKey: 'c' }),
    warrant({ symbol: 'TURBO', productType: 'open_end_turbo', knockoutPrice: 80 }, { groupKey: 'd' }),
  ]
  const rolls = buildRollWhatIfs(entries, [
    { id: 'DECAYING', level: 'urgent', reasons: [{ code: 'decay_30d', text: '横盘成本高' }, { code: 'trend', text: '趋势逆向' }] },
    { id: 'TRENDING', level: 'warn', reasons: [{ code: 'trend', text: '趋势逆向' }] },
  ])
  assert.deepEqual(rolls.map(roll => [roll.id, roll.flagged, roll.exitLevel]), [['DECAYING', true, 'urgent'], ['BIG', false, null], ['TRENDING', false, 'warn']])
  // A trend reason alone is not a reason to roll.
  assert.deepEqual(rolls[0].reasons, ['横盘成本高'])
  assert.deepEqual(buildRollWhatIfs(null, null), [])
})
