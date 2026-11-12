import { round } from './numbers.js'

const absValue = value => Math.abs(Number(value) || 0)

function isOpen(position) {
  return absValue(position?.quantity) > 0 || absValue(position?.marketValue) > 0
}

// How much of the account the Tier 1 product table actually shows, and why the
// rest is missing. Counts and values use the same open-position filter as the
// watchlist grouping, and values are absolute market values so short legs count.
export function buildPositionsCoverage({ positions = [], tier1Groups = [], shownEntries = [] } = {}) {
  const held = (Array.isArray(positions) ? positions : []).filter(isOpen)
  const heldBySymbol = new Map(held.map(position => [position.symbol, position]))
  const heldValue = held.reduce((sum, position) => sum + absValue(position.marketValue), 0)

  const shown = new Set(shownEntries.map(entry => entry?.item?.symbol).filter(symbol => heldBySymbol.has(symbol)))
  const tier1Derivatives = new Map()
  const tier1Stocks = new Set()
  for (const group of tier1Groups) {
    for (const row of group?.derivatives || []) {
      if (heldBySymbol.has(row.symbol)) tier1Derivatives.set(row.symbol, { row, groupName: group.groupName || group.key })
    }
    for (const row of group?.stocks || []) {
      if (heldBySymbol.has(row.symbol)) tier1Stocks.add(row.symbol)
    }
  }

  const valueOf = symbols => [...symbols].reduce((sum, symbol) => sum + absValue(heldBySymbol.get(symbol)?.marketValue), 0)
  const missingRisk = [...tier1Derivatives.entries()]
    .filter(([symbol]) => !shown.has(symbol))
    .map(([symbol, { row, groupName }]) => ({
      symbol,
      name: row.instrument || row.stockName || symbol,
      groupName,
      marketValue: round(absValue(heldBySymbol.get(symbol)?.marketValue)),
    }))
    .sort((left, right) => right.marketValue - left.marketValue || left.name.localeCompare(right.name))
  const stocks = [...tier1Stocks].filter(symbol => !shown.has(symbol))
  const accounted = new Set([...shown, ...tier1Derivatives.keys(), ...tier1Stocks])
  const others = held.map(position => position.symbol).filter(symbol => !accounted.has(symbol))

  const shownValue = valueOf(shown)
  const bucket = symbols => ({ count: symbols.length, value: round(valueOf(symbols)) })
  return {
    heldCount: held.length,
    heldValue: round(heldValue),
    shownCount: shown.size,
    shownValue: round(shownValue),
    shownValuePct: heldValue > 0 ? round(shownValue / heldValue * 100, 1) : 0,
    missingRisk: { ...bucket(missingRisk.map(row => row.symbol)), rows: missingRisk },
    tier1Stocks: bucket(stocks),
    otherTiers: bucket(others),
  }
}
