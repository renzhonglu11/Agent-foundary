import assert from 'node:assert/strict'
import test from 'node:test'

import { buildHermesStressReviewPayload, buildPortfolioStressReport, buildStressScenarios } from './portfolioStress.js'
import { buildCustomPlan, buildPresetPlans, rankReductions } from './positionWhatIf.js'

function entry(item = {}, groupKey = 'a') {
  return {
    item: {
      symbol: 'CALL-A',
      instrument: 'Test Call',
      productType: 'open_end_turbo',
      optionType: 'call',
      price: 1,
      quantity: 1000,
      costBasis: 800,
      underlyingSpot: 100,
      strikePrice: 90,
      knockoutPrice: 90,
      ratio: 0.1,
      ...item,
    },
    group: { key: groupKey, groupName: groupKey.toUpperCase() },
    riskLeg: { legRiskStatus: 'OK', exposureConfidence: 'estimated_leverage', dataCompletenessRiskScore: 0, daysToExpiry: null, exposureWeightPct: 0.01 },
    primaryAction: 'HOLD',
  }
}

// A 10x turbo that is knocked out by a 10% fall, a 2x turbo, and a put on a third underlying.
const entries = [
  entry({ symbol: 'NEAR' }, 'a'),
  entry({ symbol: 'FAR', strikePrice: 50, knockoutPrice: 50, price: 5, quantity: 200 }, 'b'),
  entry({ symbol: 'HEDGE', optionType: 'put', instrument: 'Test Put', strikePrice: 150, knockoutPrice: 150, price: 5, quantity: 100 }, 'c'),
]
const scenarios = buildStressScenarios(20, null, false, { adverse: true })
const totals = { totalMarketValue: 10_000, totalCostBasis: 8_000 }
const report = plans => buildPortfolioStressReport(entries, 0, scenarios, totals, { plans })
const baseline = report([]).portfolios[0]

test('a plan trims the current holdings, keeps the proceeds as cash and never buys', () => {
  const result = report([{ id: 'plan', title: 'Plan', reductions: { NEAR: 100, FAR: 50, UNKNOWN: 100 } }])
  assert.equal(result.comparison, 'plans')
  assert.deepEqual(result.portfolios.map(p => [p.id, p.kind]), [['current', 'baseline'], ['plan', 'plan']])
  const plan = result.portfolios[1]
  assert.deepEqual(plan.products.map(p => [p.id, p.positionScalePct, p.currentValue]), [['FAR', 50, 500], ['HEDGE', 100, 500]])
  assert.equal(plan.currentValue + plan.cashValue, result.coverage.coveredValue)
  assert.equal(plan.cashValue, 1500)

  // Scenario P&L scales with the position: half of FAR plus all of HEDGE.
  const pnl = (portfolio, productId, scenarioId) => portfolio.products.find(p => p.id === productId).scenarioPnls.find(row => row.scenarioId === scenarioId).pnl
  for (const scenario of scenarios.filter(s => !s.adverse)) {
    const expected = pnl(baseline, 'FAR', scenario.id) / 2 + pnl(baseline, 'HEDGE', scenario.id)
    assert.ok(Math.abs(plan.scenarioResults.find(s => s.id === scenario.id).pnl - expected) < 0.011)
  }
  assert.ok(plan.worstPnl > baseline.worstPnl)

  // Selling everything leaves cash only.
  const cash = report([{ id: 'cash', title: 'Cash', reductions: { NEAR: 100, FAR: 100, HEDGE: 100 } }]).portfolios[1]
  assert.deepEqual([cash.productCount, cash.currentValue, cash.cashValue, cash.worstPnl], [0, 0, 2500, 0])
})

test('the report without plans still compares strategy candidates', () => {
  const legacy = buildPortfolioStressReport(entries, 0, scenarios, totals)
  assert.equal(legacy.comparison, 'candidates')
  assert.ok(legacy.portfolios.some(p => p.kind === 'defensive'))
  assert.ok(!report([]).portfolios.some(p => p.kind === 'defensive'))
})

