const round = value => Math.round(value * 100) / 100

// Both weights include the same tested capital, including hypothetical cash.
// Exits and reductions are modeled differences, not trade instructions.
export function buildPortfolioAdjustments(baseline, plan) {
  if (!baseline || !plan) return []
  const retained = new Map(plan.products.map(product => [product.id, product]))
  return baseline.products.map(product => {
    const next = retained.get(product.id)
    const before = product.currentValue
    const after = next?.currentValue ?? 0
    return {
      id: product.id,
      name: product.name,
      groupName: product.groupName,
      action: !next ? 'exit' : next.positionScalePct < 100 ? 'reduce' : 'retain',
      before,
      after,
      changeValue: round(after - before),
      releasedValue: round(Math.max(0, before - after)),
      beforeWeight: round(baseline.currentValue > 0 ? before / baseline.currentValue * 100 : 0),
      afterWeight: round(baseline.currentValue > 0 ? after / baseline.currentValue * 100 : 0),
    }
  }).sort((a, b) => Math.abs(b.changeValue) - Math.abs(a.changeValue) || a.name.localeCompare(b.name))
}

// Single-underlying shocks are limited to the selected portfolio, so a chosen
// target always hits at least one of its products.
export function buildShockTargets(portfolio) {
  if (!portfolio) return []
  const targets = new Map(portfolio.products.map(product => [product.groupKey, product.groupName || product.groupKey]))
  return [...targets].map(([key, name]) => ({ key, name })).sort((a, b) => a.name.localeCompare(b.name))
}

export function buildScenarioContributions(portfolio, scenarioId) {
  if (!portfolio) return []
  return portfolio.products.map(product => ({
    id: product.id,
    name: product.name,
    groupName: product.groupName,
    pnl: product.scenarioPnls?.find(result => result.scenarioId === scenarioId)?.pnl ?? null,
    movePct: product.scenarioPnls?.find(result => result.scenarioId === scenarioId)?.movePct ?? null,
  })).sort((a, b) => (a.pnl ?? 0) - (b.pnl ?? 0))
}

export function comparePortfolioStress(baseline, plan) {
  if (!baseline || !plan) return null
  const up = portfolio => portfolio.scenarioResults
    .filter(scenario => !scenario.pathMoves?.length && !scenario.adverse)
    .reduce((selected, scenario) => !selected || scenario.movePct > selected.movePct ? scenario : selected, null)
  const baselineUp = up(baseline)
  const planUp = up(plan)
  return {
    worstPnlImprovement: round(plan.worstPnl - baseline.worstPnl),
    upPnlDifference: baselineUp && planUp ? round(planUp.pnl - baselineUp.pnl) : null,
  }
}

// The four numbers shown for a plan: worst-case relief, the upside given up
// in the same largest upward scenario, their ratio, and the cash released.
export function summarizePlan(baseline, plan) {
  const delta = comparePortfolioStress(baseline, plan)
  if (!delta) return null
  const upsideGivenUp = delta.upPnlDifference == null ? null : round(Math.max(0, -delta.upPnlDifference))
  const worstImprovement = delta.worstPnlImprovement
  const cent = 0.005
  return {
    worstImprovement,
    upsideGivenUp,
    efficiency: worstImprovement > cent && upsideGivenUp > cent ? round(worstImprovement / upsideGivenUp) : null,
    free: worstImprovement > cent && upsideGivenUp != null && upsideGivenUp <= cent,
    cashValue: round(plan.cashValue ?? 0),
  }
}

// Reduction a ranking row currently has in the custom plan: one shared
// percentage, or null when its products are reduced by different amounts.
export function rowReduction(reductions, productIds) {
  const values = new Set(productIds.map(id => reductions[id] || 0))
  return values.size === 1 ? [...values][0] : null
}

export function withRowReduction(reductions, productIds, pct) {
  const next = { ...reductions }
  for (const id of productIds) {
    if (pct > 0) next[id] = pct
    else delete next[id]
  }
  return next
}
