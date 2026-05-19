import assert from 'node:assert/strict'
import test from 'node:test'

import { buildWatchlistGroups } from './watchlistGrouping.js'

const portfolio = {
  summary: { totalMarketValue: 10000 },
  positions: [
    { symbol: 'MU', displayName: 'Micron Technology', assetClass: 'STOCK', quantity: 10, marketValue: 1000, costBasis: 800, lastPrice: 100 },
    { symbol: 'DE000TURBO1', displayName: 'TurboC O.End Micron', assetClass: 'DERIVATIVE', quantity: 3, marketValue: 300, costBasis: 250, lastPrice: 10 },
    { symbol: 'NVDA', displayName: 'NVIDIA', assetClass: 'STOCK', quantity: 2, marketValue: 2000, costBasis: 1200, lastPrice: 1000 },
    { symbol: 'ETF001', displayName: 'World ETF', assetClass: 'FUND', quantity: 4, marketValue: 400, costBasis: 350, lastPrice: 100 },
  ],
}

const enrichment = [
  {
    isin: 'DE000TURBO1',
    display_name: 'TurboC O.End Micron',
    asset_class: 'DERIVATIVE',
    product_type: 'open_end_turbo',
    underlying: 'Micron Technology',
    enrichment_tier: 'tier1',
    live_enrichment_enabled: true,
    quote_source: 'boerse_frankfurt',
    metadata_source: 'onvista',
    quote_price: 11,
    market_value: 330,
    delta: 0.7,
    leverage: 1.6,
  },
]

test('groups stock and derivative rows under the same underlying overview', () => {
  const groups = buildWatchlistGroups(portfolio, enrichment)

  assert.equal(groups.tier1.length, 1)
  const micron = groups.tier1[0]
  assert.equal(micron.groupName, 'Micron Technology')
  assert.equal(micron.stocks.length, 1)
  assert.equal(micron.derivatives.length, 1)
  assert.equal(micron.derivatives[0].liveEnrichmentEnabled, true)
  assert.equal(micron.liveDerivativeCount, 1)
})

test('non-derivative rows without enrichment fall back to tier3 json/portfolio data', () => {
  const groups = buildWatchlistGroups(portfolio, enrichment)

  assert.equal(groups.tier3.length, 2)
  assert.deepEqual(groups.tier3.map((group) => group.groupName).sort(), ['NVIDIA', 'World ETF'])
  assert.equal(groups.tier3.every((group) => group.derivatives.length === 0), true)
})

test('only tier1 derivatives are marked as realtime data', () => {
  const groups = buildWatchlistGroups(portfolio, [
    ...enrichment,
    {
      isin: 'DE000TIER2',
      display_name: 'Call NVIDIA',
      asset_class: 'DERIVATIVE',
      product_type: 'optionsschein',
      underlying: 'NVIDIA',
      enrichment_tier: 'tier2',
      live_enrichment_enabled: false,
      quote_source: 'rust_portfolio_summary',
      quote_price: 2,
      market_value: 200,
    },
  ])

  assert.equal(groups.tier1.flatMap((group) => group.derivatives).length, 1)
  assert.equal(groups.tier2.length, 1)
  assert.equal(groups.tier2[0].derivatives[0].liveEnrichmentEnabled, false)
  assert.equal(groups.tier2[0].derivatives[0].quoteSource, 'rust_portfolio_summary')
})

test('groups multiple derivative products by inferred underlying when live metadata is missing', () => {
  const groups = buildWatchlistGroups({ summary: {}, positions: [] }, [
    { isin: 'D1', display_name: 'Call 18.06.26 NVIDIA 131', instrument: 'Call 18.06.26 NVIDIA 131', asset_class: 'DERIVATIVE', product_type: 'optionsschein', enrichment_tier: 'tier2', live_enrichment_enabled: false },
    { isin: 'D2', display_name: 'TurboC O.End NVIDIA', instrument: 'TurboC O.End NVIDIA', asset_class: 'DERIVATIVE', product_type: 'open_end_turbo', enrichment_tier: 'tier2', live_enrichment_enabled: false },
  ])

  assert.equal(groups.tier2.length, 1)
  assert.equal(groups.tier2[0].groupName, 'NVIDIA')
  assert.equal(groups.tier2[0].derivatives.length, 2)
})

