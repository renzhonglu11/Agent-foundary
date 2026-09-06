import assert from 'node:assert/strict'
import test from 'node:test'

import { fetchPortfolioData } from './usePortfolioData.js'

test('portfolio fetch bypasses browser cache and returns the latest summary', async () => {
  const originalFetch = globalThis.fetch
  let request
  globalThis.fetch = async (...args) => {
    request = args
    return {
      ok: true,
      json: async () => ({ generatedAt: '2026-08-25T12:00:00Z' }),
    }
  }

  try {
    const result = await fetchPortfolioData()

    assert.deepEqual(request, [
      '/data/portfolio-summary.json',
      { cache: 'no-store' },
    ])
    assert.equal(result.generatedAt, '2026-08-25T12:00:00Z')
  } finally {
    globalThis.fetch = originalFetch
  }
})
