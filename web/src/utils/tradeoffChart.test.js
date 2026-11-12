import assert from 'node:assert/strict'
import test from 'node:test'

import { fullView, inView, viewFromBox } from './tradeoffChart.js'

test('the full view fits every point on one shared range', () => {
  const view = fullView([{ x: 30, y: 40 }, { x: 680, y: 470 }, { x: 120, y: -60 }])
  assert.deepEqual(view, { x: [-60, 700], y: [-60, 700] })
  assert.deepEqual(fullView([]), { x: [0, 1], y: [0, 1] })
})

test('a dragged box becomes the view in either drag direction', () => {
  const current = { x: [0, 700], y: [0, 700] }
  const view = viewFromBox({ x: 400, y: 20 }, { x: 10, y: 380 }, current)
  assert.ok(view.x[0] < 10 && view.x[0] > -20 && view.x[1] > 400 && view.x[1] < 420, JSON.stringify(view))
  assert.ok(view.y[0] < 20 && view.y[1] > 380, JSON.stringify(view))
})

test('a box smaller than 2% of the view is ignored', () => {
  const current = { x: [0, 700], y: [0, 700] }
  assert.equal(viewFromBox({ x: 100, y: 100 }, { x: 105, y: 300 }, current), null)
})

test('only points inside the view are drawn', () => {
  const view = { x: [0, 400], y: [0, 400] }
  assert.equal(inView({ x: 120, y: 90 }, view), true)
  assert.equal(inView({ x: 680, y: 470 }, view), false)
})
