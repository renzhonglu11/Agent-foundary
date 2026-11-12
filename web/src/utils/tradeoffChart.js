// Axis range for the reduction trade-off scatter. One large position can
// stretch the axes so far that every other point collapses into a corner.
// The few largest points (at most three) that stand clearly apart from the
// rest, more than 1.5x the next point's size, are left out of the focused
// range and pinned to its edge. Both axes share one range, which keeps
// "efficiency = 1" on the diagonal of equal units.

const GAP = 1.5
const MAX_PINNED = 3
// With few points nothing is crowded; never pin more than 5% of them.
const MIN_POINTS = 8
const PINNED_SHARE = 0.05
const HEADROOM = 1.1
// Pinned points stop just inside the edge so the plot does not clip them.
const EDGE = 0.97

const niceStep = (span) => {
  const raw = span / 8
  const power = 10 ** Math.floor(Math.log10(raw || 1))
  return [1, 2, 2.5, 5, 10].map(step => step * power).find(step => step >= raw) ?? raw
}

const roundUp = (value) => {
  if (value <= 0) return 0
  const step = niceStep(value)
  return Math.ceil(value / step) * step
}

const roundDown = (value) => (value >= 0 ? 0 : -roundUp(-value))

export function tradeoffDomain(points, { focus = true } = {}) {
  const valid = points.filter(point => Number.isFinite(point.x) && Number.isFinite(point.y))
  const reach = point => Math.max(point.x, point.y)
  const fullMax = roundUp(Math.max(0, ...valid.map(reach))) || 1
  const min = roundDown(Math.min(0, ...valid.map(point => Math.min(point.x, point.y))))
  const largest = valid.map(reach).filter(value => value > 0).sort((left, right) => right - left)
  let cut = 0
  const limit = largest.length >= MIN_POINTS ? Math.min(MAX_PINNED, Math.ceil(largest.length * PINNED_SHARE)) : 0
  for (let k = 1; k <= limit && k < largest.length; k += 1) {
    if (largest[k - 1] > GAP * largest[k]) cut = k
  }
  const canFocus = cut > 0
  const useFocus = focus && canFocus
  const max = useFocus ? roundUp(largest[cut] * HEADROOM) : fullMax
  const clipped = useFocus ? valid.filter(point => reach(point) > max).map(point => point.id) : []
  return { min, max, fullMax, focused: useFocus, clipped, canFocus }
}

// Where a point is drawn. A point beyond the range slides toward the origin
// along its own line until it reaches the edge, so its ratio (efficiency) and
// its side of the diagonal stay true; only its distance is shortened.
export function displayPoint(point, domain) {
  const reach = Math.max(point.x, point.y)
  if (!(reach > domain.max)) return { x: point.x, y: point.y, clipped: false }
  const scale = (domain.max * EDGE) / reach
  return { x: point.x * scale, y: point.y * scale, clipped: true }
}
