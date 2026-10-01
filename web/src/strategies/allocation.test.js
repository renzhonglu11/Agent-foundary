import assert from 'node:assert/strict'
import test from 'node:test'

import { allocateEqualWeight } from './allocation.js'
import { modelQualityPenalty } from './riskSignals.js'

function profile(id, currentValue, { exposure = 0.01, riskStatus = 'OK', primaryAction = 'HOLD', modelPenalty = 0 } = {}) {
  return {
    id,
    currentValue,
    costBasis: currentValue * 0.8,
    navWeightPct: currentValue / 10,
    capitalWeightPct: currentValue * 0.08,
    results: [{ scenarioId: 'down', currentValue, pnl: -currentValue / 10 }],
    riskStatus,
    primaryAction,
    modelPenalty,
    riskSignals: { exposureWeightPct: exposure, isNearBarrier: false },
  }
}

test('equal weight fills capped products first and spreads the rest across open ones', () => {
  const profiles = [
    profile('A', 100),
    profile('B', 100, { exposure: 0.04 }),
    profile('C', 300, { riskStatus: 'WATCH' }),
    profile('D', 50, { exposure: null }),
  ]
  const [a, b, c, d] = allocateEqualWeight(profiles, 1000, { totalCostBasis: 1000 })

  // Share 250: B (8% cap at 200) and D (unknown exposure, 50) fill first; then
  // C (WATCH, held at 300); A takes the remaining 450.
  assert.deepEqual([a, b, c, d].map(p => [p.currentValue, p.positionScalePct]), [[450, 450], [200, 200], [300, 100], [50, 100]])
  assert.deepEqual([a, b, c, d].map(p => p.selectionFlags), [[], ['EXPOSURE_CAPPED_8_PCT'], ['WATCH_PENALIZED', 'HELD_AT_CURRENT'], ['HELD_AT_CURRENT']])
  assert.equal(a.results[0].pnl, -45)
  assert.equal(a.navWeightPct, 45)
  // Added capital is bought at today's value: cost 80 + 350.
  assert.equal(a.costBasis, 430)
  assert.equal(a.capitalWeightPct, 43)
})

test('capital beyond every cap stays as cash and overexposed products still shrink', () => {
  const allocated = allocateEqualWeight([profile('A', 100), profile('OVER', 200, { exposure: 0.16 })], 5000)
  assert.deepEqual(allocated.map(p => [p.currentValue, p.positionScalePct]), [[800, 800], [100, 50]])
  assert.deepEqual(allocated[1].selectionFlags, ['EXPOSURE_CAPPED_8_PCT'])
  assert.deepEqual(allocateEqualWeight([profile('A', 100, { modelPenalty: 0.2 })], 100)[0].selectionFlags, ['MODEL_FALLBACK'])
})

test('model penalty takes the least reliable scenario method chain', () => {
  const penalty = (...methods) => modelQualityPenalty(methods.map(method => ({ method })))
  assert.equal(penalty('delta+theta', 'expiry_intrinsic'), 0)
  assert.equal(penalty('omega+linear', 'knockout'), 0.06)
  assertClose(penalty('leverage+default_leverage+approx'), 0.29)
  assertClose(penalty('factor_leverage+default_leverage+carry_default_vol'), 0.2)
  assert.equal(penalty('mystery'), 0.1)
})

function assertClose(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} !== ${expected}`)
}
