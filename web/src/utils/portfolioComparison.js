const round = value => Math.round(value * 100) / 100

// Both weights include the same tested capital, including hypothetical cash.
// A product leaving the candidate is a modeled exit, not a sell instruction.
export function buildPortfolioAdjustments(baseline, candidate) {
  if (!baseline || !candidate) return []
  const retained = new Map(candidate.products.map(product => [product.id, product]))
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
      releasedValue: round(Math.max(0, before - after)),
      beforeWeight: round(baseline.currentValue > 0 ? before / baseline.currentValue * 100 : 0),
      afterWeight: round(baseline.currentValue > 0 ? after / baseline.currentValue * 100 : 0),
    }
  }).sort((a, b) => b.releasedValue - a.releasedValue || a.name.localeCompare(b.name))
}

export function buildScenarioContributions(portfolio, scenarioId) {
  if (!portfolio) return []
  return portfolio.products.map(product => ({
    id: product.id,
    name: product.name,
    groupName: product.groupName,
    pnl: product.scenarioPnls?.find(result => result.scenarioId === scenarioId)?.pnl ?? null,
  })).sort((a, b) => (a.pnl ?? 0) - (b.pnl ?? 0))
}

export function comparePortfolioStress(baseline, candidate) {
  if (!baseline || !candidate) return null
  const up = portfolio => portfolio.scenarioResults
    .filter(scenario => !scenario.pathMoves?.length)
    .reduce((selected, scenario) => !selected || scenario.movePct > selected.movePct ? scenario : selected, null)
  const baselineUp = up(baseline)
  const candidateUp = up(candidate)
  return {
    worstPnlImprovement: round(candidate.worstPnl - baseline.worstPnl),
    upPnlDifference: baselineUp && candidateUp ? round(candidateUp.pnl - baselineUp.pnl) : null,
  }
}
