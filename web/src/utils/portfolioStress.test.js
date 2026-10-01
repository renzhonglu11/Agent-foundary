import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildHermesStressReviewPayload,
  buildPortfolioStressReport,
  calculatePositionStress,
  buildStressScenarios,
  buildDirectPriceStress,
} from './portfolioStress.js'

test('direct stress uses authoritative holdings values including bonds and signed positions', () => {
  const positions = [
    { symbol: 'A', valuationSource: 'pdf', quantity: 10, lastPrice: 15, marketValue: 150 },
    { symbol: 'B', valuationSource: 'pdf_bond_value', assetClass: 'BOND', quantity: 1000, lastPrice: 98, marketValue: 980 },
    { symbol: 'C', valuationSource: 'transaction_fallback', quantity: -1, lastPrice: 30, marketValue: -30 },
  ]
  const result = buildDirectPriceStress(positions, [{ item: { symbol: 'A', price: 12 } }])
  assert.equal(result[2].value, 1100)
  assert.equal(result[2].pnl, -1100)
})

function entry(overrides = {}) {
  const item = {
    id: 'product-1',
    symbol: 'DE000TEST01',
    stockName: 'Test Call',
    productType: 'optionsschein',
    optionType: 'call',
    price: 2,
    quantity: 100,
    marketValue: 200,
    costBasis: 150,
    underlyingSpot: 100,
    strikePrice: 95,
    ratio: 0.1,
    delta: 0.5,
    theta: -0.01,
    iv: 0.42,
    expiry: '2099-12-31',
    ...overrides.item,
  }
  return {
    item,
    group: { key: overrides.groupKey || 'test', groupName: overrides.groupName || 'Test' },
    riskGroup: { groupActionLabel: overrides.groupActionLabel || 'ADD_ALLOWED' },
    riskLeg: {
      legRiskStatus: overrides.riskStatus || 'OK',
      exposureConfidence: overrides.confidence || 'live_delta',
      dataCompletenessRiskScore: overrides.missingScore ?? 0,
      daysToExpiry: overrides.daysToExpiry ?? 365,
      barrierDistancePct: overrides.barrierDistancePct ?? null,
      exposureWeightPct: overrides.exposureWeightPct ?? 0.01,
      leverage: overrides.leverage ?? null,
    },
    primaryAction: overrides.primaryAction || 'BUY',
  }
}

test('stress revalues stale market value from price and quantity and never loses over current long value', () => {
  const product = entry({ item: { productType: 'factor_certificate', leverage: 3, marketValue: 100 } })
  const result = calculatePositionStress(product, { id: 'down', movePct: -50 }, 0)
  assert.equal(result.currentValue, 200)
  assert.equal(result.pnl, -200)
  assert.equal(result.returnPct, -100)
})

test('instantaneous flat shock has no theta loss and targets leave other groups unchanged', () => {
  assert.equal(calculatePositionStress(entry(), { id: 'flat', movePct: 0 }, 0).pnl, 0)
  assert.equal(calculatePositionStress(entry(), { id: 'shock', movePct: -20, targetGroup: 'other' }, 0).pnl, 0)
  const inconsistentSpot = entry({ item: { delta: null, omega: null, underlyingSpot: 200 } })
  assert.equal(calculatePositionStress(inconsistentSpot, { id: 'flat', movePct: 0 }, 0).pnl, 0)
})

test('two reset periods compound factor returns and detect an intermediate knockout', () => {
  const scenario = buildStressScenarios(10, null, true).find(s => s.id === 'recovery')
  const factor = entry({ item: { productType: 'factor_certificate', leverage: 3 } })
  assert.equal(calculatePositionStress(factor, scenario, 0).projectedPrice, 1.8667)
  const turbo = entry({ item: { productType: 'open_end_turbo', knockoutPrice: 95 } })
  const knockedOut = calculatePositionStress(turbo, scenario, 7)
  assert.equal(knockedOut.projectedPrice, 0)
  assert.equal(knockedOut.barrierBreached, true)
})

