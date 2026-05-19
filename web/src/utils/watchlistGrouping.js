const tierBuckets = ['tier1', 'tier2', 'tier3']
const tierRank = { tier1: 0, tier2: 1, tier3: 2 }
const underlyingAliasKeys = new Map([
  ['micron', 'micron technology'],
  ['taiwansm', 'taiwan semiconduct'],
  ['taiwan semiconductor', 'taiwan semiconduct'],
  ['taiwan semiconductors', 'taiwan semiconduct'],
  ['arm', 'arm'],
  ['asmlhold', 'asml'],
  ['alphab c', 'alphabet'],
  ['alphabet c', 'alphabet'],
  ['google', 'alphabet'],
  ['microso', 'microsoft'],
  ['msft', 'microsoft'],
  ['texasin', 'texas instruments'],
  ['texas in', 'texas instruments'],
  ['ups', 'united parcel service'],
  ['qualcomm', 'qualcomm'],
])

export function buildWatchlistGroups(data, structuredProducts = []) {
  const totalMarketValue = Number(data?.summary?.totalMarketValue) || 0
  const positions = Array.isArray(data?.positions) ? data.positions : []
  const enrichmentByIsin = new Map(
    structuredProducts
      .filter((item) => item?.isin)
      .map((item) => [item.isin, item]),
  )
  const openPositions = positions
    .filter((position) => Math.abs(Number(position.quantity) || 0) > 0 || Math.abs(Number(position.marketValue) || 0) > 0)
    .sort((left, right) => Math.abs(Number(right.marketValue) || 0) - Math.abs(Number(left.marketValue) || 0))

  const groupsByKey = new Map()

  openPositions.forEach((position, index) => {
    const enriched = enrichmentByIsin.get(position.symbol)
    const row = positionToInstrumentRow(position, enriched, index, totalMarketValue)
    addInstrumentToGroup(groupsByKey, row)
  })

  structuredProducts.forEach((enriched, index) => {
    if (!enriched?.isin || positions.some((position) => position.symbol === enriched.isin)) return
    const row = enrichmentToInstrumentRow(enriched, index + openPositions.length, totalMarketValue)
    addInstrumentToGroup(groupsByKey, row)
  })

  const grouped = { tier1: [], tier2: [], tier3: [] }
  for (const group of groupsByKey.values()) {
    finalizeGroup(group, totalMarketValue)
    grouped[group.enrichmentTier].push(group)
  }

  for (const tier of tierBuckets) {
    grouped[tier].sort((left, right) => Math.abs(right.marketValue) - Math.abs(left.marketValue))
  }
  return grouped
}

function addInstrumentToGroup(groupsByKey, row) {
  const key = groupKeyForRow(row)
  const existing = groupsByKey.get(key) ?? createGroup(key, row)
  if (!groupsByKey.has(key)) groupsByKey.set(key, existing)

  if (row.isDerivative) {
    existing.derivatives.push(row)
  } else {
    existing.stocks.push(row)
  }
  existing.instruments.push(row)
  existing.marketValue += row.marketValue
  existing.costBasis += row.costBasis
  existing.unrealizedPnl += row.unrealizedPnl
  existing.liveDerivativeCount += row.isDerivative && row.liveEnrichmentEnabled ? 1 : 0
  updateLatestTrade(existing, row)
  existing.derivativeCount += row.isDerivative ? 1 : 0
  existing.stockCount += row.isDerivative ? 0 : 1
  existing.maxLeverage = Math.max(existing.maxLeverage || 0, Number(row.leverage) || 0)
  if (row.delta != null && row.marketValue) {
    existing.deltaExposure += Number(row.delta) * row.marketValue
  }
  if (tierRank[row.enrichmentTier] < tierRank[existing.enrichmentTier]) {
    existing.enrichmentTier = row.enrichmentTier
  }
  if (row.isDerivative && row.underlying) {
    existing.groupName = row.underlying
  }
}

