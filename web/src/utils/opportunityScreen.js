// Rule-based screen of the underlyings in the portfolio: trend, pullbacks,
// where volatility stands, and how much is already held. The tags describe
// conditions that are met today under stated thresholds. They are a list of
// places worth researching, not forecasts and not buy signals.

import { median } from './carryCost.js'
import { finite, positive, round } from './numbers.js'

// Defaults for tagging, not personal rules.
export const OPPORTUNITY_DEFAULTS = {
  pullbackReturn5dPct: -3,
  pullbackMaxBelowSma50Pct: 10,
  nearHighPct: -3,
  deepDrawdownPct: -30,
  lowPercentile: 20,
  highPercentile: 80,
  cheapIvToRealized: 0.85,
  richIvToRealized: 1.25,
  concentratedWeightPct: 10,
  lightWeightPct: 1,
}

const EXIT_LEVEL_RANK = ['urgent', 'warn', 'ok', 'unknown']

function tagsFor(row, thresholds) {
  const tags = []
  const add = (tone, code, label) => tags.push({ tone, code, label })
  const { close, sma20, sma50, sma200 } = row

  const longTermUp = close != null && sma200 != null && sma50 != null && close > sma200 && sma50 > sma200
  // A fall far below the 50-day average is a break, not a pullback.
  const shallow = close >= sma50 * (1 - thresholds.pullbackMaxBelowSma50Pct / 100)
  if (longTermUp && shallow && sma20 != null && close < sma20 && row.return5dPct != null && row.return5dPct <= thresholds.pullbackReturn5dPct) {
    add('positive', 'pullback', '上升趋势中回调')
  } else if (row.trend === 'up') {
    add('positive', 'uptrend', '上升趋势')
  }
  if (row.trend === 'down') add('caution', 'downtrend', '下降趋势')
  if (row.fromHighPct != null && row.fromHighPct >= thresholds.nearHighPct) add('neutral', 'near_high', '接近一年高点')
  if (row.fromHighPct != null && row.fromHighPct <= thresholds.deepDrawdownPct) add('caution', 'deep_drawdown', `较一年高点回撤 ${Math.abs(Math.round(row.fromHighPct))}%`)

  if (row.volatilityPercentile != null && row.volatilityPercentile <= thresholds.lowPercentile) add('positive', 'vol_low', '波动率处于一年低位')
  if (row.volatilityPercentile != null && row.volatilityPercentile >= thresholds.highPercentile) add('caution', 'vol_high', '波动率处于一年高位')
  if (row.ivToRealized != null && row.ivToRealized <= thresholds.cheapIvToRealized) add('positive', 'iv_cheap', '隐含波动率低于历史波动')
  if (row.ivToRealized != null && row.ivToRealized >= thresholds.richIvToRealized) add('caution', 'iv_rich', '隐含波动率明显高于历史波动')
  if (row.ivPercentile != null && row.ivPercentile <= thresholds.lowPercentile) add('positive', 'iv_low', '隐含波动率处于自身低位')
  if (row.ivPercentile != null && row.ivPercentile >= thresholds.highPercentile) add('caution', 'iv_high', '隐含波动率处于自身高位')

  if (row.weightPct >= thresholds.concentratedWeightPct) add('caution', 'concentrated', '仓位已较集中')
  else if (row.weightPct < thresholds.lightWeightPct) add('neutral', 'light', '仓位较轻')
  return tags
}

