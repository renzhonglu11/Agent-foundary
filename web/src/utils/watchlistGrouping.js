const tierBuckets = ['tier1', 'tier2', 'tier3']
const tierRank = { tier1: 0, tier2: 1, tier3: 2 }
const alpacaSymbolByIsin = new Map([
  ['US02079K1079', 'GOOG'],
  ['US0231351067', 'AMZN'],
  ['US0420682058', 'ARM'],
  ['US0079031078', 'AMD'],
  ['US1491231015', 'CAT'],
  ['US19247G1076', 'COIN'],
  ['US24703L2025', 'DELL'],
  ['US23804L1035', 'DDOG'],
  ['US5738741041', 'MRVL'],
  ['US4435106079', 'HUBS'],
  ['US4581401001', 'INTC'],
  ['US5949181045', 'MSFT'],
  ['US68389X1054', 'ORCL'],
  ['US67066G1040', 'NVDA'],
  ['US00724F1012', 'ADBE'],
  ['US09290D1019', 'BX'],
  ['US11135F1012', 'AVGO'],
  ['US18915M1071', 'NET'],
  ['US7475251036', 'QCOM'],
  ['US8522341036', 'XYZ'],
  ['US8740391003', 'TSM'],
  ['US87612E1064', 'TGT'],
  ['US8807701029', 'TER'],
  ['US88160R1014', 'TSLA'],
  ['US8825081040', 'TXN'],
  ['US88579Y1010', 'MMM'],
  ['US9113121068', 'UPS'],
  ['IE00B4BNMY34', 'ACN'],
  ['KYG393871085', 'GFS'],
  ['NL0000226223', 'STM'],
  ['PA1436583006', 'CCL'],
])
const alpacaSymbolByAliasKey = new Map([
  ['accenture', 'ACN'],
  ['alphabet', 'GOOG'],
  ['advanced micro devices', 'AMD'],
  ['amazon', 'AMZN'],
  ['arm', 'ARM'],
  ['asml', 'ASML'],
  ['blackstone', 'BX'],
  ['block', 'XYZ'],
  ['broadcom', 'AVGO'],
  ['caterpillar', 'CAT'],
  ['cloudflare', 'NET'],
  ['coinbase', 'COIN'],
  ['datadog', 'DDOG'],
  ['dell technologies', 'DELL'],
  ['enphase', 'ENPH'],
  ['enphase energy', 'ENPH'],
  ['enphasee', 'ENPH'],
  ['globalfoundries', 'GFS'],
  ['hubspot', 'HUBS'],
  ['intel', 'INTC'],
  ['marvell', 'MRVL'],
  ['micron technology', 'MU'],
  ['microsoft', 'MSFT'],
  ['nextera', 'NEE'],
  ['nextera energy', 'NEE'],
  ['nvidia', 'NVDA'],
  ['oracle', 'ORCL'],
  ['qualcomm', 'QCOM'],
  ['stmicro', 'STM'],
  ['stmicroelectronics', 'STM'],
  ['taiwan semiconduct', 'TSM'],
  ['target', 'TGT'],
  ['teradyne', 'TER'],
  ['texas instruments', 'TXN'],
  ['tesla', 'TSLA'],
  ['carnival', 'CCL'],
  ['united parcel service', 'UPS'],
])
const underlyingAliasKeys = new Map([
  ['accent', 'accenture'],
  ['accenture plc', 'accenture'],
  ['amd advanced micro devices', 'advanced micro devices'],
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
  ['delltech', 'dell technologies'],
  ['globalf', 'globalfoundries'],
  ['texasin', 'texas instruments'],
  ['texas in', 'texas instruments'],
  ['ups', 'united parcel service'],
  ['qualcomm', 'qualcomm'],
  ['broadcom', 'broadcom'],
  ['stmicro', 'stmicroelectronics'],
  ['stmicroelectronics', 'stmicroelectronics'],
])

