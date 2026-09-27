import assert from 'node:assert/strict'
import test from 'node:test'
import { buildPortfolioAdjustments, buildScenarioContributions, comparePortfolioStress } from './portfolioComparison.js'

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
