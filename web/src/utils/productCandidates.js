import { blackScholesDelta, blackScholesPrice, impliedVolatility } from './optionPricing.js'
import { finishBeyondProbability } from './exitSignals.js'
import { referenceRate } from './carryCost.js'
import { positive, round } from './numbers.js'

const DAY = 86_400_000
export const CANDIDATE_QUOTE_MAX_AGE_HOURS = 36
export const CANDIDATE_PAIR_MAX_SKEW_MINUTES = 60

export function candidateIssues(product, now = Date.now()) {
  const issues = []
  if (product.status !== 'ACTIVE') issues.push('产品已失效或状态未知')
  if (product.tradable !== true) issues.push('提供方未确认当前可交易')
  if (product.productType !== 'optionsschein' || !['call', 'put'].includes(product.optionType)) issues.push('不支持的合约类型')
  if (product.quoteCurrency !== 'EUR' || !['USD', 'EUR'].includes(product.underlyingCurrency)) issues.push('暂不支持此报价币种')
  if (product.paymentStyle !== 'DOMESTIC') issues.push('Quanto 或未知结算方式暂不建模')
  if (!positive(product.ask) || !positive(product.bid) || product.bid > product.ask) issues.push('缺少有效双边报价')
  if (!positive(product.underlyingSpot) || !positive(product.strikePrice) || !positive(product.ratio)) issues.push('缺少标的价格或合约条款')
  const expiry = Date.parse(product.expiry)
  if (!Number.isFinite(expiry) || expiry <= now) issues.push('已到期或到期日未知')
  for (const [field, label] of [['quoteAsOf', '产品报价'], ['underlyingAsOf', '标的报价']]) {
    const time = Date.parse(product[field])
    if (!Number.isFinite(time)) issues.push(`${label}时间未知`)
    else if (time > now + 120_000) issues.push(`${label}时间在未来`)
    else if (now - time > CANDIDATE_QUOTE_MAX_AGE_HOURS * 3_600_000) issues.push(`${label}超过 ${CANDIDATE_QUOTE_MAX_AGE_HOURS} 小时`)
  }
  if (Math.abs(Date.parse(product.quoteAsOf) - Date.parse(product.underlyingAsOf)) > CANDIDATE_PAIR_MAX_SKEW_MINUTES * 60_000) issues.push('产品与标的报价相差超过 1 小时')
  if (product.underlyingCurrency === 'USD') {
    const fxTime = Date.parse(product.fxAsOf)
    if (!positive(product.usdEurRate) || product.fxSource !== 'frankfurter' || !Number.isFinite(fxTime)
      || fxTime > now + 120_000 || now - fxTime > 7 * DAY) issues.push('缺少近 7 天有效汇率')
  }
  return issues
}

// Quote currency is EUR. Price on the underlying's native scale, converting
// the model value into EUR with the explicit FX reference, including the ratio.
export function candidateMetrics(product, { now = Date.now(), spot = product.underlyingSpot, fx = product.usdEurRate } = {}) {
  const issues = candidateIssues(product, now)
  if (issues.length) return { issues, metrics: null }
  const conversion = product.underlyingCurrency === 'USD' ? fx : 1
  if (!positive(conversion) || !positive(spot)) return { issues: ['无法统一标的估值'], metrics: null }
  const days = (Date.parse(product.expiry) - now) / DAY
  const base = { spot, strike: product.strikePrice, years: days / 365, rate: referenceRate({ underlyingSpotRawCurrency: product.underlyingCurrency }), direction: product.optionType }
  const multiplier = product.ratio * conversion
  const mid = (product.bid + product.ask) / 2
  const calibrated = impliedVolatility({ ...base, price: mid / multiplier })
  const provider = positive(product.iv)
  const useCalibration = calibrated != null && (provider == null || calibrated >= provider / 2 && calibrated <= provider * 2)
  const volatility = useCalibration ? calibrated : provider
  if (!positive(volatility)) return { issues: ['报价无法反推 IV，且提供方未给出有效 IV'], metrics: null }
  const value = (move, elapsed) => blackScholesPrice({ ...base, spot: spot * (1 + move / 100), years: Math.max(0, days - elapsed) / 365, volatility })
  const model = value(0, 0)
  if (!(model > 0)) return { issues: ['模型无法定价'], metrics: null }
  // Hold the observed proportional spread constant: buy at ask, value a future
  // sale at estimated bid. Current holders are compared against today's bid.
  const futureBid = move => product.bid * value(move, 30) / model
  const breakEven = product.strikePrice + (product.optionType === 'put' ? -1 : 1) * product.ask / multiplier
  const bidValues = { down: futureBid(-20), flat: futureBid(0), up: futureBid(20) }
  return { issues: [], metrics: {
    days: Math.ceil(days), volatilityPct: round(volatility * 100, 1), calibrated: useCalibration,
    spreadPct: round((product.ask - product.bid) / product.ask * 100),
    leverage: round(Math.abs(blackScholesDelta({ ...base, volatility })) * spot / model, 1),
    requiredMovePct: breakEven > 0 ? round((breakEven / spot - 1) * 100) : null,
    breakEvenProbability: breakEven > 0 ? finishBeyondProbability({ spot, level: breakEven, volatility: provider ?? volatility, years: days / 365, rate: base.rate, direction: base.direction }) : 0,
    flatPct: round((bidValues.flat / product.ask - 1) * 100),
    downPct: round((bidValues.down / product.ask - 1) * 100),
    upPct: round((bidValues.up / product.ask - 1) * 100),
    bidValues,
  } }
}

