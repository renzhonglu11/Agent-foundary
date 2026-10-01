// One product per underlying first; fall back to repeats only to reach three.
export function selectDiversified(profiles, score, limit) {
  const ranked = [...profiles].sort((left, right) => right.scores[score] - left.scores[score])
  const selected = []
  const usedGroups = new Set()

  for (const profile of ranked) {
    if (selected.length >= limit) break
    if (usedGroups.has(profile.groupKey)) continue
    selected.push(profile)
    usedGroups.add(profile.groupKey)
  }

  if (selected.length < Math.min(3, limit)) {
    for (const profile of ranked) {
      if (selected.length >= limit) break
      if (selected.some((item) => item.id === profile.id)) continue
      selected.push(profile)
    }
  }
  return selected
}