export function buildWatchlistGroups(data, structuredProducts = [], alpacaQuotes = []) {
  const totalMarketValue = Number(data?.summary?.totalMarketValue) || 0
  const positions = Array.isArray(data?.positions) ? data.positions : []
  const alpacaQuoteBySymbol = new Map(
    (Array.isArray(alpacaQuotes) ? alpacaQuotes : [])
      .filter((item) => item?.symbol)
      .map((item) => [String(item.symbol).toUpperCase(), item]),
  )
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
    const row = positionToInstrumentRow(position, enriched, index, totalMarketValue, alpacaQuoteBySymbol)
    addInstrumentToGroup(groupsByKey, row)
  })

  structuredProducts.forEach((enriched, index) => {
    if (!enriched?.isin || positions.some((position) => position.symbol === enriched.isin)) return
    const row = enrichmentToInstrumentRow(enriched, index + openPositions.length, totalMarketValue, alpacaQuoteBySymbol)
    addInstrumentToGroup(groupsByKey, row)
  })

  const grouped = { tier1: [], tier2: [], tier3: [] }
  for (const group of groupsByKey.values()) {
    finalizeGroup(group, totalMarketValue)
    applyGroupSpotQuote(group, alpacaQuoteBySymbol)
    applyGroupMonitoringMetrics(group)
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
  existing.liveStockQuoteCount += !row.isDerivative && row.liveStockQuoteEnabled ? 1 : 0
  updateLatestTrade(existing, row)
  existing.derivativeCount += row.isDerivative ? 1 : 0
  existing.stockCount += row.isDerivative ? 0 : 1
  existing.maxLeverage = Math.max(existing.maxLeverage || 0, Number(row.leverage) || 0)
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
    liveStockQuoteCount: 0,
    liveQuoteCount: 0,
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
  group.liveQuoteCount = group.liveDerivativeCount + group.liveStockQuoteCount
  group.apiStatus = group.liveStockQuoteCount > 0 ? 'alpaca_iex' : group.liveDerivativeCount > 0 ? 'structured_enrichment' : 'portfolio'
  group.rating = group.derivativeCount > 0 ? '观望' : '持有'
  group.price = null
  group.targetPrice = null
  group.liveEnrichmentEnabled = group.liveQuoteCount > 0
}

function applyGroupSpotQuote(group, alpacaQuoteBySymbol) {
  group.alpacaSymbol = resolveAlpacaSymbolForGroup(group)
  const quote = group.alpacaSymbol ? alpacaQuoteBySymbol.get(group.alpacaSymbol) : null
  group.spotQuote = quote || null
  group.spotQuoteSource = quote ? 'alpaca_iex' : null

  if (quote && group.liveStockQuoteCount === 0) {
    group.liveQuoteCount += 1
    group.apiStatus = 'alpaca_iex'
    group.liveEnrichmentEnabled = true
  }

  group.stocks.forEach((row) => {
    if (quote && row.alpacaSymbol === group.alpacaSymbol && !row.liveStockQuoteEnabled) {
      row.price = Number(quote.price) || row.price
      row.bidPrice = quote.bidPrice
      row.askPrice = quote.askPrice
      row.rawPrice = quote.rawPrice
      row.rawCurrency = quote.rawCurrency
      row.currency = quote.currency
      row.usdEurRate = quote.usdEurRate
      row.priceAsOf = quote.priceAsOf
      row.quoteSource = quote.priceSource || 'alpaca_iex'
      row.liveStockQuoteEnabled = true
      row.liveEnrichmentEnabled = true
      row.apiStatus = 'alpaca_iex'
    }
  })
}

function applyGroupMonitoringMetrics(group) {
  const spot = spotPriceForGroup(group)
  let deltaExposure = 0
  let hasDeltaExposure = false
  let hasEstimatedDeltaExposure = false

  group.instruments.forEach((row) => {
    row.underlyingSpot = spot
    row.calculatedBreakEven = breakEvenForRow(row)
    const rowDeltaExposure = calculateDeltaExposure(row, spot)
    row.deltaExposureEur = rowDeltaExposure.value
    row.deltaExposureEstimated = rowDeltaExposure.estimated
    if (row.isDerivative && rowDeltaExposure.value != null) {
      deltaExposure += rowDeltaExposure.value
      hasDeltaExposure = true
      hasEstimatedDeltaExposure = hasEstimatedDeltaExposure || rowDeltaExposure.estimated
    }
    row.effectiveLeverage = calculateEffectiveLeverage(row, spot)
    row.breakEvenDistanceAbs = calculateBreakEvenDistanceAbs(row, spot)
    row.breakEvenDistancePct = calculateBreakEvenDistancePct(row, spot)
    row.breakEvenStatus = calculateBreakEvenStatus(row.breakEvenDistanceAbs)
  })

  group.deltaExposure = hasDeltaExposure ? deltaExposure : null
  group.deltaExposureEstimated = hasEstimatedDeltaExposure
}

