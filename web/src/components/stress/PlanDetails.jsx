import { Alert, Box, Chip, MenuItem, Paper, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, TextField, Typography } from '@mui/material'
import { compactCurrency, number } from '../../utils/formatters.js'
import { confidenceLabel, productTypeLabel } from '../../utils/labels.js'
import { buildPortfolioAdjustments, buildScenarioContributions } from '../../utils/portfolioComparison.js'
import { PnlCell, pnlColor, signedMoney, signedPercent } from './shared.jsx'

const adjustmentLabels = { exit: '模拟退出', reduce: '减仓' }
const selectionFlagLabels = { MODEL_FALLBACK: '模型兜底估算' }

function ContributionList({ title, rows, empty }) {
  return (
    <Box sx={{ minWidth: 0 }}>
      <Typography variant="body2" fontWeight={700}>{title}</Typography>
      {rows.length === 0 ? <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>{empty}</Typography> : <>
        <Typography variant="caption" color="text.secondary">合计 {signedMoney(rows.reduce((sum, row) => sum + row.pnl, 0))} · 展示前 {Math.min(5, rows.length)} 个</Typography>
        <TableContainer><Table size="small" aria-label={title}><TableBody>{rows.slice(0, 5).map(row => (
          <TableRow key={row.id}>
            <TableCell>{row.name}<Typography variant="caption" component="div" color="text.secondary">{row.groupName}{row.movePct ? ` · 标的 ${signedPercent(row.movePct)}` : ''}</Typography></TableCell>
            <PnlCell value={row.pnl} />
          </TableRow>
        ))}</TableBody></Table></TableContainer>
      </>}
    </Box>
  )
}

export function PlanAdjustments({ baseline, plan }) {
  const adjustments = buildPortfolioAdjustments(baseline, plan)
  const changed = adjustments.filter(row => row.action !== 'retain')
  const count = action => adjustments.filter(row => row.action === action).length
  return (
    <Stack spacing={1}>
      <Typography variant="body2">
        {plan.description} 保留 {count('retain')} 个 · 减仓 {count('reduce')} 个 · 模拟退出 {count('exit')} 个；释放现金 {compactCurrency(plan.cashValue)}。
      </Typography>
      {changed.length ? (
        <TableContainer component={Paper} variant="outlined" sx={{ maxHeight: 320 }}>
          <Table size="small" stickyHeader aria-label="调整差异" sx={{ minWidth: 540, '& th': { whiteSpace: 'nowrap' } }}>
            <TableHead><TableRow><TableCell>产品 / 标的</TableCell><TableCell>变化</TableCell><TableCell align="right">当前 → 方案权重</TableCell><TableCell align="right">金额变化</TableCell></TableRow></TableHead>
            <TableBody>{changed.map(row => (
              <TableRow key={row.id}>
                <TableCell>{row.name}<Typography variant="caption" component="div" color="text.secondary">{row.groupName}</Typography></TableCell>
                <TableCell>{adjustmentLabels[row.action]}</TableCell>
                <TableCell align="right">{number.format(row.beforeWeight)}% → {number.format(row.afterWeight)}%</TableCell>
                <TableCell align="right">{signedMoney(row.changeValue)}</TableCell>
              </TableRow>
            ))}</TableBody>
          </Table>
        </TableContainer>
      ) : <Typography variant="body2" color="text.secondary">与当前持仓一致，没有调整。</Typography>}
      <Typography variant="caption" color="text.secondary">权重以可测本金为分母，包含假设现金。这是模型差异，不是交易指令。</Typography>
    </Stack>
  )
}

