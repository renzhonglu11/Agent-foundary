import { monitorUpdateState } from './backgroundUpdateStatus.js'
import { dataIssueLabel } from './labels.js'
import { finite } from './numbers.js'

// Present on most positions every cycle because the sources do not provide
// the field: they lower confidence but are not faults.
export const LIMITATION_ISSUES = ['valuation_market_time_unknown', 'greeks_market_time_unknown']
// Gaps the system can close (map the underlying, support the currency).
export const GAP_ISSUES = ['underlying_unmapped', 'product_currency_unsupported']
// Must match KNOWN_DATA_LIMITATIONS in backend/src/services/monitor_alerts.rs:
// these never raise the data-quality alert, every other issue does.
export const KNOWN_DATA_LIMITATIONS = new Set([...LIMITATION_ISSUES, ...GAP_ISSUES])

function issueRows(counts, include) {
  return [...counts.entries()]
    .filter(([code]) => include(code))
    .map(([code, count]) => ({ code, label: dataIssueLabel(code), count }))
    .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label))
}

// Splits the background monitor's state into what raises alerts (faults), what
// only limits confidence, and what is still to be filled in.
export function buildDataHealth(data, error, now = Date.now()) {
  const monitor = monitorUpdateState(data, error, now)
  if (!data && !error) return { level: 'loading', monitor, faults: [], limitations: [], gaps: [], faultPositionCount: 0, positionCount: 0, coveragePct: null, minCoveragePct: null }

  const rows = Array.isArray(data?.snapshot?.positions) ? data.snapshot.positions : []
  const counts = new Map()
  for (const row of rows) {
    for (const code of new Set(Array.isArray(row?.issues) ? row.issues : [])) counts.set(code, (counts.get(code) ?? 0) + 1)
  }
  // Same count the backend's data_quality alert compares with its threshold.
  const faultPositionCount = rows.filter(row => (row?.issues || []).some(code => !KNOWN_DATA_LIMITATIONS.has(code))).length
  const faults = issueRows(counts, code => !KNOWN_DATA_LIMITATIONS.has(code))
  const limitations = issueRows(counts, code => LIMITATION_ISSUES.includes(code))
  const gaps = issueRows(counts, code => GAP_ISSUES.includes(code))

  const coveragePct = finite(data?.snapshot?.risk?.coveragePct)
  const minCoveragePct = finite(data?.configuration?.settings?.minModelCoveragePct)
  const coverageBelowMin = coveragePct != null && minCoveragePct != null && coveragePct < minCoveragePct
  if (coverageBelowMin) faults.unshift({ code: 'model_coverage_below_min', label: `模型覆盖率低于设置的 ${minCoveragePct}%`, count: null })
  if (data && minCoveragePct == null) gaps.push({ code: 'min_model_coverage_unset', label: '最低模型覆盖率阈值未设置，覆盖率低时不会报警', count: null })

  const monitorFault = monitor.color === 'error' || monitor.color === 'warning'
  const level = monitor.color === 'error' || faultPositionCount > 0 || coverageBelowMin ? 'error'
    : monitorFault || gaps.length ? 'warning'
      : 'ok'
  return { level, monitor, faults, limitations, gaps, faultPositionCount, positionCount: rows.length, coveragePct, minCoveragePct }
}
