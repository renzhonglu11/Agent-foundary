import assert from 'node:assert/strict'
import test from 'node:test'

import { displayPoint, tradeoffDomain } from './tradeoffChart.js'

const cluster = Array.from({ length: 20 }, (_, index) => ({ id: `p${index}`, x: 10 + index * 15, y: 12 + index * 14 }))
const outlier = { id: 'big', x: 680, y: 470 }

test('one far point does not set the range for everyone else', () => {
  const domain = tradeoffDomain([...cluster, outlier])
  assert.equal(domain.focused, true)
  assert.ok(domain.max < 680 && domain.max >= 280, `max ${domain.max}`)
  assert.deepEqual(domain.clipped, ['big'])
  assert.equal(domain.fullMax, 700)
  assert.equal(domain.min, 0)
})

test('show-all keeps every point inside and both axes share one range', () => {
  const domain = tradeoffDomain([...cluster, outlier], { focus: false })
  assert.equal(domain.focused, false)
  assert.equal(domain.max, 700)
  assert.deepEqual(domain.clipped, [])
  assert.equal(domain.canFocus, true)
})

test('an even spread is not focused, and negatives extend the minimum', () => {
  const even = [{ id: 'a', x: 100, y: 120 }, { id: 'b', x: 200, y: 180 }, { id: 'c', x: 300, y: 260 }, { id: 'h', x: 40, y: -60 }]
  const domain = tradeoffDomain(even)
  assert.equal(domain.focused, false)
  assert.equal(domain.canFocus, false)
  assert.equal(domain.min, -60)
  assert.ok(domain.max >= 300)
})

test('pinned points sit on the edge they leave by', () => {
  const domain = { max: 400 }
  const pinned = displayPoint({ x: 680, y: 470 }, domain)
  assert.equal(pinned.clipped, true)
  assert.ok(pinned.x < 400 && pinned.x > 380, 'just inside the edge')
  assert.ok(Math.abs(pinned.y / pinned.x - 470 / 680) < 1e-9, 'keeps the efficiency ratio')
  assert.deepEqual(displayPoint({ x: 120, y: 90 }, domain), { x: 120, y: 90, clipped: false })
  assert.equal(tradeoffDomain([]).max, 1)
})
