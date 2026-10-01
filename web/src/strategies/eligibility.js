import { CANDIDATE_STRATEGIES } from './definitions.js'

export function candidatePolicy(profile) {
  const signals = profile.riskSignals
  if (profile.riskStatus === 'HARD_BLOCKED') {
    return { eligibleStrategies: [], excludedReason: 'hard_blocked' }
  }
  if (signals.isRoll) {
    return { eligibleStrategies: [], excludedReason: 'roll_current_contract' }
  }
  if (signals.hasUntrustedData) {
    return { eligibleStrategies: [], excludedReason: 'untrusted_data' }
  }
  if (profile.primaryAction === 'SELL' && profile.riskStatus !== 'WATCH') {
    return { eligibleStrategies: [], excludedReason: 'sell' }
  }
  if (profile.riskStatus === 'WATCH' && signals.isNearBarrier) {
    return { eligibleStrategies: ['elastic'], excludedReason: null }
  }
  return { eligibleStrategies: CANDIDATE_STRATEGIES, excludedReason: null }
}

export function candidateEligible(profile, strategy) {
  return candidatePolicy(profile).eligibleStrategies.includes(strategy)
}

export function eligibleForAnyStrategy(profile) {
  return CANDIDATE_STRATEGIES.some((strategy) => candidateEligible(profile, strategy))
}