function spotPriceForGroup(group) {
  const groupSpot = positiveNumber(group.spotQuote?.price)
  if (groupSpot != null) return groupSpot

  const liveStock = group.stocks.find((row) => row.liveStockQuoteEnabled && positiveNumber(row.price) != null)
  if (liveStock) return positiveNumber(liveStock.price)

  const pricedStock = group.stocks.find((row) => positiveNumber(row.price) != null)
  return pricedStock ? positiveNumber(pricedStock.price) : null
}

function calculateDeltaExposure(row, spot) {
  const quantity = finiteNumber(row.quantity)
  const delta = finiteNumber(row.delta)
  const ratio = finiteNumber(row.ratio)
  const spotPrice = finiteNumber(spot)
  if ([quantity, delta, ratio, spotPrice].every((value) => value != null)) {
    return { value: quantity * delta * ratio * spotPrice, estimated: false }
  }

  const omega = finiteNumber(row.omega)
  const marketValue = finiteNumber(row.marketValue)
  if (omega != null && marketValue != null) return { value: omega * marketValue, estimated: true }

  return { value: null, estimated: false }
}

function calculateEffectiveLeverage(row, spot) {
  const omega = positiveNumber(row.omega)
  if (omega != null) return omega

  const providerLeverage = positiveNumber(row.leverage)
  if (providerLeverage != null) return providerLeverage

  const ratio = positiveNumber(row.ratio)
  const spotPrice = positiveNumber(spot)
  const productPrice = positiveNumber(row.price)
  if ([ratio, spotPrice, productPrice].some((value) => value == null)) return null

  return (ratio * spotPrice) / productPrice
}

function calculateBreakEvenDistanceAbs(row, spot) {
  const breakEven = breakEvenForRow(row)
  const spotPrice = finiteNumber(spot)
  if (breakEven == null || spotPrice == null) return null
  return spotPrice - breakEven
}

function calculateBreakEvenDistancePct(row, spot) {
  const breakEven = positiveNumber(breakEvenForRow(row))
  const spotPrice = positiveNumber(spot)
  if (breakEven == null || spotPrice == null) return null
  return ((spotPrice / breakEven) - 1) * 100
}

function calculateBreakEvenStatus(distanceAbs) {
  const distance = finiteNumber(distanceAbs)
  if (distance == null) return null
  return distance >= 0 ? 'above' : 'below'
}

function breakEvenForRow(row) {
  const explicitBreakEven = finiteNumber(row.breakEven)
  if (explicitBreakEven != null) return explicitBreakEven

  const strike = finiteNumber(row.strikePrice)
  const ratio = positiveNumber(row.ratio)
  const price = positiveNumber(row.price)
  if ([strike, ratio, price].some((value) => value == null)) return null

  const direction = optionDirection(row)
  if (direction === 'put') return strike - (price / ratio)
  if (direction === 'call') return strike + (price / ratio)
  return null
}

function optionDirection(row) {
  const text = `${row.stockName || ''} ${row.instrument || ''} ${row.displayName || ''}`.toLowerCase()
  if (/\bput\b/.test(text)) return 'put'
  if (/\bcall\b/.test(text)) return 'call'
  return null
}

function positionToInstrumentRow(position, enriched, index, totalMarketValue, alpacaQuoteBySymbol = new Map()) {
  const assetClass = position.assetClass || enriched?.asset_class || '—'
  const productType = enriched?.product_type
  const isDerivative = isDerivativeAsset(assetClass) || Boolean(productType)
  let tier = enriched?.enrichment_tier
  if (!tier) tier = isDerivative ? 'tier2' : 'tier3'
  if (!tierBuckets.includes(tier)) tier = 'tier3'

  const marketValue = Number(enriched?.market_value ?? position.marketValue) || 0
  const holdingWeight = totalMarketValue > 0 ? (marketValue / totalMarketValue) * 100 : 0
  const stockName = enriched?.display_name || position.displayName || position.name || position.pdfName || position.symbol || 'Unknown'
  const symbol = position.symbol || enriched?.isin || position.instrument || stockName
  const alpacaSymbol = resolveAlpacaSymbol({ position, enriched, stockName, symbol, isDerivative })
  const liveStockQuote = !isDerivative && alpacaSymbol ? alpacaQuoteBySymbol.get(alpacaSymbol) : null
  const price = Number(liveStockQuote?.price ?? enriched?.quote_price ?? position.lastPrice) || 0
  const hasLiveEnrichment = hasRealtimeStructuredData(enriched)
  const source = liveStockQuote ? 'alpaca_iex' : enriched ? (hasLiveEnrichment ? 'structured_enrichment' : 'portfolio') : priceSourceForPosition(position)

  return {
    id: `${symbol || stockName}-${index}`,
    stockName,
    symbol,
    price,
    currency: liveStockQuote?.currency || 'EUR',
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
    liveEnrichmentEnabled: hasLiveEnrichment || Boolean(liveStockQuote),
    liveStockQuoteEnabled: Boolean(liveStockQuote),
    isDerivative,
    alpacaSymbol,
    bidPrice: liveStockQuote?.bidPrice,
    askPrice: liveStockQuote?.askPrice,
    rawPrice: liveStockQuote?.rawPrice,
    rawCurrency: liveStockQuote?.rawCurrency,
    usdEurRate: liveStockQuote?.usdEurRate,
    priceAsOf: liveStockQuote?.priceAsOf,
    displayName: position.displayName,
    pdfName: position.pdfName,
    issuer: enriched?.issuer || position.issuer,
    instrument: enriched?.instrument || position.instrument,
    productType,
    quoteSource: liveStockQuote?.priceSource || enriched?.quote_source,
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
    breakEven: enriched?.break_even ?? enriched?.breakEven ?? enriched?.break_even_price ?? enriched?.breakEvenPrice,
    expiry: enriched?.expiry,
    lastTradeDate: position.lastTradeDate,
    tierNote: enriched
      ? '来自 Python structured-products enrichment；CSV/PDF 解析以 Rust portfolio summary 为准。'
      : liveStockQuote
        ? 'Tier 1 普通股票价格来自 Alpaca IEX latest quote；市值仍保留 portfolio summary 口径。'
        : '来自当前 portfolio summary / JSON fallback；未触发衍生品实时 enrichment。',
  }
}