function createGroup(key, row) {
  return {
    id: `group-${key}`,
    key,
    groupName: row.underlying || row.stockName || row.symbol || key,
    symbol: row.underlyingSymbol || row.symbol,
    stocks: [],
    derivatives: [],
    instruments: [],
    enrichmentTier: row.enrichmentTier,
    rating: row.rating,
    apiStatus: row.apiStatus,
    marketValue: 0,
    costBasis: 0,
    unrealizedPnl: 0,
    unrealizedPct: 0,
    holdingStatus: '0% 仓位',
    liveDerivativeCount: 0,
    derivativeCount: 0,
    stockCount: 0,
    maxLeverage: 0,
    deltaExposure: 0,
    holdingDays: null,
    lastTradeDate: null,
  }
}

function updateLatestTrade(group, row) {
  const rowTimestamp = row.lastTradeDate ? new Date(row.lastTradeDate).getTime() : Number.NaN
  const groupTimestamp = group.lastTradeDate ? new Date(group.lastTradeDate).getTime() : Number.NaN
  if (Number.isFinite(rowTimestamp) && (!Number.isFinite(groupTimestamp) || rowTimestamp > groupTimestamp)) {
    group.lastTradeDate = row.lastTradeDate
    group.holdingDays = row.holdingDays
  }
}

function finalizeGroup(group, totalMarketValue) {
  group.unrealizedPct = group.costBasis ? (group.unrealizedPnl / group.costBasis) * 100 : 0
  const holdingWeight = totalMarketValue > 0 ? (group.marketValue / totalMarketValue) * 100 : 0
  group.holdingStatus = `${formatPercent(holdingWeight).replace('+', '')} 仓位`
  group.apiStatus = group.liveDerivativeCount > 0 ? 'structured_enrichment' : 'portfolio'
  group.rating = group.derivativeCount > 0 ? '观望' : '持有'
  group.price = null
  group.targetPrice = null
  group.liveEnrichmentEnabled = group.liveDerivativeCount > 0
}

function positionToInstrumentRow(position, enriched, index, totalMarketValue) {
  const assetClass = position.assetClass || enriched?.asset_class || '—'
  const productType = enriched?.product_type
  const isDerivative = isDerivativeAsset(assetClass) || Boolean(productType)
  let tier = enriched?.enrichment_tier
  if (!tier) tier = isDerivative ? 'tier2' : 'tier3'
  if (!tierBuckets.includes(tier)) tier = 'tier3'

  const marketValue = Number(enriched?.market_value ?? position.marketValue) || 0
  const holdingWeight = totalMarketValue > 0 ? (marketValue / totalMarketValue) * 100 : 0
  const price = Number(enriched?.quote_price ?? position.lastPrice) || 0
  const source = enriched ? 'structured_enrichment' : priceSourceForPosition(position)
  const stockName = enriched?.display_name || position.displayName || position.name || position.pdfName || position.symbol || 'Unknown'
  const symbol = position.symbol || enriched?.isin || position.instrument || stockName

  return {
    id: `${symbol || stockName}-${index}`,
    stockName,
    symbol,
    price,
    targetPrice: null,
    rating: enriched ? '观望' : '持有',
    apiStatus: source,
    holdingStatus: `${formatPercent(holdingWeight).replace('+', '')} 仓位`,
    holdingDays: daysSince(position.lastTradeDate),
    marketValue,
    quantity: Number(enriched?.quantity ?? position.quantity) || 0,
    costBasis: Number(enriched?.cost_basis ?? position.costBasis) || 0,
    unrealizedPnl: Number(position.unrealizedPnl) || 0,
    unrealizedPct: Number(position.unrealizedPct) || 0,
    assetClass,
    enrichmentTier: tier,
    liveEnrichmentEnabled: Boolean(enriched?.live_enrichment_enabled),
    isDerivative,
    displayName: position.displayName,
    pdfName: position.pdfName,
    issuer: enriched?.issuer || position.issuer,
    instrument: enriched?.instrument || position.instrument,
    productType,
    quoteSource: enriched?.quote_source,
    metadataSource: enriched?.metadata_source,
    greeksSource: enriched?.greeks_source,
    underlying: enriched?.underlying || (isDerivative ? inferDerivativeUnderlying(enriched?.instrument || enriched?.display_name || position.instrument || stockName) : stockName),
    leverage: enriched?.leverage,
    delta: enriched?.delta,
    omega: enriched?.omega,
    theta: enriched?.theta,
    iv: enriched?.iv,
    strikePrice: enriched?.strike_price,
    knockoutPrice: enriched?.knockout_price,
    ratio: enriched?.ratio,
    expiry: enriched?.expiry,
    lastTradeDate: position.lastTradeDate,
    tierNote: enriched
      ? '来自 Python structured-products enrichment；CSV/PDF 解析以 Rust portfolio summary 为准。'
      : '来自当前 portfolio summary / JSON fallback；未触发衍生品实时 enrichment。',
  }
}

