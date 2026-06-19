import assert from 'node:assert/strict'
import test from 'node:test'

import { calculateDrawdown, calculateExpiryPnl, calculateTimeDecay } from './productCalculations.js'

test('drawdown uses Bezugsverhaeltnis as multiplier for delta impact', () => {
  const result = calculateDrawdown({
    price: 91.66,
    underlyingSpot: 988.08,
    delta: 1,
    ratio: 0.1,
    quantity: 82,
    optionType: 'call',
    costBasis: 91.66 * 82,
  }, -1)

  assert.equal(Math.round(result.priceChange * 10) / 10, -1.0)
  assert.equal(Math.round(result.newPrice * 10) / 10, 90.7)
  assert.equal(Math.round(result.pnl * 10) / 10, -81.0)
})

test('drawdown pnl is bounded when estimated price would fall below zero', () => {
  const result = calculateDrawdown({
    price: 2,
    underlyingSpot: 100,
    delta: 1,
    ratio: 1,
    quantity: 10,
    optionType: 'call',
    costBasis: 20,
  }, -10)

  assert.equal(result.newPrice, 0)
  assert.equal(result.priceChange, -2)
  assert.equal(result.pnl, -20)
  assert.equal(result.pnlPct, -100)
})

test('drawdown pnl percentage is relative to current market value', () => {
  const result = calculateDrawdown({
    price: 10,
    underlyingSpot: 100,
    delta: 1,
    ratio: 0.1,
    quantity: 5,
    avgCost: 2,
    optionType: 'call',
  }, -10)

  assert.equal(result.priceChange, -1)
  assert.equal(result.pnl, -5)
  assert.equal(result.pnlPct, -10)
})

test('expiry intrinsic value uses Bezugsverhaeltnis as multiplier', () => {
  const result = calculateExpiryPnl({
    strikePrice: 100,
    ratio: 0.1,
    quantity: 10,
    avgCost: 2,
    optionType: 'call',
  }, 130)

  assert.equal(result.intrinsic, 3)
  assert.equal(result.pnl, 10)
  assert.equal(result.pnlPct, 50)
})

test('expiry intrinsic value converts underlying payoff currency to product currency', () => {
  const result = calculateExpiryPnl({
    strikePrice: 104,
    ratio: 0.1,
    quantity: 82,
    avgCost: 1.9,
    optionType: 'call',
  }, 1132.4, { payoutFxRate: 0.8725 })

  assert.equal(Math.round(result.intrinsicUnderlying * 10) / 10, 102.8)
  assert.equal(Math.round(result.intrinsic * 10) / 10, 89.7)
  assert.equal(Math.round(result.pnl * 10) / 10, 7201.9)
})

test('time decay intrinsic estimate uses ratio multiplier and bounded pnl change', () => {
  const result = calculateTimeDecay({
    price: 4,
    underlyingSpot: 130,
    strikePrice: 100,
    ratio: 0.1,
    quantity: 10,
    optionType: 'call',
    daysToExpiry: 10,
  }, 5)

  assert.equal(result.method, 'linear')
  assert.equal(result.priceChange, -0.5)
  assert.equal(result.pnlChange, -5)

  const bounded = calculateTimeDecay({
    price: 2,
    theta: -0.1,
    quantity: 10,
    daysToExpiry: 100,
  }, 50)

  assert.equal(bounded.newPrice, 0)
  assert.equal(bounded.priceChange, -2)
  assert.equal(bounded.pnlChange, -20)
})
