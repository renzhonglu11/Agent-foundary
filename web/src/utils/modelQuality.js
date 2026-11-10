// How far a stress projection is from priced sensitivities. Each projection
// names the methods it used, joined by "+"; their penalties add up and the
// worst scenario sets the product's score. A product at or above the threshold
// is flagged as a fallback estimate.
const MODEL_COMPONENT_PENALTIES = {
  bs: 0,
  bs_iv: 0.03,
  delta: 0,
  expiry_intrinsic: 0,
  knockout: 0,
  factor_leverage: 0,
  factor_path: 0,
  omega: 0.03,
  intrinsic: 0.06,
  leverage: 0.06,
  theta: 0,
  linear: 0.03,
  approx: 0.08,
  financing: 0,
  carry_iv: 0,
  carry_group_iv: 0.02,
  carry_default_vol: 0.05,
  default_leverage: 0.15,
}
const UNKNOWN_MODEL_COMPONENT_PENALTY = 0.10
export const MODEL_FALLBACK_THRESHOLD = 0.10

export function modelQualityPenalty(results) {
  return Math.max(0, ...results.map((result) => String(result.method || '')
    .split('+')
    .reduce((sum, component) => sum + (MODEL_COMPONENT_PENALTIES[component] ?? UNKNOWN_MODEL_COMPONENT_PENALTY), 0)))
}
