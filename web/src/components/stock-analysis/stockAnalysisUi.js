export const attentionFilters = [
  { id: 'action', label: '需要操作' },
  { id: 'expiry', label: '临近到期' },
  { id: 'data', label: '数据异常' },
  { id: 'all', label: '全部' },
]

const actionMeta = {
  REDUCE_CONCENTRATION: { label: '降低集中度', color: 'error' },
  REDUCE_DERIVATIVE_RISK: { label: '降低衍生品风险', color: 'error' },
  CLOSE_OR_ROLL_DERIVATIVE: { label: '平仓或展期', color: 'warning' },
  HOLD_MONITOR: { label: '继续观察', color: 'warning' },
  ADD_ALLOWED: { label: '可继续持有', color: 'success' },
  'N/A': { label: '暂无建议', color: 'default' },
}

export function riskActionMeta(action) {
  return actionMeta[action] || { label: String(action || '暂无建议').replace(/_/g, ' '), color: 'default' }
}

export function hasDataIssue(leg) {
  const score = Number(leg?.dataCompletenessRiskScore)
  return leg?.exposureConfidence === 'no_data' || (Number.isFinite(score) && score > 3)
}

export function hasExpiryRisk(leg) {
  const days = Number(leg?.daysToExpiry)
  return Number.isFinite(days) && days >= 0 && days < 90
}

export function groupAttentionState(riskGroup) {
  const legs = Array.isArray(riskGroup?.legs) ? riskGroup.legs : []
  const action = riskGroup?.groupActionLabel
  return {
    needsAction: Boolean(action && action !== 'ADD_ALLOWED' && action !== 'N/A'),
    expiryCount: legs.filter(hasExpiryRisk).length,
    dataIssueCount: legs.filter(hasDataIssue).length,
  }
}

export function matchesAttentionFilter(riskGroup, filter) {
  if (filter === 'all') return true
  const state = groupAttentionState(riskGroup)
  if (filter === 'expiry') return state.expiryCount > 0
  if (filter === 'data') return state.dataIssueCount > 0
  return state.needsAction
}

export const tiers = [
  { id: 'tier1', title: 'Tier 1 · 核心关注', subtitle: '实时行情与完整衍生品风险数据' },
  { id: 'tier2', title: 'Tier 2 · 衍生品观察', subtitle: '按标的聚合的其他衍生品持仓' },
  { id: 'tier3', title: 'Tier 3 · 普通持仓', subtitle: '股票、ETF 与债券持仓' },
]

const twoDecimalNumber = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export function formatNumber2(value) {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? twoDecimalNumber.format(numeric) : '—'
}

export function formatPercent2(value) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return '—'
  return `${numeric >= 0 ? '+' : ''}${twoDecimalNumber.format(numeric)}%`
}
