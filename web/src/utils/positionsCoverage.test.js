import assert from 'node:assert/strict'
import test from 'node:test'

import { buildPositionsCoverage } from './positionsCoverage.js'

const positions = [
  { symbol: 'CALL-A', quantity: 100, marketValue: 3000 },
  { symbol: 'PUT-B', quantity: -50, marketValue: -1000 },
  { symbol: 'TURBO-C', quantity: 10, marketValue: 2000 },
  { symbol: 'NVDA', quantity: 5, marketValue: 2500 },
  { symbol: 'BOND-X', quantity: 1, marketValue: 1500 },
  { symbol: 'CLOSED', quantity: 0, marketValue: 0 },
]

const tier1Groups = [
  {
    key: 'nvda', groupName: 'NVIDIA',
    derivatives: [{ symbol: 'CALL-A', instrument: 'NVDA Call' }, { symbol: 'PUT-B', instrument: 'NVDA Put' }],
    stocks: [{ symbol: 'NVDA' }],
  },
  { key: 'tsla', groupName: 'Tesla', derivatives: [{ symbol: 'TURBO-C', instrument: 'TSLA Turbo' }], stocks: [] },
]

test('splits held positions into shown, missing risk data, Tier 1 stocks and other tiers', () => {
  const coverage = buildPositionsCoverage({
    positions,
    tier1Groups,
    shownEntries: [{ item: { symbol: 'CALL-A' } }, { item: { symbol: 'PUT-B' } }],
  })

  assert.equal(coverage.heldCount, 5)
  assert.equal(coverage.heldValue, 10000)
  assert.equal(coverage.shownCount, 2)
  assert.equal(coverage.shownValue, 4000)
  assert.equal(coverage.shownValuePct, 40)
  assert.deepEqual(coverage.missingRisk, {
    count: 1,
    value: 2000,
    rows: [{ symbol: 'TURBO-C', name: 'TSLA Turbo', groupName: 'Tesla', marketValue: 2000 }],
  })
  assert.deepEqual(coverage.tier1Stocks, { count: 1, value: 2500 })
  assert.deepEqual(coverage.otherTiers, { count: 1, value: 1500 })
})

test('ignores shown entries that are not held and tolerates empty input', () => {
  const coverage = buildPositionsCoverage({
    positions,
    tier1Groups: [],
    shownEntries: [{ item: { symbol: 'NOT-HELD' } }],
  })
  assert.equal(coverage.shownCount, 0)
  assert.equal(coverage.otherTiers.count, 5)

  assert.deepEqual(buildPositionsCoverage(), {
    heldCount: 0,
    heldValue: 0,
    shownCount: 0,
    shownValue: 0,
    shownValuePct: 0,
    missingRisk: { count: 0, value: 0, rows: [] },
    tier1Stocks: { count: 0, value: 0 },
    otherTiers: { count: 0, value: 0 },
  })
})