test('groups stock legal names with derivative underlying names', () => {
  const groups = buildWatchlistGroups(
    {
      summary: { totalMarketValue: 10000 },
      positions: [
        { symbol: 'US4581401001', displayName: 'Intel Corp. · Registered Shares DL -,001', instrument: 'Intel Corp.', assetClass: 'STOCK', quantity: 10, marketValue: 1000, costBasis: 900, lastPrice: 100 },
        { symbol: 'DE000HS75VL7', displayName: 'Call 15.01.27 Intel 30', assetClass: 'DERIVATIVE', quantity: 1, marketValue: 200, costBasis: 150, lastPrice: 2 },
      ],
    },
    [
      { isin: 'DE000HS75VL7', display_name: 'Call 15.01.27 Intel 30', instrument: 'Call 15.01.27 Intel 30', asset_class: 'DERIVATIVE', product_type: 'optionsschein', underlying: 'Intel', enrichment_tier: 'tier1', live_enrichment_enabled: true },
    ],
  )

  assert.equal(groups.tier1.length, 1)
  assert.equal(groups.tier3.length, 0)
  assert.equal(groups.tier1[0].groupName, 'Intel')
  assert.equal(groups.tier1[0].stocks.length, 1)
  assert.equal(groups.tier1[0].derivatives.length, 1)
})

test('groups broker shorthand underlyings with stock legal names', () => {
  const groups = buildWatchlistGroups(
    {
      summary: { totalMarketValue: 20000 },
      positions: [
        { symbol: 'US8740391003', displayName: 'Taiwan Semiconduct.Manufact.Co · Reg.Shs (Spons.ADRs)/5 TA 10', assetClass: 'STOCK', quantity: 5, marketValue: 5000, costBasis: 4000, lastPrice: 1000 },
        { symbol: 'US02079K1079', displayName: 'Alphabet Inc. · Reg. Shs Cap.Stk Cl. C DL-,001', assetClass: 'STOCK', quantity: 5, marketValue: 5000, costBasis: 4000, lastPrice: 1000 },
        { symbol: 'US5949181045', displayName: 'Microsoft Corp. · Registered Shares DL-,00000625', assetClass: 'STOCK', quantity: 5, marketValue: 5000, costBasis: 4000, lastPrice: 1000 },
      ],
    },
    [
      { isin: 'D-TSM', display_name: 'Call TaiwanSM', instrument: 'Call TaiwanSM', asset_class: 'DERIVATIVE', product_type: 'optionsschein', underlying: 'TaiwanSM', enrichment_tier: 'tier1', live_enrichment_enabled: true },
      { isin: 'D-GOOG', display_name: 'Call Alphab.C', instrument: 'Call Alphab.C', asset_class: 'DERIVATIVE', product_type: 'optionsschein', underlying: 'Alphab.C', enrichment_tier: 'tier1', live_enrichment_enabled: true },
      { isin: 'D-MSFT', display_name: 'Call Microso.', instrument: 'Call Microso.', asset_class: 'DERIVATIVE', product_type: 'optionsschein', underlying: 'Microso.', enrichment_tier: 'tier2', live_enrichment_enabled: false },
    ],
  )

  assert.equal(groups.tier1.find((group) => group.groupName === 'TaiwanSM')?.stocks.length, 1)
  assert.equal(groups.tier1.find((group) => group.groupName === 'Alphab.C')?.stocks.length, 1)
  assert.equal(groups.tier2.find((group) => group.groupName === 'Microso.')?.stocks.length, 1)
})

test('group latest trade uses the newest instrument date across nested categories', () => {
  const groups = buildWatchlistGroups(
    {
      summary: { totalMarketValue: 10000 },
      positions: [
        { symbol: 'MU', displayName: 'Micron Technology', assetClass: 'STOCK', quantity: 10, marketValue: 1000, costBasis: 800, lastPrice: 100, lastTradeDate: '2026-01-01T00:00:00Z' },
        { symbol: 'DE000TURBO1', displayName: 'TurboC O.End Micron', assetClass: 'DERIVATIVE', quantity: 3, marketValue: 300, costBasis: 250, lastPrice: 10, lastTradeDate: '2026-05-01T00:00:00Z' },
      ],
    },
    enrichment,
  )

  const micron = groups.tier1[0]
  assert.equal(micron.lastTradeDate, '2026-05-01T00:00:00Z')
  assert.equal(micron.holdingDays, micron.derivatives[0].holdingDays)
})