// `groups` are the watchlist groups of every tier. `impliedByGroup` maps a
// group key to the median warrant IV (decimal), `ivHistoryByIsin` an ISIN to
// its recorded-history statistics, `exitSignals` is the exit-signal list.
export function buildOpportunityScreen({ groups = [], dailyStats = [], impliedByGroup = new Map(), ivHistoryByIsin = new Map(), exitSignals = [], totalMarketValue = 0, thresholds = OPPORTUNITY_DEFAULTS } = {}) {
  const statsBySymbol = new Map((dailyStats || []).map(stats => [String(stats.symbol).toUpperCase(), stats]))
  const exitLevelById = new Map((exitSignals || []).map(signal => [signal.id, signal.level]))

  const rows = (groups || []).flatMap((group) => {
    const stats = statsBySymbol.get(String(group.alpacaSymbol || '').toUpperCase())
    const close = positive(stats?.lastClose)
    if (!stats || close == null) return []

    const sma20 = positive(stats.sma20)
    const sma50 = positive(stats.sma50)
    const sma200 = positive(stats.sma200)
    const realized = positive(stats.realizedVol60d) ?? positive(stats.realizedVol20d)
    const watchCandidates = group.watchCandidates || []
    const freshCandidateIv = watchCandidates.filter(p => {
      const age = Date.now() - Date.parse(p.quoteAsOf)
      return age >= -120_000 && age <= 36 * 3_600_000 && p.status === 'ACTIVE'
    }).map(p => positive(p.iv)).filter(v => v != null)
    const heldIv = (group.derivatives || []).map(p => positive(p.iv)).filter(v => v != null).map(v => v > 1 ? v / 100 : v)
    const implied = median([...(heldIv.length ? heldIv : [positive(impliedByGroup.get(group.key))]), ...freshCandidateIv].filter(v => v != null))
    const products = [...new Set([...(group.derivatives || []).map(row => row.symbol), ...watchCandidates.map(p => p.isin)])]
    const histories = products.map(isin => ivHistoryByIsin.get(isin)).filter(Boolean)
    const ivPercentiles = histories.map(history => finite(history.percentile)).filter(value => value != null)
    const exitLevel = products.map(isin => exitLevelById.get(isin)).filter(Boolean)
      .sort((left, right) => EXIT_LEVEL_RANK.indexOf(left) - EXIT_LEVEL_RANK.indexOf(right))[0] ?? null
    const pctFrom = level => (level != null ? round((close / level - 1) * 100) : null)

    const row = {
      key: group.key,
      name: group.groupName || group.key,
      symbol: group.alpacaSymbol,
      asOf: stats.asOf ?? null,
      stale: Boolean(stats.stale),
      close,
      sma20,
      sma50,
      sma200,
      trend: sma50 == null || sma200 == null ? 'unknown' : close > sma50 && sma50 > sma200 ? 'up' : close < sma50 && sma50 < sma200 ? 'down' : 'mixed',
      vsSma50Pct: pctFrom(sma50),
      vsSma200Pct: pctFrom(sma200),
      return5dPct: finite(stats.return5dPct) != null ? round(stats.return5dPct) : null,
      return20dPct: finite(stats.return20dPct) != null ? round(stats.return20dPct) : null,
      return60dPct: finite(stats.return60dPct) != null ? round(stats.return60dPct) : null,
      fromHighPct: pctFrom(positive(stats.high52w)),
      realizedVolatilityPct: realized != null ? round(realized * 100, 1) : null,
      volatilityPercentile: finite(stats.realizedVol20dPercentile) != null ? Math.round(stats.realizedVol20dPercentile) : null,
      impliedVolatilityPct: implied != null ? round(implied * 100, 1) : null,
      ivToRealized: implied != null && realized != null ? round(implied / realized) : null,
      ivPercentile: ivPercentiles.length ? Math.round(median(ivPercentiles)) : null,
      ivObservations: histories.length ? Math.max(...histories.map(history => history.observations || 0)) : 0,
      weightPct: round(totalMarketValue > 0 ? Math.abs(Number(group.marketValue) || 0) / totalMarketValue * 100 : 0),
      productCount: (group.derivatives?.length || 0) + (group.stocks?.length || 0),
      watchCount: watchCandidates.length,
      exitLevel,
    }
    const tags = tagsFor(row, thresholds)
    const count = tone => tags.filter(tag => tag.tone === tone).length
    return [{ ...row, tags, positiveCount: count('positive'), cautionCount: count('caution') }]
  })

  // Most conditions in favour first; ties go to the stronger three-month trend.
  return rows.sort((left, right) => (right.positiveCount - right.cautionCount) - (left.positiveCount - left.cautionCount)
    || (right.return60dPct ?? -Infinity) - (left.return60dPct ?? -Infinity))
}
