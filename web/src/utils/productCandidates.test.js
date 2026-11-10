import assert from 'node:assert/strict'
import test from 'node:test'
import { blackScholesPrice } from './optionPricing.js'
import { candidateIssues, candidateMetrics, compareRealRoll, mergeOpportunityGroups } from './productCandidates.js'
import { buildOpportunityScreen } from './opportunityScreen.js'

const now = Date.parse('2026-11-10T12:00:00Z')
const DAY = 86_400_000

function candidate(overrides = {}) {
  const p = {
    isin: 'DE000UG7MVU1', underlyingId: 'TSLA UW', underlyingName: 'Tesla', underlyingIsin: 'US88160R1014', underlyingSymbol: 'TSLA',
    productType: 'optionsschein', optionType: 'call', status: 'ACTIVE', tradable: true, paymentStyle: 'DOMESTIC',
    expiry: '2027-06-16', quoteCurrency: 'EUR', underlyingCurrency: 'USD', underlyingSpot: 100,
    strikePrice: 110, ratio: 0.1, iv: 0.5, usdEurRate: 0.9, fxSource: 'frankfurter', fxAsOf: '2026-11-10T10:00:00Z',
    quoteAsOf: '2026-11-10T11:55:00Z', underlyingAsOf: '2026-11-10T11:56:00Z', fetchedAt: '2026-11-10T12:00:00Z',
    ...overrides,
  }
  const model = blackScholesPrice({ spot: p.underlyingSpot, strike: p.strikePrice, years: (Date.parse(p.expiry) - now) / DAY / 365, volatility: p.iv, rate: p.underlyingCurrency === 'USD' ? 0.04 : 0.02, direction: p.optionType }) * p.ratio * (p.underlyingCurrency === 'USD' ? p.usdEurRate : 1)
  return { bid: model * 0.98, ask: model * 1.02, ...p }
}

test('real candidates price native-currency strikes and include the observed bid-ask spread', () => {
  const p = candidate()
  const { issues, metrics } = candidateMetrics(p, { now })
  assert.deepEqual(issues, [])
  assert.equal(metrics.volatilityPct, 50)
  assert.equal(metrics.calibrated, true)
  const expiryYears = (Date.parse(p.expiry) - now) / DAY / 365
  const flatValue = blackScholesPrice({ spot: 100, strike: 110, years: expiryYears - 30 / 365, volatility: 0.5, rate: 0.04, direction: 'call' }) * 0.1 * 0.9 * 0.98
  assert.ok(Math.abs(metrics.bidValues.flat - flatValue) < 1e-5)
  assert.ok(Math.abs(metrics.flatPct - (flatValue / p.ask - 1) * 100) < 0.01)
  assert.ok(Math.abs(metrics.requiredMovePct - (110 + p.ask / 0.09 - 100)) < 0.01)
  const put = candidateMetrics(candidate({ optionType: 'put', strikePrice: 90 }), { now }).metrics
  assert.ok(put.requiredMovePct < 0)
  assert.ok(put.downPct > put.upPct)
})

test('unknown, stale, suspended and unsupported inputs never produce precise model results', () => {
  const invalid = [
    { quoteAsOf: null }, { underlyingAsOf: null }, { quoteAsOf: '2026-11-08T00:00:00Z' },
    { quoteAsOf: '2026-11-11T00:00:00Z' }, { underlyingAsOf: '2026-11-10T09:00:00Z' },
    { ask: null }, { bid: 1000 }, { tradable: false }, { status: 'EXPIRED' },
    { paymentStyle: 'QUANTO' }, { paymentStyle: '' }, { quoteCurrency: 'USD' }, { underlyingCurrency: 'JPY' },
    { fxSource: 'fallback_env' }, { fxAsOf: '2026-10-01T00:00:00Z' }, { usdEurRate: null }, { ratio: null },
  ]
  for (const override of invalid) {
    const p = { ...candidate(), ...override }
    assert.ok(candidateIssues(p, now).length, JSON.stringify(override))
    assert.equal(candidateMetrics(p, { now }).metrics, null)
  }
})

test('real roll conserves actual sale proceeds, retains cash and measures both alternatives on that capital', () => {
  const origin = candidate({ expiry: '2027-01-15', strikePrice: 130 })
  const next = candidate({ isin: 'DE000UG3NHT9', strikePrice: 100 })
  const { comparison: result, issues } = compareRealRoll(origin, next, 350, now)
  assert.deepEqual(issues, [])
  assert.ok(result.quantity > 0 && Number.isInteger(result.quantity))
  assert.ok(Math.abs(result.cost + result.cash - result.budget) <= 0.01)
  assert.ok(result.cash >= 0 && result.cash < next.ask)
  assert.equal(result.quantity, Math.floor(origin.bid * 350 / next.ask))
  const held = candidateMetrics(origin, { now }).metrics
  const candidateModel = candidateMetrics(next, { now }).metrics
  const expected = candidateModel.bidValues.down * result.quantity + (origin.bid * 350 - result.quantity * next.ask) - origin.bid * 350
  assert.ok(Math.abs(result.scenarios[0].rollPnl - expected) <= 0.01)
  assert.ok(Math.abs(result.scenarios[0].holdPnl - (held.bidValues.down - origin.bid) * 350) <= 0.01)
})

test('roll rejects wrong listings, opposite directions, shorter expiries, quote time gaps and unaffordable units', () => {
  const origin = candidate({ expiry: '2027-01-15' })
  const next = candidate({ isin: 'DE000UG3NHT9' })
  for (const override of [
    { isin: origin.isin }, { underlyingId: 'TSLA GY' }, { optionType: 'put' },
    { expiry: origin.expiry }, { quoteAsOf: '2026-11-10T10:00:00Z' },
  ]) assert.equal(compareRealRoll(origin, { ...next, ...override }, 100, now).comparison, null)
  assert.equal(compareRealRoll(origin, next, 0.0001, now).comparison, null)
})

test('unheld watchlist products enter the opportunity universe without creating holdings or portfolio value', () => {
  const held = [{ key: 'tsla', groupName: 'Tesla', alpacaSymbol: 'TSLA', marketValue: 500, derivatives: [{ symbol: 'HELD' }], stocks: [] }]
  const watch = [candidate(), candidate({ isin: 'NEW', underlyingId: 'MSFT UW', underlyingSymbol: 'MSFT', underlyingName: 'Microsoft' }), candidate({ isin: 'HELD' })]
  const groups = mergeOpportunityGroups(held, watch, new Set(['HELD']))
  assert.equal(groups.length, 2)
  assert.equal(groups[0].marketValue, 500)
  assert.equal(groups[0].derivatives.length, 1)
  assert.equal(groups[0].watchCandidates.length, 1)
  assert.equal(groups[1].marketValue, 0)
  assert.deepEqual(groups[1].derivatives, [])
  assert.equal(held[0].watchCandidates, undefined)
  const screen = buildOpportunityScreen({ groups, totalMarketValue: 500, dailyStats: ['TSLA', 'MSFT'].map(symbol => ({ symbol, lastClose: 100, sma20: 98, sma50: 95, sma200: 90 })) })
  const microsoft = screen.find(row => row.symbol === 'MSFT')
  assert.equal(microsoft.watchCount, 1)
  assert.equal(microsoft.productCount, 0)
  assert.equal(microsoft.weightPct, 0)
})
