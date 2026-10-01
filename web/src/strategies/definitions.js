// Scores compare per-euro returns from the fixed 30-day reference scenarios,
// so position size does not influence ranking.
export const STRATEGY_DEFINITIONS = [
  {
    strategy: 'defensive',
    id: 'defensive',
    title: '稳健组合',
    description: '优先控制双向压力下的最差损失；WATCH 按原因降权，集中仓位按风险敞口限制。',
    limit: 5,
    score: ({ worstReturn, flatReturn, riskPenalty }) => worstReturn + flatReturn * 0.15 - riskPenalty,
  },
  {
    strategy: 'balanced',
    id: 'balanced',
    title: '均衡组合',
    description: '兼顾固定参考情景表现、最差损失和数据可信度，对 WATCH 保持风险扣分。',
    limit: 8,
    score: ({ meanReturn, worstReturn, riskPenalty }) => meanReturn + worstReturn * 0.45 - riskPenalty,
  },
  {
    strategy: 'elastic',
    id: 'elastic',
    title: '高弹性组合',
    description: '提高有利情景收益；可纳入临近障碍的 WATCH 仓位，但会大幅降权并保留归零压力。',
    limit: 6,
    score: ({ bestReturn, worstReturn, riskPenalty }) => bestReturn - Math.abs(worstReturn) * 0.25 - riskPenalty,
  },
]

export const CANDIDATE_STRATEGIES = STRATEGY_DEFINITIONS.map((definition) => definition.strategy)

export function strategyScores(metrics) {
  return Object.fromEntries(STRATEGY_DEFINITIONS.map((definition) => [definition.strategy, definition.score(metrics)]))
}
