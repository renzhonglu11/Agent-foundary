import { Box, Stack, Typography } from '@mui/material'
import WarningAmberRoundedIcon from '@mui/icons-material/WarningAmberRounded'

import InstrumentList from './InstrumentList.jsx'
import { groupAttentionState, riskActionMeta } from './stockAnalysisUi.js'

export default function GroupDetailPanel({ group, riskGroup }) {
  const { dataIssueCount, expiryCount } = groupAttentionState(riskGroup)
  const action = riskActionMeta(riskGroup?.groupActionLabel)

  return (
    <Box sx={{ px: 2, py: 2, borderRadius: 2, border: '1px solid #e5eaef', backgroundColor: '#fbfdff' }}>
      <Stack spacing={1.5}>
        <Box sx={{ px: 1.5, py: 1.25, borderRadius: 1.5, backgroundColor: action.color === 'error' ? '#fff1ee' : action.color === 'warning' ? '#fff8e6' : '#f5f7fa' }}>
          <Typography variant="body2" fontWeight={800}>风险摘要</Typography>
          <Typography variant="body2" color="text.secondary" mt={0.25}>
            {riskSummary(riskGroup?.groupActionLabel, expiryCount, dataIssueCount)}
          </Typography>
        </Box>

        {dataIssueCount > 0 ? (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 1.25, py: 1, borderRadius: 1.5, border: '1px solid #ffe1a6', backgroundColor: '#fff8e6' }}>
            <WarningAmberRoundedIcon color="warning" fontSize="small" />
            <Typography variant="body2">数据不完整：{dataIssueCount} 个产品数据源不完整或过期</Typography>
          </Box>
        ) : null}

        {expiryCount > 0 ? (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 1.25, py: 1, borderRadius: 1.5, border: '1px solid #ffd7c2', backgroundColor: '#fff3ed' }}>
            <WarningAmberRoundedIcon color="warning" fontSize="small" />
            <Typography variant="body2">临近到期：{expiryCount} 个产品将在 90 天内到期，请评估平仓或展期</Typography>
          </Box>
        ) : null}

        <Stack spacing={1.25}>
          {group.stocks.length ? <InstrumentList title="股票 / ETF / Bond" rows={group.stocks} emptyText="这个 underlying 下没有普通持仓。" /> : null}
          {group.derivatives.length ? <InstrumentList title="金融衍生品" rows={group.derivatives} emptyText="这个标的下没有金融衍生品。" riskGroup={riskGroup} groupDeltaExposure={group.deltaExposure} /> : null}
        </Stack>
      </Stack>
    </Box>
  )
}

function riskSummary(action, expiryCount, dataIssueCount) {
  const reasons = []
  if (action === 'REDUCE_CONCENTRATION') reasons.push('当前标的在组合中的风险敞口过于集中，建议优先降低仓位')
  else if (action === 'REDUCE_DERIVATIVE_RISK') reasons.push('衍生品风险敞口偏高，建议降低杠杆或仓位')
  else if (action === 'CLOSE_OR_ROLL_DERIVATIVE') reasons.push('存在需要平仓或展期的合约')
  else if (action === 'HOLD_MONITOR') reasons.push('暂不需要立即调整，建议继续观察关键风险指标')
  else if (action === 'ADD_ALLOWED') reasons.push('当前风险水平可控')
  else reasons.push('暂时没有可用的风险建议')
  if (expiryCount > 0) reasons.push(`${expiryCount} 个产品将在 90 天内到期`)
  if (dataIssueCount > 0) reasons.push(`${dataIssueCount} 个产品的数据需要核查`)
  return `${reasons.join('；')}。`
}