function hasRealtimeStructuredData(enriched) {
  if (!enriched) return false
  return enriched.quote_source === 'boerse_frankfurt'
    || Boolean(enriched.metadata_source)
    || Boolean(enriched.greeks_source)
}

function enrichmentToInstrumentRow(enriched, index, totalMarketValue, alpacaQuoteBySymbol = new Map()) {
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
    alpacaQuoteBySymbol,
  )
}

export function collectTier1AlpacaSymbols(stockRows) {
  const tier1 = Array.isArray(stockRows?.tier1) ? stockRows.tier1 : []
  const symbols = []
  const seen = new Set()

  tier1.forEach((group) => {
    group.stocks.forEach((row) => {
      const symbol = row.alpacaSymbol
      if (symbol && !seen.has(symbol)) {
        seen.add(symbol)
        symbols.push(symbol)
      }
    })
  })

  return symbols
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

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : null
}

function positiveNumber(value) {
  const numeric = finiteNumber(value)
  return numeric != null && numeric > 0 ? numeric : null
}

function resolveAlpacaSymbol({ position, enriched, stockName, symbol, isDerivative }) {
  if (isDerivative) return null

  const rawSymbol = String(symbol || '').trim().toUpperCase()
  if (alpacaSymbolByIsin.has(rawSymbol)) return alpacaSymbolByIsin.get(rawSymbol)
  if (isTickerCandidate(rawSymbol)) return rawSymbol

  const identityValues = [
    position?.displayName,
    position?.name,
    position?.pdfName,
    position?.instrument,
    enriched?.display_name,
    enriched?.instrument,
    stockName,
  ]
  for (const value of identityValues) {
    const aliasKey = canonicalGroupKey(value)
    const alpacaSymbol = alpacaSymbolByAliasKey.get(aliasKey)
    if (alpacaSymbol) return alpacaSymbol
  }

  return null
}

function resolveAlpacaSymbolForGroup(group) {
  for (const row of group.stocks) {
    if (row.alpacaSymbol) return row.alpacaSymbol
  }

  const values = [
    group.symbol,
    group.groupName,
    group.key,
    ...group.derivatives.map((row) => row.underlying),
    ...group.derivatives.map((row) => inferDerivativeUnderlying(row.instrument || row.stockName || row.displayName)),
  ]

  for (const value of values) {
    const rawValue = String(value || '').trim().toUpperCase()
    if (alpacaSymbolByIsin.has(rawValue)) return alpacaSymbolByIsin.get(rawValue)

    const aliasKey = canonicalGroupKey(value)
    const alpacaSymbol = alpacaSymbolByAliasKey.get(aliasKey)
    if (alpacaSymbol) return alpacaSymbol

    if (isTickerCandidate(rawValue)) return rawValue
  }

  return null
}

function isTickerCandidate(value) {
  return /^[A-Z][A-Z0-9.]{0,9}$/.test(value) && !/^[A-Z]{2}[A-Z0-9]{10}$/.test(value)
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
