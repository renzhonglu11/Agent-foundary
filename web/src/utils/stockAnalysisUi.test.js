import assert from 'node:assert/strict'
import test from 'node:test'

import { groupAttentionState, matchesAttentionFilter, riskActionMeta } from '../components/stock-analysis/stockAnalysisUi.js'

test('group attention state combines action, expiry and data signals', () => {
  const group = {
    groupActionLabel: 'REDUCE_CONCENTRATION',
    legs: [
      { daysToExpiry: 70, exposureConfidence: 'live', dataCompletenessRiskScore: 0 },
      { daysToExpiry: 120, exposureConfidence: 'no_data', dataCompletenessRiskScore: 4 },
    ],
  }

  assert.deepEqual(groupAttentionState(group), {
    needsAction: true,
    expiryCount: 1,
    dataIssueCount: 1,
  })
  assert.equal(matchesAttentionFilter(group, 'action'), true)
  assert.equal(matchesAttentionFilter(group, 'expiry'), true)
  assert.equal(matchesAttentionFilter(group, 'data'), true)
})

test('allowed groups are excluded from the action queue', () => {
  const group = { groupActionLabel: 'ADD_ALLOWED', legs: [] }
  assert.equal(matchesAttentionFilter(group, 'action'), false)
  assert.equal(matchesAttentionFilter(group, 'all'), true)
  assert.deepEqual(riskActionMeta('ADD_ALLOWED'), { label: '可继续持有', color: 'success' })
})
