import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { calculatePositionStress } from './portfolioStress.js'

// Shared goldens are checked by Rust too: browser changes must not silently
// change the meaning of a frozen backend model version.
const cases = JSON.parse(readFileSync(new URL('../../../backend/tests/fixtures/monitor-risk-parity.json', import.meta.url)))
test('browser and background engine retain the same warrant, turbo and factor reference prices', () => {
  for (const fixture of cases) {
    for (const { scenario, expected } of fixture.results) {
      const actual = calculatePositionStress(fixture.entry, { id: 'test', ...scenario }, scenario.days)
      assert.equal(actual.projectedPrice, expected, `${fixture.id}: ${JSON.stringify(scenario)}`)
    }
  }
})
