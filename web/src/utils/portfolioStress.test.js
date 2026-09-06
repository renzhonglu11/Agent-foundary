import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildHermesStressReviewPayload,
  buildPortfolioStressReport,
  calculatePositionStress,
} from './portfolioStress.js'

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
  const result = calculatePositionStress(product, { id: 'up', label: '+5%', movePct: 5 }, 30)

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
  const result = calculatePositionStress(product, { id: 'up', label: '+5%', movePct: 5 }, 30)

  assert.ok(result)
  assert.equal(result.method, 'factor_leverage')
  assert.equal(result.projectedPrice, 0.684)
  assert.equal(result.returnPct, -10)
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
