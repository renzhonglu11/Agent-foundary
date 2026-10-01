import { clamp, finite } from '../utils/numbers.js'

export const WATCH_DATA_SCORE_THRESHOLD = 6
export const WATCH_BARRIER_DISTANCE = 0.10
export const MAX_PRODUCT_EXPOSURE_WEIGHT = 0.08

const CONFIDENCE_PENALTIES = {
  live_delta: 0,
  estimated_delta: 0.02,
  estimated_omega: 0.04,
  estimated_leverage: 0.06,
  estimated_market_value: 0.10,
  no_data: 0.25,
}

export function productRiskSignals(entry) {
  const confidence = entry.riskLeg?.exposureConfidence || 'no_data'
  const completenessScore = finite(entry.riskLeg?.dataCompletenessRiskScore) ?? 10
  const daysToExpiry = finite(entry.riskLeg?.daysToExpiry)
  const barrierDistancePct = finite(entry.riskLeg?.barrierDistancePct)
  const exposureWeightPct = finite(entry.riskLeg?.exposureWeightPct)
  return {
    riskStatus: entry.riskLeg?.legRiskStatus || 'N/A',
    confidence,
    completenessScore,
    daysToExpiry,
    barrierDistancePct,
    exposureWeightPct,
    isRoll: entry.primaryAction === 'ROLL'
      || (daysToExpiry != null && daysToExpiry >= 0 && daysToExpiry < 7),
    hasUntrustedData: confidence === 'no_data' || completenessScore >= WATCH_DATA_SCORE_THRESHOLD,
    isNearBarrier: barrierDistancePct != null && barrierDistancePct < WATCH_BARRIER_DISTANCE,
    isOverexposed: exposureWeightPct != null && exposureWeightPct > MAX_PRODUCT_EXPOSURE_WEIGHT,
  }
}

export function productRiskPenalty(entry, signals) {
  const completeness = clamp(signals.completenessScore / 10, 0, 1)
  const confidencePenalty = CONFIDENCE_PENALTIES[signals.confidence] ?? 0.12
  const actionPenalty = entry.primaryAction === 'HOLD' ? 0.02 : entry.primaryAction === 'BUY' ? 0 : 0.20
  const concentrationPenalty = entry.riskGroup?.groupActionLabel === 'REDUCE_CONCENTRATION' ? 0.08 : 0
  const watchPenalty = signals.riskStatus === 'WATCH' ? 0.05 : 0
  const barrierPenalty = signals.isNearBarrier ? 0.10 : 0
  const exposurePenalty = signals.isOverexposed ? 0.08 : 0
  return confidencePenalty
    + completeness * 0.08
    + actionPenalty
    + concentrationPenalty
    + watchPenalty
    + barrierPenalty
    + exposurePenalty
}

// Penalty per stress-method component: how far the projection is from priced
// sensitivities. The worst scenario sets the product's model penalty.
const MODEL_COMPONENT_PENALTIES = {
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
