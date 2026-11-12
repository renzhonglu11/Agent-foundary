import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

import { KNOWN_DATA_LIMITATIONS, buildDataHealth } from './dataHealth.js'

const now = Date.parse('2026-11-12T15:00:00Z')

function status({ positions = [], coveragePct = 35, minModelCoveragePct = null, runtime = {} } = {}) {
  return {
    enabled: true,
    runtime,
    configuration: { settings: { minModelCoveragePct } },
    snapshot: { evaluatedAt: '2026-11-12T14:59:00Z', positions, risk: { coveragePct } },
  }
}

test('the alert-exempt issue list matches the backend', () => {
  const source = readFileSync(new URL('../../../backend/src/services/monitor_alerts.rs', import.meta.url), 'utf8')
  const block = source.match(/const KNOWN_DATA_LIMITATIONS: \[&str; \d+\] = \[([^\]]*)\]/)
  assert.ok(block, 'KNOWN_DATA_LIMITATIONS not found in monitor_alerts.rs')
  const backend = [...block[1].matchAll(/"([a-z0-9_]+)"/g)].map(match => match[1]).sort()
  assert.deepEqual([...KNOWN_DATA_LIMITATIONS].sort(), backend)
})

test('separates faults, confidence limits and gaps', () => {
  const health = buildDataHealth(status({
    positions: [
      { issues: ['valuation_market_time_unknown', 'greeks_market_time_unknown', 'underlying_unmapped'] },
      { issues: ['valuation_market_time_unknown', 'underlying_unmapped'] },
      { issues: ['valuation_market_time_unknown', 'product_capture_stale'] },
      { issues: [] },
    ],
  }), null, now)

  assert.equal(health.level, 'error')
  assert.equal(health.faultPositionCount, 1)
  assert.deepEqual(health.faults, [{ code: 'product_capture_stale', label: '交易时段内产品抓取已过期', count: 1 }])
  assert.deepEqual(health.limitations.map(row => [row.code, row.count]), [['valuation_market_time_unknown', 3], ['greeks_market_time_unknown', 1]])
  assert.deepEqual(health.gaps.map(row => [row.code, row.count]), [['underlying_unmapped', 2], ['min_model_coverage_unset', null]])
  assert.equal(health.coveragePct, 35)
})

test('known limitations alone are a warning, and a set threshold removes that gap', () => {
  const limited = buildDataHealth(status({ positions: [{ issues: ['underlying_unmapped'] }] }), null, now)
  assert.equal(limited.level, 'warning')

  const clean = buildDataHealth(status({ positions: [{ issues: ['valuation_market_time_unknown'] }], minModelCoveragePct: 30 }), null, now)
  assert.equal(clean.level, 'ok')
  assert.deepEqual(clean.gaps, [])
})

test('coverage below the configured minimum is a fault', () => {
  const health = buildDataHealth(status({ coveragePct: 35, minModelCoveragePct: 60 }), null, now)
  assert.equal(health.level, 'error')
  assert.equal(health.faults[0].code, 'model_coverage_below_min')
})

test('monitor failures and loading are reported', () => {
  assert.equal(buildDataHealth(undefined, null, now).level, 'loading')
  const failed = buildDataHealth(undefined, new Error('offline'), now)
  assert.equal(failed.level, 'error')
  assert.equal(failed.monitor.label, '状态不可用')
  const stale = buildDataHealth({ ...status({ minModelCoveragePct: 30 }), snapshot: { ...status().snapshot, evaluatedAt: '2026-11-12T14:00:00Z' } }, null, now)
  assert.equal(stale.level, 'warning')
  assert.equal(stale.monitor.label, '检查超时')
})
