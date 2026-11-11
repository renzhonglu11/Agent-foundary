import assert from 'node:assert/strict'
import test from 'node:test'
import { backgroundUpdateState, lastMonitorCheck, monitorUpdateState, productUpdateState } from './backgroundUpdateStatus.js'
import { fetchStructuredProductsRefreshStatus } from '../hooks/useStructuredProductsRefreshStatus.js'

const now = Date.parse('2026-11-10T12:00:00Z')
const healthy = {
  enabled: true,
  runtime: { running: false },
  snapshot: { evaluatedAt: '2026-11-10T11:59:30Z', provider: { failed: false } },
}
const scheduled = { liveEnabled: true, autoRefreshActive: true, running: false }

test('market closure keeps the scheduler healthy while distinguishing it from an active fetch', () => {
  const monitor = monitorUpdateState(healthy, null, now)
  const products = productUpdateState(scheduled, null, false)
  assert.equal(products.label, '休市等待')
  assert.equal(backgroundUpdateState(monitor, products).color, 'success')
  assert.equal(productUpdateState({ ...scheduled, running: true }, null, false).label, '正在抓取')
  assert.equal(productUpdateState({ ...scheduled, running: true, mode: 'fallback' }, null, false).label, '整理缓存中')
})

test('a check that keeps the stored snapshot still counts as a completed check', () => {
  const later = now + 600_000
  const reused = { ...healthy, runtime: { running: false, lastCycle: 'unchanged', lastCheckedAt: '2026-11-10T12:09:30Z' } }
  assert.equal(monitorUpdateState(reused, null, later).label, '运行正常')
  assert.equal(lastMonitorCheck(reused), Date.parse('2026-11-10T12:09:30Z'))
  // The last check survives while the next cycle is running.
  assert.equal(monitorUpdateState({ ...reused, runtime: { running: true, lastCheckedAt: '2026-11-10T12:09:30Z' } }, null, later).label, '正在检查')
  // A stopped loop is still reported, and an older backend without the field falls back to the snapshot time.
  assert.equal(monitorUpdateState(reused, null, later + 600_000).label, '检查超时')
  assert.equal(lastMonitorCheck(healthy), Date.parse(healthy.snapshot.evaluatedAt))
  assert.equal(lastMonitorCheck({}), null)
})

test('a running refresh cannot conceal a stalled monitor or a failed data source', () => {
  const stale = monitorUpdateState(healthy, null, now + 180_000)
  const running = productUpdateState({ ...scheduled, running: true }, null, true)
  assert.equal(stale.label, '检查超时')
  assert.equal(backgroundUpdateState(stale, running).color, 'warning')
  const failed = monitorUpdateState({ ...healthy, runtime: { lastError: 'database unavailable' } }, null, now)
  assert.equal(backgroundUpdateState(failed, running).color, 'error')
})

test('cached successes do not hide polling failures', () => {
  assert.equal(monitorUpdateState(healthy, new Error('offline'), now).color, 'error')
  assert.equal(productUpdateState(scheduled, new Error('offline'), false).color, 'error')
})

test('persisted provider cooldown stays visible during refresh and after restart', () => {
  const limited = { ...scheduled, providers: [{ source: 'api.onvista.de', coolingDown: true, lastStatus: 429 }] }
  assert.equal(productUpdateState(limited, null, true).label, '渠道冷却中')
  const running = productUpdateState({ ...limited, running: true }, null, true)
  assert.equal(running.busy, true)
  assert.equal(backgroundUpdateState(monitorUpdateState(healthy, null, now), running).label, '需关注')
  assert.equal(productUpdateState({ ...scheduled, providerStatusError: '不可用' }, null, true).color, 'warning')
  assert.equal(productUpdateState({ ...scheduled, providers: [{ coolingDown: false }] }, null, false).color, 'success')
})

test('partial quote and historical data failures remain visible', () => {
  for (const extra of [{ provider: { failed: true } }, { historyWarnings: ['daily bars unavailable'] }]) {
    assert.equal(monitorUpdateState({ ...healthy, snapshot: { ...healthy.snapshot, ...extra } }, null, now).label, '更新受限')
  }
})

test('disabled jobs and incomplete status never look healthy', () => {
  assert.equal(monitorUpdateState({ ...healthy, enabled: false }, null, now).label, '已关闭')
  assert.equal(productUpdateState({ ...scheduled, liveEnabled: false }, null, false).color, 'warning')
  assert.equal(productUpdateState({ ...scheduled, autoRefreshActive: false }, null, false).color, 'warning')
  assert.equal(productUpdateState({}, null, false).color, 'warning')
  assert.equal(monitorUpdateState({}, null, now).color, 'warning')
})

test('missing or corrupt timestamps cannot certify a fresh heartbeat', () => {
  for (const evaluatedAt of [null, 'invalid', '2026-11-10T13:00:00Z']) {
    assert.equal(monitorUpdateState({ ...healthy, snapshot: { evaluatedAt } }, null, now).color, 'warning')
  }
  const waiting = { enabled: true, runtime: { running: false }, snapshot: null }
  assert.equal(monitorUpdateState(waiting, null, now).label, '等待首轮')
  assert.equal(monitorUpdateState({ ...waiting, runtime: { running: true, lastStartedAt: '2026-11-10T11:50:00Z' } }, null, now).label, '首轮检查超时')
})

test('the header shows progress only when a backend job is actually running or queued', () => {
  const monitor = monitorUpdateState(healthy, null, now)
  const queued = productUpdateState({ ...scheduled, queued: true }, null, true)
  assert.equal(backgroundUpdateState(monitor, queued).label, '更新中')
  assert.equal(backgroundUpdateState(monitor, productUpdateState(null, null, true)).label, '准备中')
})

test('HTTP errors from the product status endpoint are not converted to idle success', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: false, status: 503 })
  try {
    await assert.rejects(fetchStructuredProductsRefreshStatus(), /503/)
  } finally {
    globalThis.fetch = originalFetch
  }
})
