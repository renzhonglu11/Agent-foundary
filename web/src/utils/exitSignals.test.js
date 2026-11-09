import assert from 'node:assert/strict'
import test from 'node:test'

import { barrierTouchProbability, buildExitSignal, buildExitSignals, finishBeyondProbability } from './exitSignals.js'
import { blackScholesPrice, normalCdf } from './optionPricing.js'

function assertClose(actual, expected, tolerance = 1e-3) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} is not within ${tolerance} of ${expected}`)
}

function entry(item = {}, overrides = {}) {
  return {
    item: {
      symbol: 'DE000TEST01',
      instrument: 'Test Call',
      productType: 'optionsschein',
      optionType: 'call',
      price: 2,
      quantity: 100,
      underlyingSpot: 100,
      strikePrice: 95,
      ratio: 0.1,
      iv: 0.5,
      expiry: '2099-12-31',
      ...item,
    },
    group: { key: overrides.groupKey || 'test', groupName: 'Test', alpacaSymbol: overrides.alpacaSymbol || 'TEST' },
    riskLeg: { daysToExpiry: overrides.daysToExpiry ?? 365, leverage: null },
    primaryAction: 'HOLD',
  }
}

const turbo = (item = {}, overrides = {}) => entry({ productType: 'open_end_turbo', price: 1, strikePrice: 90, knockoutPrice: 90, iv: null, ...item }, overrides)
const codes = signal => signal.reasons.map(reason => reason.code)

test('barrier touch probability follows the reflection formula and its limits', () => {
  // σ 50%, 30 days, barrier 10% below: N(−0.6634) + e^0.10536 × N(−0.8067).
  const down = barrierTouchProbability({ spot: 100, barrier: 90, volatility: 0.5, years: 30 / 365 })
  assertClose(down, normalCdf(-0.6634) + Math.exp(0.10536) * normalCdf(-0.8067), 2e-4)
  assertClose(down, 0.4868, 2e-3)

  // Touching is at least twice as likely as merely finishing beyond, less the drift effect.
  const finishBelow = 1 - finishBeyondProbability({ spot: 100, level: 90, volatility: 0.5, years: 30 / 365, direction: 'call' })
  assert.ok(down > finishBelow && down < 2 * finishBelow + 0.02)

  const up = barrierTouchProbability({ spot: 100, barrier: 100 / 0.9, volatility: 0.5, years: 30 / 365 })
  assert.ok(up > 0.4 && up < down)
  assert.ok(barrierTouchProbability({ spot: 100, barrier: 95, volatility: 0.5, years: 30 / 365 }) > down)
  assert.ok(barrierTouchProbability({ spot: 100, barrier: 90, volatility: 0.5, years: 7 / 365 }) < down)
  assert.equal(barrierTouchProbability({ spot: 100, barrier: 100, volatility: 0.5, years: 0.1 }), 1)
  assert.equal(barrierTouchProbability({ spot: 100, barrier: 90, volatility: null, years: 0.1 }), null)
})

test('finish probabilities for calls and puts are complementary', () => {
  const model = { spot: 100, level: 110, volatility: 0.4, years: 0.5, rate: 0.02 }
  const call = finishBeyondProbability({ ...model, direction: 'call' })
  assertClose(call + finishBeyondProbability({ ...model, direction: 'put' }), 1, 1e-9)
  assertClose(finishBeyondProbability({ spot: 100, level: 100, volatility: 0.4, years: 1, direction: 'call' }), normalCdf(-0.2), 1e-9)
})

test('a turbo near its barrier is flagged by knock-out probability, a distant one is not', () => {
  const near = buildExitSignal(turbo({ knockoutPrice: 96, strikePrice: 96 }), { impliedVolatility: 0.5 })
  assert.equal(near.level, 'urgent')
  assert.deepEqual(codes(near), ['knockout_7d'])
  assert.equal(near.barrier.distancePct, 4)
  assert.ok(near.barrier.probability30d > near.barrier.probability7d)

  const mid = buildExitSignal(turbo({ knockoutPrice: 88, strikePrice: 88 }), { impliedVolatility: 0.5 })
  assert.deepEqual(codes(mid), ['knockout_30d'])
  assert.equal(mid.level, 'warn')

  const far = buildExitSignal(turbo({ knockoutPrice: 50, strikePrice: 50 }), { impliedVolatility: 0.5 })
  assert.equal(far.level, 'ok')
  assert.ok(far.barrier.dailySigmas > 20)

  const breached = buildExitSignal(turbo({ knockoutPrice: 101 }), { impliedVolatility: 0.5 })
  assert.deepEqual(codes(breached), ['barrier_breached'])

  // A put's barrier sits above the spot.
  const put = buildExitSignal(turbo({ optionType: 'put', instrument: 'TurboP', knockoutPrice: 104, strikePrice: 104 }), { impliedVolatility: 0.5 })
  assert.equal(put.barrier.distancePct, 4)
  assert.equal(put.level, 'urgent')
})

test('a far out-of-the-money warrant is flagged by break-even probability and decay', () => {
  const quote = (strike, years) => blackScholesPrice({ spot: 100, strike, years, volatility: 0.5, rate: 0.02, direction: 'call' }) * 0.1
  const lottery = buildExitSignal(entry({ strikePrice: 150, price: quote(150, 60 / 365) }, { daysToExpiry: 60 }), { impliedVolatility: 0.5 })
  assert.equal(lottery.level, 'urgent')
  assert.ok(codes(lottery).includes('break_even'))
  assert.ok(lottery.breakEven.requiredMovePct > 50)
  assert.ok(lottery.breakEven.probability < 0.05)
  assert.ok(lottery.breakEven.worthlessProbability > 0.9)
  assert.equal(lottery.breakEven.timeValuePct, 100)
  assert.ok(lottery.decay.return30dPct < lottery.decay.return7dPct)

  const solid = buildExitSignal(entry({ strikePrice: 80, price: quote(80, 1) }), { impliedVolatility: 0.5 })
  assert.equal(solid.level, 'ok')
  assertClose(solid.breakEven.level, 80 + quote(80, 1) / 0.1, 1e-3)
  assert.ok(solid.breakEven.probability > 0.25)

  const expiring = buildExitSignal(entry({}, { daysToExpiry: 5 }), { impliedVolatility: 0.5 })
  assert.ok(codes(expiring).includes('expiry'))
  assert.equal(expiring.level, 'urgent')
})

test('ruin risk uses the highest volatility, pay-off odds the implied one, and no volatility is not a pass', () => {
  const stats = { symbol: 'TEST', realizedVol20d: 0.8, realizedVol60d: 0.6, sma20: 100, sma50: 100, lastClose: 100, high52w: 125 }
  const both = buildExitSignal(turbo({ knockoutPrice: 70, strikePrice: 70 }), { stats, impliedVolatility: 0.5 })
  assert.deepEqual([both.volatility.riskPct, both.volatility.riskSource], [80, 'realized20'])
  assert.deepEqual([both.volatility.payoffPct, both.volatility.payoffSource], [50, 'implied'])
  assert.deepEqual([both.volatility.realized20Pct, both.volatility.realized60Pct, both.volatility.impliedPct], [80, 60, 50])
  assert.equal(buildExitSignal(turbo(), { impliedVolatility: 0.5 }).volatility.riskSource, 'implied')

  // A spike in recent volatility must not raise a far out-of-the-money warrant's odds.
  const warrant = entry({ strikePrice: 150, price: 0.05 }, { daysToExpiry: 200 })
  const calm = buildExitSignal(warrant, { impliedVolatility: 0.5 })
  const spiking = buildExitSignal(warrant, { stats, impliedVolatility: 0.5 })
  assert.equal(spiking.breakEven.probability, calm.breakEven.probability)
  // Without warrant IV the 60-day history stands in.
  assert.equal(buildExitSignal(warrant, { stats }).volatility.payoffSource, 'realized60')

  const blind = buildExitSignal(turbo({ knockoutPrice: 70, strikePrice: 70 }))
  assert.equal(blind.level, 'unknown')
  assert.equal(blind.barrier.probability7d, null)
  assert.equal(blind.barrier.distancePct, 30)
})

test('trend is read against the position direction', () => {
  const falling = { symbol: 'TEST', realizedVol60d: 0.3, sma20: 104, sma50: 110, lastClose: 100, high52w: 125, return20dPct: -8 }
  const call = buildExitSignal(turbo({ knockoutPrice: 50, strikePrice: 50, underlyingSpotRaw: 100 }), { stats: falling })
  assert.equal(call.trend.state, 'against')
  assert.deepEqual([call.trend.vsSma50Pct, call.trend.fromHighPct, call.trend.return20dPct], [-9.09, -20, -8])
  assert.deepEqual(codes(call), ['trend'])
  assert.equal(call.level, 'warn')

  const put = buildExitSignal(turbo({ optionType: 'put', instrument: 'TurboP', knockoutPrice: 150, strikePrice: 150, underlyingSpotRaw: 100 }), { stats: falling })
  assert.equal(put.trend.state, 'with')
  assert.equal(put.level, 'ok')

  // Price below the 50-day average while the 20-day average is still above it.
  const mixed = buildExitSignal(turbo({ knockoutPrice: 50, strikePrice: 50 }), { stats: { ...falling, sma20: 112 } })
  assert.equal(mixed.trend.state, 'mixed')
  // Within 3% of the average is not counted as a trend.
  const hugging = buildExitSignal(turbo({ knockoutPrice: 50, strikePrice: 50, underlyingSpotRaw: 100 }), { stats: { ...falling, sma20: 101, sma50: 102 } })
  assert.equal(hugging.trend.state, 'mixed')
  assert.equal(hugging.level, 'ok')
  assert.equal(buildExitSignal(turbo(), { impliedVolatility: 0.5 }).trend, null)
})

test('factor certificates report the one-day move that erases them', () => {
  const stats = { symbol: 'TEST', realizedVol60d: 0.8, worstDayPct: -21, bestDayPct: 18, sma50: 100, sma20: 100, lastClose: 100 }
  const factor = item => entry({ productType: 'factor_certificate', instrument: 'FaktL', leverage: 5, iv: null, strikePrice: null, ...item })
  const long = buildExitSignal(factor(), { stats })
  assert.equal(long.factor.wipeoutMovePct, 20)
  assert.equal(long.factor.worstDayLossPct, 100)
  assert.ok(codes(long).includes('factor_wipeout'))

  // The short side is hurt by the best day instead: 18% × 5 = 90%.
  const short = buildExitSignal(factor({ optionType: 'put', instrument: 'FaktS' }), { stats })
  assert.equal(short.factor.worstDayLossPct, 90)
  assert.ok(codes(short).includes('factor_day'))
  // 2σ day at 80% volatility is about 10%, times 5.
  assertClose(short.factor.twoSigmaDayLossPct, 5 * 2 * 0.8 / Math.sqrt(252) * 100, 0.01)
})

test('signals are matched to daily statistics by symbol, ranked by level then value and totalled', () => {
  const entries = [
    turbo({ symbol: 'FAR', knockoutPrice: 50, strikePrice: 50 }, { groupKey: 'far', alpacaSymbol: 'far' }),
    turbo({ symbol: 'NEAR', knockoutPrice: 96, strikePrice: 96, quantity: 10 }, { groupKey: 'near', alpacaSymbol: 'NEAR' }),
    turbo({ symbol: 'BLIND', knockoutPrice: 70, strikePrice: 70 }, { groupKey: 'blind', alpacaSymbol: 'BLIND' }),
    entry({ symbol: 'WARRANT' }, { groupKey: 'blind' }),
  ]
  const report = buildExitSignals(entries, [
    { symbol: 'FAR', realizedVol60d: 0.3, sma20: 100, sma50: 100, lastClose: 100 },
    { symbol: 'NEAR', realizedVol60d: 0.5, sma20: 100, sma50: 100, lastClose: 100 },
  ])
  assert.deepEqual(report.signals.map(signal => [signal.id, signal.level]), [['NEAR', 'urgent'], ['WARRANT', 'ok'], ['FAR', 'ok'], ['BLIND', 'ok']])
  // BLIND has no history but borrows the implied volatility of the warrant on the same underlying.
  assert.equal(report.signals.find(signal => signal.id === 'BLIND').volatility.riskSource, 'implied')
  assert.deepEqual(report.counts, { urgent: 1, warn: 0, ok: 3, unknown: 0 })
  assert.equal(report.values.urgent, 10)
  assert.equal(report.withHistoryCount, 2)
  assert.deepEqual(buildExitSignals(null, null).signals, [])
})
