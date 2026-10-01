import { round } from '../utils/numbers.js'
import { MAX_PRODUCT_EXPOSURE_WEIGHT, MODEL_FALLBACK_THRESHOLD } from './riskSignals.js'

const EPSILON = 0.005

// Growth stops at the 8% exposure cap. WATCH or SELL signals, or a missing
// exposure estimate, also keep a product at no more than its current size.
function scaleLimits(profile) {
  const exposure = profile.riskSignals.exposureWeightPct
  const exposureLimit = exposure != null && exposure > 0 ? MAX_PRODUCT_EXPOSURE_WEIGHT / exposure : Infinity
  const mayGrow = exposure != null && exposure > 0 && profile.riskStatus !== 'WATCH' && profile.primaryAction !== 'SELL'
  return { exposureLimit, growthLimit: mayGrow ? Infinity : 1 }
}

// Water-filling: split the budget equally, fill products whose cap is below
// their share, then split what is left among the rest.
function equalWeightValues(caps, budget) {
  const values = caps.map(() => 0)
  let remaining = budget
  let open = caps.map((_, index) => index)
  while (open.length && remaining > EPSILON) {
    const share = remaining / open.length
    const filled = open.filter((index) => caps[index] - values[index] <= share)
    if (!filled.length) {
      for (const index of open) values[index] += share
      break
    }
    for (const index of filled) {
      remaining -= caps[index] - values[index]
      values[index] = caps[index]
    }
    open = open.filter((index) => !filled.includes(index))
  }
  return values
}

function scaleProfile(profile, scale, value, totals) {
  const costBasis = scale <= 1 ? profile.costBasis * scale : profile.costBasis + value - profile.currentValue
  return {
    ...profile,
    // Unrounded so the portfolio total matches the allocated budget exactly.
    currentValue: value,
    costBasis: round(costBasis),
    navWeightPct: round(profile.navWeightPct * scale),
    capitalWeightPct: round(totals.totalCostBasis > 0 ? costBasis / totals.totalCostBasis * 100 : 0),
    results: profile.results.map((result) => ({
      ...result,
      currentValue: round(result.currentValue * scale),
      pnl: round(result.pnl * scale),
    })),
    positionScalePct: round(scale * 100),
  }
}

// Allocates the common tested capital equally across the selected products.
// Capped products leave their excess to the others; anything left is cash.
export function allocateEqualWeight(profiles, budget, totals = {}) {
  const limits = profiles.map(scaleLimits)
  const caps = profiles.map((profile, index) => profile.currentValue * Math.min(limits[index].exposureLimit, limits[index].growthLimit))
  const values = equalWeightValues(caps, budget)

  return profiles.map((profile, index) => {
    const { exposureLimit, growthLimit } = limits[index]
    const atCap = values[index] >= caps[index] - EPSILON
    const selectionFlags = []
    if (profile.riskStatus === 'WATCH') selectionFlags.push('WATCH_PENALIZED')
    if (profile.riskSignals.isNearBarrier) selectionFlags.push('ELASTIC_ONLY')
    if (atCap && exposureLimit <= growthLimit) selectionFlags.push('EXPOSURE_CAPPED_8_PCT')
    if (atCap && growthLimit < exposureLimit) selectionFlags.push('HELD_AT_CURRENT')
    if (profile.modelPenalty >= MODEL_FALLBACK_THRESHOLD) selectionFlags.push('MODEL_FALLBACK')
    const scale = profile.currentValue > 0 ? values[index] / profile.currentValue : 0
    return { ...scaleProfile(profile, scale, values[index], { totalCostBasis: totals.totalCostBasis ?? 0 }), selectionFlags }
  })
}
