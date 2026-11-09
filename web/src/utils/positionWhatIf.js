// What-if reductions of the current holdings: what selling part of a product
// or of an underlying does to the stressed portfolio. Everything is derived
// from the baseline's per-product scenario P&L, which scales linearly with
// position size; only the adverse scenario has to be chosen again, because the
// worst direction of an underlying can flip when one of its products shrinks.

import { round } from './numbers.js'

export const REDUCTION_STEPS = [25, 50, 100]

function scenarioRoles(baseline) {
  const scenarios = baseline?.scenarioResults || []
  const endpoints = scenarios.filter(scenario => !scenario.adverse && !scenario.pathMoves?.length)
  const byMove = [...endpoints].sort((left, right) => left.movePct - right.movePct)
  return {
    scenarios,
    endpointIds: new Set(endpoints.map(scenario => scenario.id)),
    adverseIds: scenarios.filter(scenario => scenario.adverse).map(scenario => scenario.id),
    downId: byMove[0]?.id ?? null,
    upId: byMove.at(-1)?.id ?? null,
    flatId: scenarios.find(scenario => scenario.id === 'flat')?.id ?? null,
  }
}

// Portfolio P&L per scenario with every product scaled by `scaleOf(product)`.
function scaledOutcome(baseline, roles, scaleOf) {
  const totals = new Map(roles.scenarios.map(scenario => [scenario.id, 0]))
  const groupEndpoints = new Map()
  for (const product of baseline.products) {
    const scale = scaleOf(product)
    if (scale === 0) continue
    const group = groupEndpoints.get(product.groupKey) ?? new Map()
    groupEndpoints.set(product.groupKey, group)
    for (const row of product.scenarioPnls || []) {
      if (roles.adverseIds.includes(row.scenarioId)) continue
      const pnl = scale * (row.pnl ?? 0)
      totals.set(row.scenarioId, (totals.get(row.scenarioId) ?? 0) + pnl)
      if (roles.endpointIds.has(row.scenarioId)) group.set(row.scenarioId, (group.get(row.scenarioId) ?? 0) + pnl)
    }
  }
  const adverse = [...groupEndpoints.values()].reduce((sum, group) => sum + Math.min(0, ...group.values()), 0)
  for (const id of roles.adverseIds) totals.set(id, adverse)
  const pnl = id => (id == null ? 0 : totals.get(id) ?? 0)
  return {
    worstPnl: totals.size ? Math.min(...totals.values()) : 0,
    upPnl: pnl(roles.upId),
    downPnl: pnl(roles.downId),
    flatPnl: pnl(roles.flatId),
  }
}

function reductionTargets(baseline, scope) {
  if (scope !== 'group') {
    return baseline.products.map(product => ({
      id: product.id, name: product.name, groupName: product.groupName, productIds: [product.id], currentValue: product.currentValue,
    }))
  }
  const groups = new Map()
  for (const product of baseline.products) {
    const group = groups.get(product.groupKey) ?? { id: product.groupKey, name: product.groupName || product.groupKey, groupName: '', productIds: [], currentValue: 0 }
    groups.set(product.groupKey, group)
    group.productIds.push(product.id)
    group.currentValue += product.currentValue
  }
  return [...groups.values()]
}

const KIND_ORDER = ['free', 'tradeoff', 'neutral', 'hedge']

// `efficiency` favours positions that give up little upside, `improvement` the
// largest worst-case relief in euros, `riskDensity` the euros most at risk.
export const REDUCTION_SORTS = ['efficiency', 'improvement', 'riskDensity']
const SORT_VALUE = {
  efficiency: row => (row.kind === 'free' ? Infinity : row.efficiency ?? 0),
  improvement: row => row.worstImprovement,
  riskDensity: row => row.worstLossPct,
}

