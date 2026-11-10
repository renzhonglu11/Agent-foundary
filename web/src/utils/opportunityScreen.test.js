import assert from 'node:assert/strict'
import test from 'node:test'

import { buildOpportunityScreen } from './opportunityScreen.js'

const group = (key, overrides = {}) => ({
  key,
  groupName: key.toUpperCase(),
  alpacaSymbol: key.toUpperCase(),
  marketValue: 500,
  derivatives: [{ symbol: `${key}-1` }],
  stocks: [],
  ...overrides,
})
const stats = (symbol, overrides = {}) => ({
  symbol, asOf: '2026-11-09', lastClose: 100, sma20: 98, sma50: 95, sma200: 90, high52w: 110,
  return5dPct: 1, return20dPct: 4, return60dPct: 10, realizedVol20d: 0.4, realizedVol60d: 0.5, realizedVol20dPercentile: 50,
  ...overrides,
})
const tags = row => row.tags.map(tag => tag.code)
const screen = (groups, dailyStats, extra = {}) => buildOpportunityScreen({ groups, dailyStats, totalMarketValue: 10_000, ...extra })

test('trend, pullback and distance from the high are read from daily closes', () => {
  const rows = screen(
    ['up', 'dip', 'down', 'high', 'new'].map(key => group(key)),
    [
      stats('UP'),
      // Still above the 200-day average, but below the 20-day one after a 5% week.
      stats('DIP', { lastClose: 96, sma20: 99, return5dPct: -5 }),
      stats('DOWN', { lastClose: 60, sma20: 65, sma50: 70, sma200: 90, return60dPct: -30 }),
      stats('HIGH', { lastClose: 108 }),
      stats('NEW', { sma200: null }),
    ],
  )
  const row = key => rows.find(candidate => candidate.key === key)
  assert.deepEqual([row('up').trend, tags(row('up'))], ['up', ['uptrend']])
  assert.deepEqual([row('up').vsSma50Pct, row('up').vsSma200Pct, row('up').fromHighPct], [5.26, 11.11, -9.09])
  assert.deepEqual(tags(row('dip')), ['pullback'])
  // The same week after a 20% break below the 50-day average is not a pullback.
  const broken = screen([group('dip')], [stats('DIP', { lastClose: 96, sma20: 110, sma50: 120, return5dPct: -5 })])[0]
  assert.deepEqual(tags(broken), [])
  assert.deepEqual([row('down').trend, tags(row('down'))], ['down', ['downtrend', 'deep_drawdown']])
  assert.deepEqual(tags(row('high')), ['uptrend', 'near_high'])
  assert.deepEqual([row('new').trend, tags(row('new'))], ['unknown', []])
  // Most conditions in favour first, the downtrend last.
  assert.equal(rows.at(-1).key, 'down')
  assert.deepEqual([row('down').positiveCount, row('down').cautionCount], [0, 2])
})

test('volatility tags compare the realized range, implied against realized, and the recorded IV rank', () => {
  const rows = screen(
    [group('calm'), group('rich'), group('plain')],
    [stats('CALM', { realizedVol20dPercentile: 10 }), stats('RICH', { realizedVol20dPercentile: 90 }), stats('PLAIN')],
    {
      impliedByGroup: new Map([['calm', 0.4], ['rich', 0.7]]),
      ivHistoryByIsin: new Map([
        ['calm-1', { observations: 40, percentile: 15 }],
        ['rich-1', { observations: 5, percentile: null }],
      ]),
    },
  )
  const row = key => rows.find(candidate => candidate.key === key)
  // 40% implied against 50% realized is 0.8x.
  assert.deepEqual([row('calm').ivToRealized, row('calm').ivPercentile, row('calm').ivObservations], [0.8, 15, 40])
  assert.deepEqual(tags(row('calm')), ['uptrend', 'vol_low', 'iv_cheap', 'iv_low'])
  assert.deepEqual([row('rich').ivToRealized, row('rich').ivPercentile, row('rich').ivObservations], [1.4, null, 5])
  assert.deepEqual(tags(row('rich')), ['uptrend', 'vol_high', 'iv_rich'])
  assert.deepEqual([row('plain').impliedVolatilityPct, row('plain').ivToRealized], [null, null])
  assert.equal(rows[0].key, 'calm')
})

test('existing exposure and exit signals are shown beside the conditions', () => {
  const rows = screen(
    [
      group('heavy', { marketValue: 1500, derivatives: [{ symbol: 'h-1' }, { symbol: 'h-2' }], stocks: [{ symbol: 'h-stock' }] }),
      group('light', { marketValue: 50 }),
      group('unmapped', { alpacaSymbol: null }),
      group('nodata'),
    ],
    [stats('HEAVY'), stats('LIGHT')],
    { exitSignals: [{ id: 'h-1', level: 'warn' }, { id: 'h-2', level: 'urgent' }] },
  )
  // Underlyings without a symbol or without history are left out rather than shown empty.
  assert.deepEqual(rows.map(row => row.key).sort(), ['heavy', 'light'])
  const row = key => rows.find(candidate => candidate.key === key)
  assert.deepEqual([row('heavy').weightPct, row('heavy').productCount, row('heavy').exitLevel], [15, 3, 'urgent'])
  assert.deepEqual(tags(row('heavy')), ['uptrend', 'concentrated'])
  assert.deepEqual([row('light').weightPct, row('light').exitLevel, tags(row('light'))], [0.5, null, ['uptrend', 'light']])
  assert.deepEqual(buildOpportunityScreen(), [])
})
