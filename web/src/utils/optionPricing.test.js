import assert from 'node:assert/strict'
import test from 'node:test'

import { blackScholesPrice, impliedVolatility, normalCdf } from './optionPricing.js'

const terms = { spot: 100, strike: 110, years: 0.5, volatility: 0.5, rate: 0.02 }

function assertClose(actual, expected, tolerance = 1e-6) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} is not within ${tolerance} of ${expected}`)
}

test('Black-Scholes prices match a reference value and put-call parity', () => {
  assertClose(normalCdf(0), 0.5)
  assertClose(normalCdf(1.96), 0.975, 1e-4)
  // Hull's textbook example: S 42, K 40, r 10%, sigma 20%, T 0.5 gives call 4.76 and put 0.81.
  const hull = { spot: 42, strike: 40, years: 0.5, volatility: 0.2, rate: 0.1 }
  assertClose(blackScholesPrice({ ...hull, direction: 'call' }), 4.76, 0.005)
  assertClose(blackScholesPrice({ ...hull, direction: 'put' }), 0.81, 0.005)
  const call = blackScholesPrice({ ...terms, direction: 'call' })
  const put = blackScholesPrice({ ...terms, direction: 'put' })
  assertClose(call - put, 100 - 110 * Math.exp(-0.02 * 0.5), 1e-5)
})

test('degenerate inputs return the discounted payoff', () => {
  assert.equal(blackScholesPrice({ ...terms, spot: 0, direction: 'call' }), 0)
  assertClose(blackScholesPrice({ ...terms, spot: 0, direction: 'put' }), 110 * Math.exp(-0.01))
  assert.equal(blackScholesPrice({ ...terms, years: 0, direction: 'call' }), 0)
  assert.equal(blackScholesPrice({ ...terms, years: 0, spot: 120, direction: 'call' }), 10)
  assert.equal(blackScholesPrice({ ...terms, strike: null, direction: 'call' }), null)
})

test('implied volatility recovers the input and rejects quotes no accepted volatility explains', () => {
  for (const direction of ['call', 'put']) {
    const price = blackScholesPrice({ ...terms, direction })
    assertClose(impliedVolatility({ ...terms, price, direction }), 0.5, 1e-6)
  }
  // Below intrinsic value, and above the value at 300% volatility.
  assert.equal(impliedVolatility({ ...terms, spot: 200, price: 50, direction: 'call' }), null)
  assert.equal(impliedVolatility({ ...terms, price: 99, direction: 'call' }), null)
  assert.equal(impliedVolatility({ ...terms, price: 0, direction: 'call' }), null)
})
