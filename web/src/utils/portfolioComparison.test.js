import assert from 'node:assert/strict'
import test from 'node:test'
import { buildPortfolioAdjustments, buildScenarioContributions, buildShockTargets, comparePortfolioStress } from './portfolioComparison.js'
import { buildPortfolioStressReport } from './portfolioStress.js'

const baseline = {
  currentValue: 1000, worstPnl: -200,
  products: [
    { id: 'a', name: 'A', currentValue: 400, positionScalePct: 100 },
    { id: 'b', name: 'B', currentValue: 300, positionScalePct: 100 },
    { id: 'c', name: 'C', currentValue: 300, positionScalePct: 100 },
  ],
  scenarioResults: [{ id: 'down', movePct: -20, pnl: -200 }, { id: 'up', movePct: 20, pnl: 250 }],
}
const candidate = {
  currentValue: 550, worstPnl: -80,
  products: [baseline.products[0], { ...baseline.products[1], currentValue: 150, positionScalePct: 50 }],
  scenarioResults: [{ id: 'down', movePct: -20, pnl: -80 }, { id: 'up', movePct: 20, pnl: 140 }, { id: 'path', movePct: 0, pnl: -70, pathMoves: [-20, 0] }],
}

test('adjustment differences preserve common weights and cash conservation for retained, reduced and exited holdings', () => {
  const rows = buildPortfolioAdjustments(baseline, candidate)
  assert.deepEqual(rows.map(row => [row.id, row.action, row.beforeWeight, row.afterWeight]), [
    ['c', 'exit', 30, 0], ['b', 'reduce', 30, 15], ['a', 'retain', 40, 40],
  ])
  assert.equal(rows.reduce((sum, row) => sum + row.releasedValue, 0), baseline.currentValue - candidate.currentValue)
  assert.ok(buildPortfolioAdjustments(baseline, baseline).every(row => row.action === 'retain'))
  assert.deepEqual(buildPortfolioAdjustments(null, candidate), [])

  const reallocated = { ...candidate, products: [{ ...baseline.products[2], currentValue: 600, positionScalePct: 200 }] }
  const increase = buildPortfolioAdjustments(baseline, reallocated).find(row => row.id === 'c')
  assert.deepEqual([increase.id, increase.action, increase.changeValue, increase.releasedValue], ['c', 'increase', 300, 0])
})

test('comparison separates worst-case improvement from the same upward endpoint tradeoff', () => {
  assert.deepEqual(comparePortfolioStress(baseline, candidate), { worstPnlImprovement: 120, upPnlDifference: -110 })
  assert.deepEqual(comparePortfolioStress(baseline, baseline), { worstPnlImprovement: 0, upPnlDifference: 0 })
})

test('contributions retain negative, positive, zero and missing values for the selected scenario', () => {
  const portfolio = { products: [
    { id: 'a', scenarioPnls: [{ scenarioId: 'down', pnl: -100 }, { scenarioId: 'up', pnl: 50 }] },
    { id: 'b', scenarioPnls: [{ scenarioId: 'down', pnl: 20 }] },
    { id: 'c', scenarioPnls: [{ scenarioId: 'down', pnl: 0 }] },
    { id: 'd', scenarioPnls: [] },
  ] }
  const rows = buildScenarioContributions(portfolio, 'down')
  assert.equal(rows.find(row => row.id === 'a').pnl, -100)
  assert.equal(rows.find(row => row.id === 'b').pnl, 20)
  assert.equal(rows.find(row => row.id === 'c').pnl, 0)
  assert.equal(rows.find(row => row.id === 'd').pnl, null)
})

test('shock targets list only the underlyings held by the selected portfolio', () => {
  const entry = (symbol, key, name, riskStatus = 'OK') => ({
    item: { symbol, productType: 'optionsschein', optionType: 'call', price: 2, quantity: 100, underlyingSpot: 100, strikePrice: 95, ratio: 0.1, delta: 0.5, theta: -0.01, expiry: '2099-12-31' },
    group: { key, groupName: name },
    riskLeg: { legRiskStatus: riskStatus, exposureConfidence: 'live_delta', dataCompletenessRiskScore: 0, daysToExpiry: 365, exposureWeightPct: 0.01 },
    primaryAction: 'HOLD',
  })
  const report = buildPortfolioStressReport([
    entry('N1', 'nvda', 'NVIDIA'),
    entry('N2', 'nvda', 'NVIDIA'),
    entry('M1', 'mu', 'Micron', 'HARD_BLOCKED'),
    entry('A1', 'amd', 'AMD'),
  ], 0)
  const baselineTargets = buildShockTargets(report.portfolios.find(p => p.kind === 'baseline'))
  const candidateTargets = buildShockTargets(report.portfolios.find(p => p.kind === 'defensive'))
  assert.deepEqual(baselineTargets, [{ key: 'amd', name: 'AMD' }, { key: 'mu', name: 'Micron' }, { key: 'nvda', name: 'NVIDIA' }])
  assert.deepEqual(candidateTargets, [{ key: 'amd', name: 'AMD' }, { key: 'nvda', name: 'NVIDIA' }])
  assert.deepEqual(buildShockTargets(null), [])
})
