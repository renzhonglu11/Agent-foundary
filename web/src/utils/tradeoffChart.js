// View helpers for the reduction trade-off scatter. The full view fits every
// point with both axes on one range, so equal euros are equal distances and
// "efficiency = 1" is a true diagonal. Zooming is the reader's choice: a
// dragged box becomes the view, and only points inside it are drawn.

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

export function fullView(points) {
  const valid = points.filter(point => Number.isFinite(point.x) && Number.isFinite(point.y))
  const max = roundUp(Math.max(0, ...valid.map(point => Math.max(point.x, point.y)))) || 1
  const min = roundDown(Math.min(0, ...valid.map(point => Math.min(point.x, point.y))))
  return { x: [min, max], y: [min, max] }
}

// A dragged box in data units, ordered and with a minimum size so a slip of
// the mouse does not zoom into nothing. Returns null for a box too small.
export function viewFromBox(a, b, current, minShare = 0.02) {
  const x = [Math.min(a.x, b.x), Math.max(a.x, b.x)]
  const y = [Math.min(a.y, b.y), Math.max(a.y, b.y)]
  const spanX = current.x[1] - current.x[0]
  const spanY = current.y[1] - current.y[0]
  if (x[1] - x[0] < spanX * minShare || y[1] - y[0] < spanY * minShare) return null
  // A little room around the box so points on its edge are not cut in half.
  const pad = (range, share = 0.04) => {
    const extra = (range[1] - range[0]) * share
    return [range[0] - extra, range[1] + extra]
  }
  return { x: pad(x), y: pad(y) }
}

export function inView(point, view) {
  return point.x >= view.x[0] && point.x <= view.x[1] && point.y >= view.y[0] && point.y <= view.y[1]
}
