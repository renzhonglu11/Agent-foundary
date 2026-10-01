export function finite(value) {
  if (value === null || value === undefined || value === '') return null
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : null
}

export function positive(value) {
  const numeric = finite(value)
  return numeric != null && numeric > 0 ? numeric : null
}

export function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value))
}

export function round(value, digits = 2) {
  if (!Number.isFinite(value)) return 0
  const factor = 10 ** digits
  return Math.round((value + Number.EPSILON) * factor) / factor
}
