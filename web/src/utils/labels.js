// One name per concept across the Positions page. Components import these
// instead of keeping their own copies, so the same field never reads
// differently in two panels.

export const PRODUCT_TYPE_LABELS = {
  optionsschein: '权证',
  open_end_turbo: 'Turbo',
  knock_out: 'Knock-out',
  factor_certificate: 'Factor',
}

export const productTypeLabel = type => PRODUCT_TYPE_LABELS[type] || type || '—'

// How the position's delta exposure was obtained, best first.
export const CONFIDENCE_LABELS = {
  live_delta: '提供方 Delta',
  estimated_delta: '估算 Delta',
  estimated_omega: '估算 Omega',
  estimated_leverage: '估算杠杆',
  estimated_market_value: '市值估算',
  no_data: '数据不足',
}

export const confidenceLabel = value => CONFIDENCE_LABELS[value] || value || '—'

export const RISK_SIGNAL_LABELS = {
  HARD_BLOCKED: '危险',
  WATCH: '观察',
  OK: '安全',
}

export const EXIT_LEVEL_META = {
  urgent: { label: '优先复核', color: 'error' },
  warn: { label: '留意', color: 'warning' },
  ok: { label: '未触发', color: 'success' },
  unknown: { label: '数据不足', color: 'default' },
}

export const UNDERLYING_QUALITY_LABELS = {
  fresh: '交易时段内有效',
  closed_last_session: '休市 · 最近交易时段',
  stale: '行情过期',
  unknown_time: '市场时间未知',
  unknown_calendar: '交易日历未知',
  future_time: '行情时间异常',
  missing: '缺少行情',
  unmapped: '尚未映射',
  invalid_quote: '报价无效',
}

// Issue codes written by the background monitor (portfolio_monitor.rs).
// Underlying quality problems arrive as `underlying_<quality>`.
export const DATA_ISSUE_LABELS = {
  valuation_market_time_unknown: '估值没有市场时间',
  valuation_missing_or_invalid: '估值缺失或无效',
  product_underlying_time_gap_over_24h: '产品抓取与标的时间相差超过 24 小时',
  fx_reference_fallback: '汇率使用备用值',
  greeks_market_time_unknown: 'Greeks 市场时间未核实',
  product_capture_stale: '交易时段内产品抓取已过期',
  product_capture_future: '产品抓取时间异常',
  product_currency_unsupported: '产品币种未知或不支持，使用汇总估值',
  ...Object.fromEntries(Object.entries(UNDERLYING_QUALITY_LABELS).map(([quality, label]) => [`underlying_${quality}`, `标的${label}`])),
}

export const dataIssueLabel = code => DATA_ISSUE_LABELS[code] || code

// The Positions page reports coverage three ways. Each place names its own
// measure and can show all three, so the numbers are never compared blindly.
export const COVERAGE_TERMS = [
  { id: 'table', name: '持仓表覆盖', text: '持仓表里显示的 Tier 1 衍生品，占全部持仓市值的比例。Tier 2 / 3 持仓、Tier 1 股票和缺少风险数据的产品不在表内。' },
  { id: 'testable', name: '可测本金', text: '浏览器里的方案对比能定价的持仓市值。方案对比和减仓排序只覆盖这一部分。' },
  { id: 'model', name: '后台模型覆盖', text: '后台风险监控能定价的持仓，占全部持仓绝对市值。预警、损失限额和日终复盘用的是这个口径。' },
]
