export { allocateEqualWeight } from './allocation.js'
export { CANDIDATE_STRATEGIES, STRATEGY_DEFINITIONS, strategyScores } from './definitions.js'
export { candidateEligible, candidatePolicy, eligibleForAnyStrategy } from './eligibility.js'
export {
  MAX_PRODUCT_EXPOSURE_WEIGHT,
  MODEL_FALLBACK_THRESHOLD,
  WATCH_BARRIER_DISTANCE,
  WATCH_DATA_SCORE_THRESHOLD,
  modelQualityPenalty,
  productRiskPenalty,
  productRiskSignals,
} from './riskSignals.js'
export { selectDiversified } from './selection.js'