export function compareRealRoll(origin, candidate, quantity, now = Date.now()) {
  if (!origin || !positive(quantity)) return { issues: ['缺少原持仓或实际数量'], comparison: null }
  if (candidate.isin === origin.isin || candidate.underlyingId !== origin.underlyingId
    || candidate.optionType !== origin.optionType || candidate.underlyingCurrency !== origin.underlyingCurrency
    || candidate.expiry <= origin.expiry) return { issues: ['候选须为同一标的、同方向且到期更晚的其他产品'], comparison: null }
  if (Math.abs(Date.parse(candidate.quoteAsOf) - Date.parse(origin.quoteAsOf)) > CANDIDATE_PAIR_MAX_SKEW_MINUTES * 60_000) {
    return { issues: ['新旧产品报价相差超过 1 小时，请刷新后比较'], comparison: null }
  }
  const held = candidateMetrics(origin, { now })
  const next = candidateMetrics(candidate, { now, spot: origin.underlyingSpot, fx: origin.usdEurRate })
  const issues = [...held.issues.map(s => `原持仓：${s}`), ...next.issues]
  if (issues.length) return { issues, comparison: null }
  const budget = origin.bid * quantity
  const newQuantity = Math.floor(budget / candidate.ask)
  if (newQuantity < 1) return { issues: ['卖出所得不足购买一份候选产品'], comparison: null }
  const cash = budget - newQuantity * candidate.ask
  const scenarios = ['down', 'flat', 'up'].map(id => ({
    id, holdPnl: round(held.metrics.bidValues[id] * quantity - budget),
    rollPnl: round(next.metrics.bidValues[id] * newQuantity + cash - budget),
  }))
  return { issues: [], comparison: {
    budget: round(budget), quantity: newQuantity, cost: round(newQuantity * candidate.ask), cash: round(cash),
    spreadCost: round((candidate.ask - candidate.bid) * newQuantity),
    worstImprovement: round(Math.min(...scenarios.map(s => s.rollPnl)) - Math.min(...scenarios.map(s => s.holdPnl))),
    flatImprovement: round(scenarios[1].rollPnl - scenarios[1].holdPnl),
    upDifference: round(scenarios[2].rollPnl - scenarios[2].holdPnl), scenarios,
  } }
}

// These groups are only for research. Candidate prices/quantities never change
// holdings, account weights, the stress baseline or exit signals.
export function mergeOpportunityGroups(heldGroups = [], candidates = [], heldIsins = new Set()) {
  const groups = heldGroups.map(group => ({ ...group, watchCandidates: [] }))
  const bySymbol = new Map(groups.filter(g => g.alpacaSymbol).map(g => [g.alpacaSymbol, g]))
  const byId = new Map()
  for (const candidate of candidates) {
    if (heldIsins.has(candidate.isin)) continue
    let group = (candidate.underlyingSymbol && bySymbol.get(candidate.underlyingSymbol)) || byId.get(candidate.underlyingId)
    if (!group) {
      group = { key: `watch:${candidate.underlyingId}`, groupName: candidate.underlyingName,
        alpacaSymbol: candidate.underlyingSymbol, derivatives: [], stocks: [], marketValue: 0, watchCandidates: [] }
      groups.push(group)
      byId.set(candidate.underlyingId, group)
      if (candidate.underlyingSymbol) bySymbol.set(candidate.underlyingSymbol, group)
    }
    if (!group.watchCandidates.some(p => p.isin === candidate.isin)) group.watchCandidates.push(candidate)
  }
  return groups
}