export function PressureSources({ plan, scenarioId, onScenario, horizonDays, otherShocks }) {
  const scenario = plan.scenarioResults.find(row => row.id === scenarioId)
    || plan.scenarioResults.reduce((worst, row) => !worst || row.pnl < worst.pnl ? row : worst, null)
  const contributions = buildScenarioContributions(plan, scenario?.id)
  const losses = contributions.filter(row => row.pnl < 0)
  const offsets = contributions.filter(row => row.pnl > 0).reverse()
  return (
    <Stack spacing={1.25}>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} sx={{ justifyContent: 'space-between', alignItems: { sm: 'center' } }}>
        <Typography variant="body2">
          情景盈亏 <Box component="span" sx={{ color: pnlColor(scenario?.pnl), fontWeight: 800 }}>{signedMoney(scenario?.pnl)}</Box> · 情景后保留市值 {compactCurrency(scenario?.projectedValue)} · 假设现金 {compactCurrency(plan.cashValue)}
        </Typography>
        <TextField select size="small" label="查看情景" value={scenario?.id || ''} onChange={event => onScenario(event.target.value)} sx={{ minWidth: 190 }}>
          {plan.scenarioResults.map(row => <MenuItem key={row.id} value={row.id}>{row.label}</MenuItem>)}
        </TextField>
      </Stack>
      {plan.shockProductCount === 0 ? (
        <Alert severity="info">
          没有所选标的的直接敞口；模型未模拟其他标的的相关性传导。
          {horizonDays === 0 ? (otherShocks ? '即时盈亏只来自所选的 IV 与汇率冲击。' : '即时盈亏不变，组合市值并未归零。') : '当前期限仍计入时间损耗或到期支付影响。'}
        </Alert>
      ) : null}
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, gap: 2 }}>
        <ContributionList title="主要亏损来源" rows={losses} empty="该情景没有亏损产品" />
        <ContributionList title="收益抵消来源" rows={offsets} empty="该情景没有盈利产品" />
      </Box>
      <Typography variant="body2" fontWeight={700}>全部情景</Typography>
      <TableContainer component={Paper} variant="outlined">
        <Table size="small" aria-label="全部情景结果" sx={{ minWidth: 540 }}>
          <TableHead><TableRow><TableCell>情景</TableCell><TableCell align="right">保留市值</TableCell><TableCell align="right">盈亏变化</TableCell><TableCell align="right">可测本金回报</TableCell><TableCell align="right">障碍触发</TableCell></TableRow></TableHead>
          <TableBody>{plan.scenarioResults.map(row => (
            <TableRow key={row.id} selected={row.id === scenario?.id}>
              <TableCell>{row.label}</TableCell><TableCell align="right">{compactCurrency(row.projectedValue)}</TableCell><PnlCell value={row.pnl} /><TableCell align="right">{signedPercent(row.testedCapitalReturnPct)}</TableCell><TableCell align="right">{row.barrierBreaches || '—'}</TableCell>
            </TableRow>
          ))}</TableBody>
        </Table>
      </TableContainer>
    </Stack>
  )
}

export function PlanMembers({ plan }) {
  return (
    <Stack spacing={1}>
      <Typography variant="caption" color="text.secondary">
        {plan.kind === 'baseline' ? '当前持仓沿用实际数量。' : '方案沿用当前持仓并按所列比例减仓，已退出的产品不再列出；只用于情景建模。'}
        权重以可测本金为分母；组合内与持仓市值口径的权重见提示。
      </Typography>
      <TableContainer component={Paper} variant="outlined" sx={{ maxHeight: 360 }}>
        <Table size="small" stickyHeader aria-label="组合产品与权重" sx={{ minWidth: 560 }}>
          <TableHead><TableRow><TableCell>产品</TableCell><TableCell>标的</TableCell><TableCell>置信度 / 模型</TableCell><TableCell align="right">本金权重</TableCell></TableRow></TableHead>
          <TableBody>{plan.products.map(product => (
            <TableRow key={product.id}>
              <TableCell sx={{ maxWidth: 240 }}>
                <Typography variant="body2" fontWeight={700} noWrap>{product.name}</Typography>
                <Typography variant="caption" color="text.secondary">{productTypeLabel(product.productType)}</Typography>
              </TableCell>
              <TableCell><Typography variant="body2" noWrap>{product.groupName}</Typography></TableCell>
              <TableCell>
                <Stack direction="row" spacing={0.5} useFlexGap sx={{ flexWrap: 'wrap' }}>
                  <Chip size="small" variant="outlined" label={confidenceLabel(product.confidence)} sx={{ height: 19 }} />
                  {(product.selectionFlags || []).map(flag => <Chip key={flag} size="small" color="warning" variant="outlined" label={selectionFlagLabels[flag] || flag} sx={{ height: 19 }} />)}
                </Stack>
              </TableCell>
              <TableCell align="right" title={`组合内 ${number.format(product.allocationPct)}% · 持仓市值 ${number.format(product.navWeightPct)}%`}>
                <Typography variant="body2">{number.format(product.capitalWeightPct)}%</Typography>
                {product.positionScalePct !== 100 ? <Typography variant="caption" color="warning.main">按原仓位的 {number.format(product.positionScalePct)}%</Typography> : null}
              </TableCell>
            </TableRow>
          ))}</TableBody>
        </Table>
      </TableContainer>
    </Stack>
  )
}