test('coverage counts uncomputable holdings and consistent account capital includes untested assets', () => {
  const valid = entry()
  const missing = entry({ item: { symbol: 'MISSING', underlyingSpot: null } })
  const positions = [
    { symbol: 'DE000TEST01', quantity: 100, lastPrice: 1, marketValue: 100 },
    { symbol: 'MISSING', quantity: 100, lastPrice: 2, marketValue: 200 },
    { symbol: 'OTHER', quantity: 100, lastPrice: 5, marketValue: 500 },
  ]
  const report = buildPortfolioStressReport([valid, missing], 0, undefined, { totalMarketValue: 800, positions })
  assert.equal(report.coverage.accountValue, 900)
  assert.equal(report.coverage.coveredValue, 200)
  assert.equal(report.coverage.outsideValue, 700)
  assert.equal(report.coverage.omittedCount, 1)
  assert.equal(report.coverage.omittedValue, 200)
  assert.equal(report.coverage.omitted[0].name, 'Test Call')
  assert.equal(buildDirectPriceStress(positions, [valid, missing])[2].pnl, -900)
})

test('candidate cash plus retained holdings equals baseline capital and comparison uses it', () => {
  const entries = [entry(), entry({ item: { symbol: 'B' }, groupKey: 'b', riskStatus: 'HARD_BLOCKED' })]
  const report = buildPortfolioStressReport(entries, 0, undefined, { totalMarketValue: 1000 })
  const candidate = report.portfolios.find(p => p.kind === 'defensive')
  assert.equal(candidate.cashValue + candidate.currentValue, report.coverage.coveredValue)
  for (const result of candidate.scenarioResults) {
    assert.equal(result.testedCapitalReturnPct, Math.round(result.pnl / 400 * 10000) / 100)
    assert.equal(result.accountImpactPct, Math.round(result.pnl / 1000 * 10000) / 100)
  }
  const payload = buildHermesStressReviewPayload(report)
  assert.ok(payload.portfolios.every(p => p.description.length <= 240))
  assert.equal(payload.portfolios[1].currentValue, 400)
})

test('all missing entries remain visible even when no scenario can be calculated', () => {
  const report = buildPortfolioStressReport([entry({ item: { underlyingSpot: null } })], 0, undefined, { totalMarketValue: 500 })
  assert.equal(report.portfolios.length, 0)
  assert.equal(report.coverage.omittedCount, 1)
  assert.equal(report.coverage.outsideValue, 500)
})

test('call stress loses in a selloff and gains in a rally', () => {
  const product = entry()
  const down = calculatePositionStress(product, { id: 'down', label: '-10%', movePct: -10 }, 30)
  const up = calculatePositionStress(product, { id: 'up', label: '+10%', movePct: 10 }, 30)

  assert.ok(down)
  assert.ok(up)
  assert.ok(down.pnl < 0)
  assert.ok(up.pnl > down.pnl)
})

test('put direction offsets a falling-underlying scenario', () => {
  const product = entry({
    item: { optionType: 'put', stockName: 'Test Put', delta: -0.5, strikePrice: 105 },
  })
  const down = calculatePositionStress(product, { id: 'down', label: '-10%', movePct: -10 }, 7)

  assert.ok(down)
  assert.ok(down.pnl > 0)
})

test('open-end turbo is written down when the stress crosses its barrier', () => {
  const product = entry({
    item: {
      productType: 'open_end_turbo',
      knockoutPrice: 95,
      leverage: 4,
      delta: null,
      theta: null,
    },
  })
  const result = calculatePositionStress(product, { id: 'down', label: '-10%', movePct: -10 }, 30)

  assert.ok(result)
  assert.equal(result.barrierBreached, true)
  assert.equal(result.projectedPrice, 0)
  assert.equal(result.pnl, -200)
})

test('factor certificate uses signed leverage without option history', () => {
  const product = entry({
    item: {
      productType: 'factor_certificate',
      leverage: 3,
      strikePrice: 500,
      ratio: 1,
      delta: null,
      theta: null,
    },
  })
  const result = calculatePositionStress(product, { id: 'up', label: '+5%', movePct: 5 }, 0)

  assert.ok(result)
  assert.equal(result.method, 'factor_leverage')
  assert.equal(result.returnPct, 15)
})

test('short factor stress reverses the endpoint shock and ignores option strike', () => {
  const product = entry({
    item: {
      productType: 'factor_certificate',
      optionType: 'put',
      price: 0.76,
      quantity: 772,
      marketValue: 586.72,
      underlyingSpot: 4.49,
      strikePrice: 10.538,
      ratio: 1,
      leverage: 2,
      delta: null,
      theta: null,
    },
  })
  const result = calculatePositionStress(product, { id: 'up', label: '+5%', movePct: 5 }, 0)

  assert.ok(result)
  assert.equal(result.method, 'factor_leverage')
  assert.equal(result.projectedPrice, 0.684)
  assert.equal(result.returnPct, -10)
})

