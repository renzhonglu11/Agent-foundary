import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildWatchlistGroups,
  canonicalGroupKey,
  collectTier1AlpacaSymbols,
  collectTier1MonitoringAlpacaSymbols,
} from './watchlistGrouping.js'

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

test('only derivatives with realtime provider data are marked as realtime data', () => {
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

test('tier1 fallback rows are not marked as realtime data', () => {
  const groups = buildWatchlistGroups({ summary: { totalMarketValue: 1000 }, positions: [] }, [
    {
      isin: 'DE000FALLBACK1',
      display_name: 'Call 18.06.26 NVIDIA 131',
      instrument: 'Call 18.06.26 NVIDIA 131',
      asset_class: 'DERIVATIVE',
      product_type: 'optionsschein',
      enrichment_tier: 'tier1',
      live_enrichment_enabled: true,
      quote_source: 'rust_portfolio_summary',
      market_value: 100,
    },
  ])

  assert.equal(groups.tier1.length, 1)
  assert.equal(groups.tier1[0].liveDerivativeCount, 0)
  assert.equal(groups.tier1[0].derivatives[0].liveEnrichmentEnabled, false)
  assert.equal(groups.tier1[0].apiStatus, 'portfolio')
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
  assert.equal(groups.tier1[0].stocks[0].alpacaSymbol, 'INTC')
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

test('applies Alpaca quotes only to tier1 stock rows', () => {
  const groups = buildWatchlistGroups(
    {
      summary: { totalMarketValue: 10000 },
      positions: [
        { symbol: 'US67066G1040', displayName: 'NVIDIA Corp.', assetClass: 'STOCK', quantity: 2, marketValue: 1000, costBasis: 800, lastPrice: 100 },
        { symbol: 'ETF001', displayName: 'World ETF', assetClass: 'FUND', quantity: 1, marketValue: 100, costBasis: 80, lastPrice: 100 },
      ],
    },
    [
      { isin: 'D-NVDA', display_name: 'Call NVIDIA', instrument: 'Call NVIDIA', asset_class: 'DERIVATIVE', product_type: 'optionsschein', underlying: 'NVIDIA', enrichment_tier: 'tier1', live_enrichment_enabled: false },
    ],
    [
      { symbol: 'NVDA', price: 142.5, bidPrice: 142, askPrice: 143, priceSource: 'alpaca_iex', priceAsOf: '2026-05-21T14:00:00Z' },
    ],
  )

  const nvidia = groups.tier1[0]
  assert.equal(nvidia.liveStockQuoteCount, 1)
  assert.equal(nvidia.apiStatus, 'alpaca_iex')
  assert.equal(nvidia.stocks[0].price, 142.5)
  assert.equal(nvidia.stocks[0].quoteSource, 'alpaca_iex')
  assert.equal(groups.tier3[0].liveStockQuoteCount, 0)
})

test('calculates derivative monitoring metrics from group spot, delta, ratio and omega', () => {
  const groups = buildWatchlistGroups(
    {
      summary: { totalMarketValue: 10000 },
      positions: [
        { symbol: 'US67066G1040', displayName: 'NVIDIA Corp.', assetClass: 'STOCK', quantity: 2, marketValue: 1000, costBasis: 800, lastPrice: 100 },
        { symbol: 'D-NVDA', displayName: 'Call NVIDIA', assetClass: 'DERIVATIVE', quantity: 10, marketValue: 50, costBasis: 40, lastPrice: 5 },
      ],
    },
    [
      { isin: 'D-NVDA', display_name: 'Call NVIDIA', instrument: 'Call NVIDIA', asset_class: 'DERIVATIVE', product_type: 'optionsschein', underlying: 'NVIDIA', enrichment_tier: 'tier1', live_enrichment_enabled: true, quote_source: 'boerse_frankfurt', quantity: 10, quote_price: 5, market_value: 50, delta: 0.5, omega: 2.5, ratio: 0.1, strike_price: 110, break_even: 160 },
    ],
    [
      { symbol: 'NVDA', price: 180, bidPrice: 179, askPrice: 181, priceSource: 'alpaca_iex', priceAsOf: '2026-05-21T14:00:00Z' },
    ],
  )

  const derivative = groups.tier1[0].derivatives[0]
  assert.equal(groups.tier1[0].deltaExposure, 90)
  assert.equal(groups.tier1[0].deltaExposureEstimated, false)
  assert.equal(derivative.underlyingSpot, 180)
  assert.equal(derivative.deltaExposureEur, 90)
  assert.equal(derivative.deltaExposureEstimated, false)
  assert.equal(derivative.effectiveLeverage, 2.5)
  assert.equal(derivative.breakEvenDistanceAbs, 20)
  assert.equal(derivative.calculatedBreakEven, 160)
  assert.equal(derivative.breakEvenStatus, 'above')
  assert.equal(Math.round(derivative.breakEvenDistancePct * 100) / 100, 12.5)
})

test('uses ratio-based delta exposure and estimates option break-even when provider value is missing', () => {
  const groups = buildWatchlistGroups(
    {
      summary: { totalMarketValue: 10000 },
      positions: [
        { symbol: 'US4581401001', displayName: 'Intel Corp.', assetClass: 'STOCK', quantity: 2, marketValue: 1000, costBasis: 800, lastPrice: 118.53 },
        { symbol: 'D-INTC', displayName: 'Call Intel', assetClass: 'DERIVATIVE', quantity: 267, marketValue: 1409.76, costBasis: 228.22, lastPrice: 6.13 },
      ],
    },
    [
      { isin: 'D-INTC', display_name: 'Call Intel', instrument: 'Call 15.01.27 Intel 50', asset_class: 'DERIVATIVE', product_type: 'optionsschein', underlying: 'Intel', enrichment_tier: 'tier1', live_enrichment_enabled: true, quote_source: 'boerse_frankfurt', quantity: 267, quote_price: 6.13, market_value: 1409.76, delta: 1, omega: 1.73, strike_price: 50, ratio: 0.1 },
    ],
  )

  const derivative = groups.tier1[0].derivatives[0]
  assert.equal(Math.round(derivative.deltaExposureEur * 100) / 100, 3164.75)
  assert.equal(derivative.deltaExposureEstimated, false)
  assert.equal(Math.round(derivative.calculatedBreakEven * 100) / 100, 111.3)
  assert.equal(Math.round(derivative.breakEvenDistancePct * 100) / 100, 6.5)
})

test('estimates derivative leverage from spot, ratio and product quote when omega is missing', () => {
  const groups = buildWatchlistGroups(
    {
      summary: { totalMarketValue: 10000 },
      positions: [
        { symbol: 'US0079031078', displayName: 'Advanced Micro Devices', assetClass: 'STOCK', quantity: 2, marketValue: 1000, costBasis: 800, lastPrice: 434.12 },
        { symbol: 'DE000HT0Q0Z8', displayName: 'Call AMD', assetClass: 'DERIVATIVE', quantity: 43, marketValue: 1297.74, costBasis: 124.38, lastPrice: 30.18 },
      ],
    },
    [
      { isin: 'DE000HT0Q0Z8', display_name: 'Call AMD', instrument: 'Call 18.12.26 AMD 160', asset_class: 'DERIVATIVE', product_type: 'optionsschein', underlying: 'AMD', enrichment_tier: 'tier1', live_enrichment_enabled: true, quote_source: 'boerse_frankfurt', quantity: 43, quote_price: 30.18, market_value: 1297.74, strike_price: 160, ratio: 0.1 },
    ],
    [
      { symbol: 'AMD', price: 434.12, priceSource: 'alpaca_iex', priceAsOf: '2026-05-27T00:00:00Z' },
    ],
  )

  const derivative = groups.tier1[0].derivatives[0]
  assert.equal(Math.round(derivative.effectiveLeverage * 100) / 100, 1.44)
  assert.equal(Math.round(derivative.calculatedBreakEven * 100) / 100, 461.8)
})

test('aggregates group delta exposure from omega fallback when delta is missing', () => {
  const groups = buildWatchlistGroups(
    { summary: { totalMarketValue: 10000 }, positions: [] },
    [
      { isin: 'D-AMD-1', display_name: 'Call AMD 160', instrument: 'Call 18.12.26 AMD 160', asset_class: 'DERIVATIVE', product_type: 'optionsschein', underlying: 'AMD', enrichment_tier: 'tier1', live_enrichment_enabled: true, quote_source: 'boerse_frankfurt', quantity: 43, market_value: 1200, omega: 1.8, ratio: 0.1 },
      { isin: 'D-AMD-2', display_name: 'Call AMD 250', instrument: 'Call 17.06.27 AMD 250', asset_class: 'DERIVATIVE', product_type: 'optionsschein', underlying: 'AMD', enrichment_tier: 'tier1', live_enrichment_enabled: true, quote_source: 'boerse_frankfurt', quantity: 10, market_value: 250, omega: 2.2, ratio: 0.1 },
    ],
  )

  const amd = groups.tier1[0]
  assert.equal(amd.deltaExposure, 2710)
  assert.equal(amd.deltaExposureEstimated, true)
  assert.equal(amd.derivatives[0].deltaExposureEur, 2160)
  assert.equal(amd.derivatives[1].deltaExposureEur, 550)
})

test('canonicalizes broker shorthand risk symbols to stable underlying keys', () => {
  assert.equal(canonicalGroupKey('Globalf.'), canonicalGroupKey('globalfoundries'))
  assert.equal(canonicalGroupKey('STMicro.'), canonicalGroupKey('stmicro'))
})

test('falls back to market value exposure when option greeks and spot are unavailable', () => {
  const groups = buildWatchlistGroups(
    { summary: { totalMarketValue: 10000 }, positions: [] },
    [
      { isin: 'D-AMD', display_name: 'Call AMD 160', instrument: 'Call 18.12.26 AMD 160', asset_class: 'DERIVATIVE', product_type: 'optionsschein', underlying: 'AMD', enrichment_tier: 'tier1', live_enrichment_enabled: true, quote_source: 'boerse_frankfurt', quantity: 43, market_value: 1200 },
    ],
  )

  const amd = groups.tier1[0]
  assert.equal(amd.deltaExposure, 1200)
  assert.equal(amd.deltaExposureEstimated, true)
  assert.equal(amd.derivatives[0].deltaExposureEur, 1200)
})

test('collects unique tier1 Alpaca symbols from stock rows', () => {
  const groups = buildWatchlistGroups(
    {
      summary: { totalMarketValue: 10000 },
      positions: [
        { symbol: 'US67066G1040', displayName: 'NVIDIA Corp.', assetClass: 'STOCK', quantity: 2, marketValue: 1000, costBasis: 800, lastPrice: 100 },
        { symbol: 'US5949181045', displayName: 'Microsoft Corp.', assetClass: 'STOCK', quantity: 1, marketValue: 500, costBasis: 400, lastPrice: 500 },
      ],
    },
    [
      { isin: 'D-NVDA', display_name: 'Call NVIDIA', instrument: 'Call NVIDIA', asset_class: 'DERIVATIVE', product_type: 'optionsschein', underlying: 'NVIDIA', enrichment_tier: 'tier1', live_enrichment_enabled: false },
      { isin: 'D-MSFT', display_name: 'Call Microso.', instrument: 'Call Microso.', asset_class: 'DERIVATIVE', product_type: 'optionsschein', underlying: 'Microso.', enrichment_tier: 'tier2', live_enrichment_enabled: false },
    ],
  )

  assert.deepEqual(collectTier1AlpacaSymbols(groups), ['NVDA'])
})

test('does not collect Alpaca symbols from tier1 derivative-only groups', () => {
  const groupsWithoutQuotes = buildWatchlistGroups(
    { summary: { totalMarketValue: 10000 }, positions: [] },
    [
      { isin: 'D-INTC-1', display_name: 'Call Intel', instrument: 'Call 15.01.27 Intel 30', asset_class: 'DERIVATIVE', product_type: 'optionsschein', underlying: 'Intel', enrichment_tier: 'tier1', live_enrichment_enabled: true, quote_source: 'boerse_frankfurt', quantity: 10, market_value: 100, delta: 1, omega: 2 },
      { isin: 'D-INTC-2', display_name: 'Call Intel', instrument: 'Call 15.01.27 Intel 50', asset_class: 'DERIVATIVE', product_type: 'optionsschein', underlying: 'Intel', enrichment_tier: 'tier1', live_enrichment_enabled: true, quote_source: 'boerse_frankfurt', quantity: 5, market_value: 50, delta: 1, omega: 1.5 },
    ],
  )

  assert.deepEqual(collectTier1AlpacaSymbols(groupsWithoutQuotes), [])
})

test('collects derivative-only underlying symbols for monitoring quotes', () => {
  const groupsWithoutQuotes = buildWatchlistGroups(
    { summary: { totalMarketValue: 10000 }, positions: [] },
    [
      { isin: 'DE000FD09AS1', display_name: 'Call Micron', instrument: 'Call 18.09.26 Micron 200', asset_class: 'DERIVATIVE', product_type: 'optionsschein', underlying: 'Micron Technology Inc', enrichment_tier: 'tier1', live_enrichment_enabled: true, quote_source: 'boerse_frankfurt', quantity: 41, market_value: 3000, strike_price: 200, ratio: 0.1 },
      { isin: 'DE000SX0MG56', display_name: 'Call AMD', instrument: 'Call 18.09.26 AMD 109', asset_class: 'DERIVATIVE', product_type: 'optionsschein', underlying: 'AMD - Advanced Micro Devices', enrichment_tier: 'tier1', live_enrichment_enabled: true, quote_source: 'boerse_frankfurt', quantity: 33, market_value: 1200, strike_price: 109, ratio: 0.1 },
    ],
  )

  assert.deepEqual(collectTier1MonitoringAlpacaSymbols(groupsWithoutQuotes), ['MU', 'AMD'])
})

test('does not request Alpaca quotes for derivative-only broker underlying shorthands', () => {
  const groups = buildWatchlistGroups(
    { summary: { totalMarketValue: 10000 }, positions: [] },
    [
      { isin: 'D-ORCL', display_name: 'Call Oracle', instrument: 'Call 18.06.26 ORACLE 100', asset_class: 'DERIVATIVE', product_type: 'optionsschein', underlying: 'ORACLE', enrichment_tier: 'tier1', live_enrichment_enabled: true },
      { isin: 'D-TXN', display_name: 'Call Texas Instruments', instrument: 'Call 18.06.26 TEXASIN. 180', asset_class: 'DERIVATIVE', product_type: 'optionsschein', underlying: 'TEXASIN.', enrichment_tier: 'tier1', live_enrichment_enabled: true },
      { isin: 'D-MRVL', display_name: 'Call Marvell', instrument: 'Call 18.06.26 MARVELL 70', asset_class: 'DERIVATIVE', product_type: 'optionsschein', underlying: 'MARVELL', enrichment_tier: 'tier1', live_enrichment_enabled: true },
      { isin: 'D-DELL', display_name: 'Call Dell Technologies', instrument: 'Call 18.06.26 DELLTECH 120', asset_class: 'DERIVATIVE', product_type: 'optionsschein', underlying: 'DELLTECH', enrichment_tier: 'tier1', live_enrichment_enabled: true },
      { isin: 'D-GFS', display_name: 'Call GlobalFoundries', instrument: 'Call 18.06.26 GLOBALF. 40', asset_class: 'DERIVATIVE', product_type: 'optionsschein', underlying: 'GLOBALF.', enrichment_tier: 'tier1', live_enrichment_enabled: true },
      { isin: 'D-ACN', display_name: 'Call Accenture', instrument: 'Call 18.06.26 ACCENT. 300', asset_class: 'DERIVATIVE', product_type: 'optionsschein', underlying: 'ACCENT.', enrichment_tier: 'tier1', live_enrichment_enabled: true },
      { isin: 'D-TER', display_name: 'Call Teradyne', instrument: 'Call 18.06.26 TERADYNE 100', asset_class: 'DERIVATIVE', product_type: 'optionsschein', underlying: 'TERADYNE', enrichment_tier: 'tier1', live_enrichment_enabled: true },
      { isin: 'D-QCOM', display_name: 'Call Qualcomm', instrument: 'Call 18.06.26 QUALCOMM 160', asset_class: 'DERIVATIVE', product_type: 'optionsschein', underlying: 'QUALCOMM', enrichment_tier: 'tier1', live_enrichment_enabled: true },
      { isin: 'D-CCL', display_name: 'Call Carnival', instrument: 'Call 18.06.26 CARNIVAL 30', asset_class: 'DERIVATIVE', product_type: 'optionsschein', underlying: 'CARNIVAL', enrichment_tier: 'tier1', live_enrichment_enabled: true },
    ],
  )

  assert.deepEqual(collectTier1AlpacaSymbols(groups), [])
})

test('does not request Alpaca quotes for derivative-only energy underlyings', () => {
  const groups = buildWatchlistGroups(
    { summary: { totalMarketValue: 10000 }, positions: [] },
    [
      { isin: 'D-ENPH', display_name: 'Call Enphase Energy', instrument: 'Call 18.06.26 ENPHASEE 50', asset_class: 'DERIVATIVE', product_type: 'optionsschein', underlying: 'ENPHASEE', enrichment_tier: 'tier1', live_enrichment_enabled: true },
      { isin: 'D-NEE', display_name: 'Call NextEra Energy', instrument: 'Call 18.06.26 NEXTERA 75', asset_class: 'DERIVATIVE', product_type: 'optionsschein', underlying: 'NEXTERA', enrichment_tier: 'tier1', live_enrichment_enabled: true },
    ],
  )

  assert.deepEqual(collectTier1AlpacaSymbols(groups), [])
})

test('does not request Alpaca quotes for derivative-only semiconductor underlyings', () => {
  const groups = buildWatchlistGroups(
    { summary: { totalMarketValue: 10000 }, positions: [] },
    [
      { isin: 'D-STM', display_name: 'Call 18.09.26 STMicro. 25', instrument: 'Call 18.09.26 STMicro. 25', asset_class: 'DERIVATIVE', product_type: 'optionsschein', underlying: '', enrichment_tier: 'tier1', live_enrichment_enabled: true },
      { isin: 'D-AVGO', display_name: 'Call 17.06.27 Broadcom 440', instrument: 'Call 17.06.27 Broadcom 440', asset_class: 'DERIVATIVE', product_type: 'optionsschein', underlying: '', enrichment_tier: 'tier1', live_enrichment_enabled: true },
    ],
  )

  assert.deepEqual(collectTier1AlpacaSymbols(groups), [])
})

test('does not request Alpaca quotes for derivative-only AMD long-form underlying', () => {
  const groups = buildWatchlistGroups(
    { summary: { totalMarketValue: 10000 }, positions: [] },
    [
      { isin: 'D-AMD', display_name: 'Call AMD', instrument: 'Call 18.12.26 AMD 160', asset_class: 'DERIVATIVE', product_type: 'optionsschein', underlying: 'AMD - Advanced Micro Devices', enrichment_tier: 'tier1', live_enrichment_enabled: true },
    ],
  )

  assert.deepEqual(collectTier1AlpacaSymbols(groups), [])
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