function enrichmentToInstrumentRow(enriched, index, totalMarketValue) {
  return positionToInstrumentRow(
    {
      symbol: enriched.isin,
      displayName: enriched.display_name,
      assetClass: enriched.asset_class || 'DERIVATIVE',
      quantity: enriched.quantity,
      marketValue: enriched.market_value,
      costBasis: enriched.cost_basis,
      lastPrice: enriched.quote_price,
    },
    enriched,
    index,
    totalMarketValue,
  )
}

function groupKeyForRow(row) {
  return canonicalGroupKey(row.underlying || row.displayName || row.stockName || row.symbol)
}

function inferDerivativeUnderlying(value) {
  let text = String(value || '').split('·')[0].trim()
  text = text.replace(/^(call|put)\s+\d{2}\.\d{2}\.\d{2}\s+/i, '')
  text = text.replace(/^(turboc|turbop|turbo|faktl|fakts)\s+o\.end\s+/i, '')
  text = text.replace(/\s+\d+[\d.,]*\s*$/i, '')
  text = text.replace(/\s+/g, ' ').trim()
  return text || null
}

function canonicalGroupKey(value) {
  let text = selectCompanyNameSegment(value)
  text = text.replace(/\b(registered|bearer|ordinary|common|preferred|reg\.?|inhaber|namens|stamm)\s*-?\s*(shares?|aktien|shs)?\b/gi, ' ')
  text = text.replace(/\b(shares?|aktien|adr|adrs|gdrs|ads|ord|stk|cap\.?stk|class|klasse|cl\.?|dl|eur|usd|eo|ta|sw|o\.n\.|sp\.?|spons\.?|aandelen|naam|toonder)\b/gi, ' ')
  text = text.replace(/\b(corporation|corp\.?|inc\.?|incorporated|company|co\.?|ltd\.?|limited|plc|llc|holdings?|manufact\.?|ag|se|sa|nv|spa|s\.a\.?|n\.v\.?)\b/gi, ' ')
  text = text.replace(/[-,.;()/]/g, ' ')
  text = text.replace(/\b\d+[\d.,]*\b/g, ' ')
  text = text.replace(/\s+/g, ' ').trim()
  const normalized = normalizeKey(text || value)
  return underlyingAliasKeys.get(normalized) || normalized
}

function selectCompanyNameSegment(value) {
  const parts = String(value || 'unknown').split('·').map((part) => part.trim()).filter(Boolean)
  if (parts.length < 2) return parts[0] || String(value || 'unknown').trim()
  const descriptorPattern = /\b(aktien|shares?|aandelen|stammaktien|inhaber|namens|registered|reg\.?|ord|adr|gdr|o\.n\.)\b/i
  if (descriptorPattern.test(parts[0]) && !descriptorPattern.test(parts[1])) return parts[1]
  return parts[0]
}

function normalizeKey(value) {
  return String(value || 'unknown').trim().toLowerCase().replace(/\s+/g, ' ')
}

function isDerivativeAsset(assetClass) {
  return String(assetClass || '').toLowerCase().includes('derivative')
}

function priceSourceForPosition(position) {
  if (Number(position.lastPrice) <= 0) return 'missing'
  return position.symbol ? 'portfolio' : 'pdf'
}

function daysSince(dateValue) {
  if (!dateValue) return null
  const timestamp = new Date(dateValue).getTime()
  if (!Number.isFinite(timestamp)) return null
  const diffDays = Math.floor((Date.now() - timestamp) / 86400000)
  return Math.max(diffDays, 0)
}

function formatPercent(value) {
  if (!Number.isFinite(Number(value))) return '0.00%'
  const sign = Number(value) > 0 ? '+' : ''
  return `${sign}${Number(value).toFixed(2)}%`
}