function assertClose(actual, expected, tolerance = 1e-4) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} is not within ${tolerance} of ${expected}`)
}

function turbo(item = {}, overrides = {}) {
  return entry({
    ...overrides,
    item: { productType: 'open_end_turbo', price: 0.5, strikePrice: 95, ratio: 0.1, delta: null, theta: null, ...item },
  })
}

const flat = { id: 'flat', movePct: 0 }

test('turbo financing accrues on the strike over the horizon but not instantly', () => {
  assert.equal(calculatePositionStress(turbo(), flat, 0).pnl, 0)
  const call = calculatePositionStress(turbo(), flat, 30)
  // EUR reference 2% + 3% spread on strike × ratio = 9.5.
  assertClose(call.projectedPrice, 0.5 - 9.5 * 0.05 * 30 / 360)
  assert.equal(call.method, 'intrinsic+financing')
  // Without a strike, leverage 20 implies the same financed amount: price × (L − 1).
  assertClose(calculatePositionStress(turbo({ strikePrice: null, leverage: 20 }), flat, 30).projectedPrice, call.projectedPrice)

  const put = { optionType: 'put', stockName: 'Test Put', strikePrice: 105 }
  // Puts earn reference minus spread: negative in EUR, positive in USD.
  assertClose(calculatePositionStress(turbo(put), flat, 30).projectedPrice, 0.5 + 10.5 * -0.01 * 30 / 360)
  const usdPut = turbo({ ...put, underlyingSpotRawCurrency: 'USD', underlyingSpotUsdEurRate: 1 })
  assertClose(calculatePositionStress(usdPut, flat, 30).projectedPrice, 0.5 + 10.5 * 0.01 * 30 / 360)
})

test('open-end barriers move with the financing level while closed-end barriers stay fixed', () => {
  const openEnd = turbo({ knockoutPrice: 99.6 })
  assert.equal(calculatePositionStress(openEnd, flat, 0).barrierBreached, false)
  assert.equal(calculatePositionStress(openEnd, flat, 30).barrierBreached, true)

  const closedEnd = turbo({ productType: 'knock_out', knockoutPrice: 99.6 }, { daysToExpiry: 10 })
  const result = calculatePositionStress(closedEnd, flat, 30)
  assert.equal(result.barrierBreached, false)
  assertClose(result.projectedPrice, 0.5 - 9.5 * 0.05 * 10 / 360)
})

test('factor carry charges financing, fee and volatility drag on top of the endpoint shock', () => {
  const long = entry({ item: { productType: 'factor_certificate', leverage: 3, delta: null, theta: null } })
  assert.equal(calculatePositionStress(long, flat, 0).pnl, 0)
  const longResult = calculatePositionStress(long, flat, 30)
  // β = 3, σ = own IV 42%: financing (L − 1)(r + s), fee 1%, drag ½β(β − 1)σ².
  assertClose(longResult.projectedPrice, 2 * Math.exp(-2 * 0.05 * 30 / 360 - (0.01 + 3 * 0.42 ** 2) * 30 / 365))
  assert.equal(longResult.method, 'factor_leverage+carry_iv')
  const up = calculatePositionStress(long, { id: 'up', movePct: 5 }, 30)
  assertClose(up.projectedPrice, 2.3 * longResult.projectedPrice / 2)

  const short = entry({ item: { productType: 'factor_certificate', optionType: 'put', stockName: 'FaktS', leverage: 2, iv: null, delta: null, theta: null } })
  short.group.derivatives = [{ iv: 0.3 }, { iv: 60 }, { iv: null }]
  const shortResult = calculatePositionStress(short, flat, 30)
  // β = −2, σ = median sibling IV 45%: earns (L + 1)(r − s), drag ½β(β − 1)σ² = 3σ².
  assertClose(shortResult.projectedPrice, 2 * Math.exp(3 * -0.01 * 30 / 360 - (0.01 + 3 * 0.45 ** 2) * 30 / 365))
  assert.equal(shortResult.method, 'factor_leverage+carry_group_iv')

  short.group.derivatives = []
  assert.equal(calculatePositionStress(short, flat, 30).method, 'factor_leverage+carry_default_vol')
})

test('candidate scoring reference charges turbo and factor carry like warrant decay', () => {
  const factor = entry({ item: { symbol: 'FACTOR', productType: 'factor_certificate', leverage: 3, delta: null, theta: null }, groupKey: 'factor' })
  for (const product of [turbo(), factor]) {
    const flatPnl = report => report.portfolios[0].scenarioResults.find(s => s.id === 'flat').pnl
    assert.equal(flatPnl(buildPortfolioStressReport([product], 0)), 0)
    assert.ok(flatPnl(buildPortfolioStressReport([product], 30)) < 0)
  }
})

test('candidates reallocate the common tested capital equally instead of keeping small positions', () => {
  const entries = [
    entry({ item: { symbol: 'A' }, groupKey: 'a' }),
    entry({ item: { symbol: 'B' }, groupKey: 'b' }),
    entry({ item: { symbol: 'C' }, groupKey: 'c' }),
    entry({ item: { symbol: 'BLOCKED' }, groupKey: 'blocked', riskStatus: 'HARD_BLOCKED' }),
  ]
  const report = buildPortfolioStressReport(entries, 0, undefined, { totalMarketValue: 1000 })
  const defensive = report.portfolios.find(p => p.kind === 'defensive')
  assert.equal(report.coverage.coveredValue, 800)
  assert.equal(defensive.currentValue, 800)
  assert.equal(defensive.cashValue, 0)
  assert.ok(defensive.products.every(p => p.positionScalePct === 133.33 && p.allocationPct === 33.33))
})

test('products priced with a fallback model rank below priced ones and are flagged', () => {
  const priced = entry({ item: { symbol: 'PRICED', theta: -0.001 }, groupKey: 'priced' })
  // No delta, omega, strike, ratio or leverage: the stress falls back to 1x.
  const fallback = entry({ item: { symbol: 'FALLBACK', delta: null, theta: null, strikePrice: null, ratio: null, iv: null }, groupKey: 'fallback' })
  const report = buildPortfolioStressReport([fallback, priced], 30)
  const defensive = report.portfolios.find(p => p.kind === 'defensive')
  const methods = defensive.products.find(p => p.id === 'FALLBACK').scenarioMethods.map(m => m.method)
  assert.ok(methods.every(method => method.includes('default_leverage')))
  // Unpenalized, the 1x fallback's -10% worst case would outrank the priced -26.5%.
  assert.deepEqual(defensive.products.map(p => p.id), ['PRICED', 'FALLBACK'])
  assert.ok(defensive.products[1].selectionFlags.includes('MODEL_FALLBACK'))
  assert.ok(!defensive.products[0].selectionFlags.includes('MODEL_FALLBACK'))
})

test('portfolio report excludes blocked legs from candidate combinations but keeps the baseline', () => {
  const entries = [
    entry({ item: { id: 'a', symbol: 'A' }, groupKey: 'a' }),
    entry({ item: { id: 'b', symbol: 'B' }, groupKey: 'b' }),
    entry({ item: { id: 'c', symbol: 'C' }, groupKey: 'c' }),
    entry({ item: { id: 'blocked', symbol: 'BLOCKED' }, groupKey: 'blocked', riskStatus: 'HARD_BLOCKED', primaryAction: 'SELL' }),
  ]
  const report = buildPortfolioStressReport(entries, 30)

  assert.equal(report.productCount, 4)
  assert.equal(report.eligibleProductCount, 3)
  assert.equal(report.portfolios.length, 4)
  assert.equal(report.portfolios[0].productCount, 4)
  assert.ok(report.portfolios.slice(1).every((portfolio) => portfolio.products.every((product) => product.id !== 'BLOCKED')))

  const payload = buildHermesStressReviewPayload(report)
  assert.equal(payload.modelMode, 'stress_only')
  assert.equal(payload.portfolios.length, 4)
  assert.ok(payload.portfolios.every((portfolio) => portfolio.scenarios.length === 5))
  const product = payload.portfolios[0].products.find((item) => item.id === 'A')
  assert.equal(product.delta, 0.5)
  assert.equal(product.theta, -0.01)
  assert.equal(product.ivPct, 42)
  assert.equal(product.daysToExpiry, 365)
  assert.deepEqual(
    product.scenarioMethods.map(({ scenarioId }) => scenarioId),
    payload.portfolios[0].scenarios.map(({ id }) => id),
  )
  assert.ok(product.scenarioMethods.every(({ method }) => method === 'delta+theta'))
})

test('portfolio candidates manage WATCH reasons separately and register ROLL opportunities', () => {
  const entries = [
    entry({ item: { id: 'a', symbol: 'A' }, groupKey: 'a' }),
    entry({ item: { id: 'b', symbol: 'B' }, groupKey: 'b' }),
    entry({ item: { id: 'c', symbol: 'C' }, groupKey: 'c' }),
    entry({
      item: { id: 'barrier-watch', symbol: 'BARRIER-WATCH' },
      groupKey: 'barrier-watch',
      riskStatus: 'WATCH',
      primaryAction: 'SELL',
      barrierDistancePct: 0.08,
    }),
    entry({
      item: { id: 'concentrated-watch', symbol: 'CONCENTRATED-WATCH' },
      groupKey: 'concentrated-watch',
      riskStatus: 'WATCH',
      primaryAction: 'SELL',
      exposureWeightPct: 0.16,
    }),
    entry({
      item: { id: 'roll', symbol: 'ROLL' },
      groupKey: 'roll',
      riskStatus: 'WATCH',
      primaryAction: 'ROLL',
      daysToExpiry: 5,
    }),
    entry({
      item: { id: 'untrusted-watch', symbol: 'UNTRUSTED-WATCH' },
      groupKey: 'untrusted-watch',
      riskStatus: 'WATCH',
      primaryAction: 'SELL',
      missingScore: 6,
    }),
  ]
  const report = buildPortfolioStressReport(entries, 30, undefined, {
    totalMarketValue: 2_000,
    totalCostBasis: 1_500,
  })
  const defensive = report.portfolios.find((portfolio) => portfolio.kind === 'defensive')
  const balanced = report.portfolios.find((portfolio) => portfolio.kind === 'balanced')
  const elastic = report.portfolios.find((portfolio) => portfolio.kind === 'elastic')

  assert.equal(report.productCount, 7)
  assert.equal(report.eligibleProductCount, 5)
  assert.equal(report.excludedProductCount, 2)
  assert.equal(report.watchIncludedProductCount, 2)
  assert.equal(report.exposureCappedProductCount, 1)
  assert.equal(report.rollOpportunities.length, 1)
  assert.equal(report.rollOpportunities[0].id, 'ROLL')
  assert.ok(defensive)
  assert.ok(balanced)
  assert.ok(elastic)
  assert.ok(!defensive.products.some((product) => product.id === 'BARRIER-WATCH'))
  assert.ok(!balanced.products.some((product) => product.id === 'BARRIER-WATCH'))
  assert.ok(elastic.products.some((product) => product.id === 'BARRIER-WATCH'))
  assert.ok(report.portfolios.slice(1).every((portfolio) => (
    portfolio.products.every((product) => !['ROLL', 'UNTRUSTED-WATCH'].includes(product.id))
  )))

  const capped = defensive.products.find((product) => product.id === 'CONCENTRATED-WATCH')
  assert.ok(capped)
  assert.equal(capped.positionScalePct, 50)
  assert.equal(capped.currentValue, 100)
  assert.equal(capped.navWeightPct, 5)
  assert.equal(capped.capitalWeightPct, 5)
  assert.ok(capped.selectionFlags.includes('EXPOSURE_CAPPED_8_PCT'))
})

test('portfolio report keeps internal, NAV, and invested-capital weights separate', () => {
  const entries = [
    entry({ item: { id: 'a', symbol: 'A' }, groupKey: 'a' }),
    entry({ item: { id: 'b', symbol: 'B' }, groupKey: 'b' }),
    entry({ item: { id: 'c', symbol: 'C' }, groupKey: 'c' }),
  ]
  const report = buildPortfolioStressReport(entries, 30, undefined, {
    totalMarketValue: 1_000,
    totalCostBasis: 750,
  })
  const baseline = report.portfolios.find((portfolio) => portfolio.kind === 'baseline')
  const product = baseline.products.find((item) => item.id === 'A')

  assert.equal(baseline.navWeightPct, 60)
  assert.equal(baseline.capitalWeightPct, 60)
  assert.equal(product.allocationPct, 33.33)
  assert.equal(product.navWeightPct, 20)
  assert.equal(product.capitalWeightPct, 20)

  const payload = buildHermesStressReviewPayload(report)
  assert.equal(payload.portfolios[0].navWeightPct, 60)
  assert.equal(payload.portfolios[0].products[0].capitalWeightPct, 20)
})

test('optional shocks preserve portfolio identities, members, sizing and cash across ranges and horizons', () => {
  const entries = Array.from({ length: 12 }, (_, i) => entry({
    item: { symbol: `P${i}`, delta: 0.1 + i * 0.1 },
    groupKey: `g${i}`,
    exposureWeightPct: i === 0 ? 0.16 : 0.01,
  }))
  const totals = { totalMarketValue: 3000 }
  const base = buildPortfolioStressReport(entries, 0, buildStressScenarios(10), totals)
  const composition = report => report.portfolios.map(p => ({
    id: p.id, value: p.currentValue, cash: p.cashValue,
    products: p.products.map(({ id, allocationPct, positionScalePct }) => ({ id, allocationPct, positionScalePct })),
  }))
  for (const horizon of [0, 7, 30, 90]) {
    for (const target of [null, 'g0', 'g11']) {
      const report = buildPortfolioStressReport(entries, horizon, buildStressScenarios(50, target, horizon > 0), totals)
      assert.deepEqual(composition(report), composition(base))
    }
  }
  const targeted = buildPortfolioStressReport(entries, 0, buildStressScenarios(10, 'g0'), totals)
  assert.notDeepEqual(targeted.portfolios[0].scenarioResults, base.portfolios[0].scenarioResults)
  assert.ok(targeted.portfolios.find(p => p.kind === 'defensive').products.some(p => p.id === 'P0'))
  assert.ok(targeted.portfolios.find(p => p.kind === 'defensive').worstPnl < 0)
})

test('missing expiry parameters cannot silently change membership when the stress horizon changes', () => {
  const entries = [entry(), entry({ item: { symbol: 'MISSING-EXPIRY', strikePrice: null, ratio: null }, daysToExpiry: 60 })]
  const instant = buildPortfolioStressReport(entries, 0)
  const future = buildPortfolioStressReport(entries, 90)
  assert.deepEqual(instant.portfolios.map(p => p.products.map(p => p.id)), future.portfolios.map(p => p.products.map(p => p.id)))
  assert.equal(instant.coverage.omittedCount, 1)
})

test('no direct shock exposure preserves portfolio value and distinguishes time effects from zero instant P&L', () => {
  const entries = [entry()]
  const scenarios = buildStressScenarios(20, 'unheld-underlying')
  const instant = buildPortfolioStressReport(entries, 0, scenarios)
  for (const portfolio of instant.portfolios) {
    assert.equal(portfolio.shockProductCount, 0)
    assert.ok(portfolio.currentValue > 0)
    assert.ok(portfolio.scenarioResults.every(s => s.pnl === 0 && s.projectedValue === portfolio.currentValue))
  }
  const future = buildPortfolioStressReport(entries, 7, scenarios)
  assert.equal(future.portfolios[0].shockProductCount, 0)
  assert.ok(future.portfolios[0].worstPnl < 0)
  const direct = buildPortfolioStressReport(entries, 0, buildStressScenarios(20, 'test'))
  assert.equal(direct.portfolios[0].shockProductCount, 1)
  assert.ok(direct.portfolios[0].worstPnl < 0)
  const all = buildPortfolioStressReport(entries, 0, buildStressScenarios(20))
  assert.equal(all.portfolios[0].shockProductCount, all.portfolios[0].productCount)
})

test('product scenario contributions reconcile to portfolio P&L after exposure caps', () => {
  const report = buildPortfolioStressReport([
    entry({ exposureWeightPct: 0.16 }),
    entry({ item: { symbol: 'PUT', optionType: 'put', delta: -0.5 }, groupKey: 'put' }),
  ], 7, buildStressScenarios(20, null, true))
  for (const portfolio of report.portfolios) {
    for (const scenario of portfolio.scenarioResults) {
      const sum = portfolio.products.reduce((sum, product) => sum + product.scenarioPnls.find(row => row.scenarioId === scenario.id).pnl, 0)
      assert.ok(Math.abs(sum - scenario.pnl) < 0.011)
    }
  }
})