// One row per product or underlying: the effect of selling `reductionPct` of it
// while everything else stays. `efficiency` is the worst-case loss avoided per
// euro of upside given up in the largest upward scenario. A position that
// gains in the synchronous downward scenario is a hedge whatever the adverse
// scenario says about it, and a sale that costs no upside has no ratio. Hedges
// and positions without effect on the worst case always come last.
export function rankReductions(baseline, { reductionPct = 50, scope = 'product', sortBy = 'efficiency' } = {}) {
  if (!baseline?.products?.length) return []
  const roles = scenarioRoles(baseline)
  const base = scaledOutcome(baseline, roles, () => 1)
  const keep = 1 - Math.min(100, Math.max(0, reductionPct)) / 100
  const cent = 0.005
  const sortValue = SORT_VALUE[sortBy] ?? SORT_VALUE.efficiency
  // Only the efficiency order separates free sales from trade-offs.
  const rank = row => (sortBy === 'efficiency' || row.kind === 'neutral' || row.kind === 'hedge' ? KIND_ORDER.indexOf(row.kind) : 0)

  return reductionTargets(baseline, scope).map((target) => {
    const ids = new Set(target.productIds)
    const outcome = scaledOutcome(baseline, roles, product => (ids.has(product.id) ? keep : 1))
    const worstImprovement = outcome.worstPnl - base.worstPnl
    const upGivenUp = base.upPnl - outcome.upPnl
    const releasedValue = target.currentValue * (1 - keep)
    const downImprovement = outcome.downPnl - base.downPnl
    const kind = downImprovement < -cent || worstImprovement < -cent ? 'hedge'
      : worstImprovement <= cent ? 'neutral'
        : upGivenUp <= cent ? 'free' : 'tradeoff'
    return {
      ...target,
      scope: scope === 'group' ? 'group' : 'product',
      productCount: target.productIds.length,
      currentValue: round(target.currentValue),
      weightPct: round(baseline.currentValue > 0 ? target.currentValue / baseline.currentValue * 100 : 0),
      releasedValue: round(releasedValue),
      worstImprovement: round(worstImprovement),
      downImprovement: round(downImprovement),
      upGivenUp: round(upGivenUp),
      flatImprovement: round(outcome.flatPnl - base.flatPnl),
      // Worst-case loss carried by each euro held, as a percentage.
      worstLossPct: round(releasedValue > 0 ? worstImprovement / releasedValue * 100 : 0),
      efficiency: kind === 'tradeoff' ? round(worstImprovement / upGivenUp) : null,
      kind,
    }
  }).sort((left, right) => rank(left) - rank(right)
    || sortValue(right) - sortValue(left)
    || right.worstImprovement - left.worstImprovement)
}

// Ready-made plans from the exit signals and from the portfolio's own worst scenario.
export function buildPresetPlans(baseline, exitSignals = []) {
  if (!baseline?.products?.length) return []
  const held = new Set(baseline.products.map(product => product.id))
  const idsAt = level => (exitSignals || []).filter(signal => signal.level === level && held.has(signal.id)).map(signal => signal.id)
  const urgent = idsAt('urgent')
  const warn = idsAt('warn')
  const reductions = (ids, pct) => Object.fromEntries(ids.map(id => [id, pct]))
  const plans = []
  if (urgent.length) {
    plans.push({
      id: 'exit_urgent',
      title: '退出“优先复核”持仓',
      description: `卖出退场信号为“优先复核”的 ${urgent.length} 只产品，其余不动。`,
      reductions: reductions(urgent, 100),
    })
  }
  if (warn.length) {
    plans.push({
      id: 'trim_flagged',
      title: '优先复核退出，留意减半',
      description: `卖出“优先复核”的 ${urgent.length} 只产品，“留意”的 ${warn.length} 只各减一半。`,
      reductions: { ...reductions(warn, 50), ...reductions(urgent, 100) },
    })
  }

  const worst = baseline.scenarioResults.reduce((selected, scenario) => (!selected || scenario.pnl < selected.pnl ? scenario : selected), null)
  const losers = baseline.products
    .map(product => ({ id: product.id, pnl: product.scenarioPnls?.find(row => row.scenarioId === worst?.id)?.pnl ?? 0 }))
    .filter(row => row.pnl < 0)
    .sort((left, right) => left.pnl - right.pnl)
    .slice(0, 5)
  if (losers.length) {
    plans.push({
      id: 'halve_top_losses',
      title: `最差情景亏损前 ${losers.length} 只减半`,
      description: `把当前最差情景（${worst.label}）中亏损最大的 ${losers.length} 只产品各减一半；更换冲击设置后名单会变。`,
      reductions: reductions(losers.map(row => row.id), 50),
    })
  }
  return plans
}

export function buildCustomPlan(reductions = {}) {
  const active = Object.fromEntries(Object.entries(reductions).filter(([, pct]) => pct > 0))
  const count = Object.keys(active).length
  if (!count) return null
  return { id: 'custom', title: '自定义方案', description: `你在下方排序表中选择的 ${count} 只产品的减仓组合。`, reductions: active }
}
