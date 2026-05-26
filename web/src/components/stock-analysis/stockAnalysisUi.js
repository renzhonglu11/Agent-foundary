export const ratingMeta = {
  强烈买入: { color: '#13deb9', bg: '#e9fff9', border: '#9bf3df' },
  买入: { color: '#5d87ff', bg: '#eef3ff', border: '#c5d4ff' },
  持有: { color: '#49beff', bg: '#edf8ff', border: '#a9dcff' },
  观望: { color: '#ffae1f', bg: '#fff9df', border: '#ffe18a' },
  卖出: { color: '#fa896b', bg: '#fff1ee', border: '#ffc9bd' },
}

export const tiers = [
  { id: 'tier1', title: 'Tier 1 Watchlist', subtitle: '核心标的组；普通股票批量使用 Alpaca IEX，金融衍生品使用 Onvista/Börse Frankfurt enrichment' },
  { id: 'tier2', title: 'Tier 2 Watchlist', subtitle: '其余金融衍生品按 underlying 聚合；默认使用 Rust summary / 已缓存 JSON 数据' },
  { id: 'tier3', title: 'Tier 3 Watchlist', subtitle: '股票、ETF、Bond 等普通持仓；先使用 Rust portfolio JSON fallback，不触发衍生品实时抓取' },
]

const twoDecimalNumber = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export function formatNumber2(value) {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? twoDecimalNumber.format(numeric) : '—'
}

export function formatPercent2(value) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return '—'
  return `${numeric >= 0 ? '+' : ''}${twoDecimalNumber.format(numeric)}%`
}