test('reductions are ranked by worst-case loss avoided per euro of upside given up', () => {
  const rows = rankReductions(baseline, { reductionPct: 50, scope: 'product' })
  assert.deepEqual(rows.map(row => [row.id, row.kind]), [['FAR', 'tradeoff'], ['NEAR', 'tradeoff'], ['HEDGE', 'hedge']])
  const [far, near, hedge] = rows

  // FAR gains and loses 40% on a 20% move: one euro of upside buys one euro of protection.
  assert.deepEqual([far.worstImprovement, far.upGivenUp, far.efficiency], [200, 200, 1])
  // NEAR can only lose its value but doubles on the way up, so trimming it costs more upside than it saves.
  assert.deepEqual([near.releasedValue, near.worstImprovement, near.worstLossPct, near.upGivenUp, near.efficiency], [500, 500, 100, 1000, 0.5])
  // The put loses in the adverse scenario like everything else, yet it pays when all underlyings fall together.
  assert.ok(hedge.worstImprovement > 0)
  assert.equal(hedge.downImprovement, -100)
  assert.equal(hedge.efficiency, null)

  // Each row agrees with a full revaluation of the same plan.
  for (const row of rows) {
    const plan = report([{ id: 'check', title: 'Check', reductions: { [row.id]: 50 } }]).portfolios[1]
    assert.ok(Math.abs(plan.worstPnl - baseline.worstPnl - row.worstImprovement) < 0.02)
  }

  // The ratio does not depend on the size; the amounts do.
  const exit = rankReductions(baseline, { reductionPct: 100, scope: 'product' }).find(row => row.id === 'NEAR')
  assert.equal(exit.worstImprovement, 2 * near.worstImprovement)
  assert.equal(exit.efficiency, near.efficiency)
  assert.deepEqual(rankReductions(null), [])

  // Other orders keep the hedge last.
  assert.deepEqual(rankReductions(baseline, { sortBy: 'improvement' }).map(row => row.id), ['NEAR', 'FAR', 'HEDGE'])
  assert.deepEqual(rankReductions(baseline, { sortBy: 'riskDensity' }).map(row => [row.id, row.worstLossPct]), [['NEAR', 100], ['FAR', 40], ['HEDGE', 40]])

  // Without the adverse scenario the worst case is the synchronous fall, which the put cushions.
  const synchronous = buildPortfolioStressReport(entries, 0, buildStressScenarios(20), totals, { plans: [] }).portfolios[0]
  assert.ok(rankReductions(synchronous).find(row => row.id === 'HEDGE').worstImprovement < 0)
})

test('ranking by underlying moves all its products and re-chooses the adverse direction', () => {
  // A call and a put on the same underlying: selling the call flips the worst direction to up.
  const mixed = [
    entry({ symbol: 'CALL' }, 'a'),
    entry({ symbol: 'PUT', optionType: 'put', instrument: 'Test Put', strikePrice: 150, knockoutPrice: 150, price: 5, quantity: 100 }, 'a'),
  ]
  const build = plans => buildPortfolioStressReport(mixed, 0, scenarios, totals, { plans })
  const base = build([]).portfolios[0]
  const byProduct = rankReductions(base, { reductionPct: 100, scope: 'product' })
  const call = byProduct.find(row => row.id === 'CALL')
  const full = build([{ id: 'check', title: 'Check', reductions: { CALL: 100 } }]).portfolios[1]
  assert.ok(Math.abs(full.worstPnl - base.worstPnl - call.worstImprovement) < 0.02)
  // With only the put left, the worst direction for the underlying is now up.
  assert.equal(full.scenarioResults.find(s => s.adverse).pnl, full.scenarioResults.find(s => s.id === 'shock_4').pnl)
  // Before, it was the -10% move: the call is already knocked out while the put has gained least.
  assert.equal(base.scenarioResults.find(s => s.adverse).pnl, base.scenarioResults.find(s => s.id === 'shock_1').pnl)

  const [group] = rankReductions(base, { reductionPct: 100, scope: 'group' })
  assert.deepEqual([group.id, group.productCount, group.currentValue, group.weightPct], ['a', 2, 1500, 100])
  assert.equal(group.worstImprovement, -base.worstPnl)
})

test('preset plans follow the exit signals and the worst scenario, and the custom plan drops empty entries', () => {
  const signals = [{ id: 'NEAR', level: 'urgent' }, { id: 'FAR', level: 'warn' }, { id: 'HEDGE', level: 'ok' }, { id: 'SOLD', level: 'urgent' }]
  const presets = buildPresetPlans(baseline, signals)
  assert.deepEqual(presets.map(plan => [plan.id, plan.reductions]), [
    ['exit_urgent', { NEAR: 100 }],
    ['trim_flagged', { FAR: 50, NEAR: 100 }],
    ['halve_top_losses', { NEAR: 50, FAR: 50, HEDGE: 50 }],
  ])
  // Titles and descriptions must fit the Hermes request limits (80 and 240 bytes).
  for (const plan of presets) assert.ok(Buffer.byteLength(plan.title) <= 80)
  assert.deepEqual(buildPresetPlans(baseline, []).map(plan => plan.id), ['halve_top_losses'])
  assert.deepEqual(buildPresetPlans(null, signals), [])

  assert.equal(buildCustomPlan({ NEAR: 0 }), null)
  assert.deepEqual(buildCustomPlan({ NEAR: 25, FAR: 0 }).reductions, { NEAR: 25 })

  const payload = buildHermesStressReviewPayload(report(presets))
  assert.equal(payload.portfolios.length, 4)
  assert.ok(payload.assumptions.includes('exit_urgent: 1 sold, 0 reduced.'))
  assert.ok(payload.assumptions.includes('trim_flagged: 1 sold, 1 reduced.'))
  assert.ok(Buffer.byteLength(payload.assumptions) <= 1000)
  assert.ok(payload.portfolios.every(p => Buffer.byteLength(p.description) <= 240))
})
