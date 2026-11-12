import { Alert, Box, Chip, MenuItem, Paper, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, TextField, Typography } from '@mui/material'
import { compactCurrency, number } from '../../utils/formatters.js'
import { confidenceLabel, productTypeLabel } from '../../utils/labels.js'
import { buildPortfolioAdjustments, buildScenarioContributions } from '../../utils/portfolioComparison.js'
import { PnlCell, pnlColor, signedMoney, signedPercent } from './shared.jsx'

const adjustmentLabels = { exit: '模拟退出', reduce: '减仓' }
const selectionFlagLabels = { MODEL_FALLBACK: '模型兜底估算' }

const SHOWN_PER_SIDE = 5

// Losses grow left from the centre line and offsets grow right, on one scale,
// so the largest drivers of the scenario stand out at a glance.
function DivergingContributions({ contributions }) {
  const losses = contributions.filter(row => row.pnl < 0)
  const offsets = contributions.filter(row => row.pnl > 0)
  const shown = [...losses.slice(0, SHOWN_PER_SIDE), ...offsets.slice(-SHOWN_PER_SIDE)]
  const hidden = contributions.filter(row => row.pnl && !shown.includes(row))
  const hiddenTotal = hidden.reduce((sum, row) => sum + row.pnl, 0)
  const scale = Math.max(...shown.map(row => Math.abs(row.pnl)), 1)
  const total = rows => rows.reduce((sum, row) => sum + row.pnl, 0)
  if (!shown.length) return <Typography variant="body2" color="text.secondary">该情景下各产品盈亏都为零或无法计算。</Typography>
  return (
    <Stack spacing={0.5}>
      <Typography variant="caption" color="text.secondary">
        亏损合计 {signedMoney(total(losses))}（{losses.length} 个）· 抵消合计 {signedMoney(total(offsets))}（{offsets.length} 个）
        {hidden.length ? ` · 未列出的 ${hidden.length} 个合计 ${signedMoney(hiddenTotal)}` : ''}
      </Typography>
      <Box role="list" aria-label="压力来源" sx={{ display: 'grid', gap: 0.5 }}>
        {shown.map(row => {
          const width = `${Math.abs(row.pnl) / scale * 50}%`
          const negative = row.pnl < 0
          return (
            <Box role="listitem" key={row.id} sx={{ display: 'grid', gridTemplateColumns: { xs: 'minmax(0, 1fr)', sm: 'minmax(0, 0.9fr) minmax(0, 1.4fr) 84px' }, gap: { xs: 0.25, sm: 1 }, alignItems: 'center' }}>
              <Box sx={{ minWidth: 0 }}>
                <Typography variant="body2" noWrap title={row.name}>{row.name}</Typography>
                <Typography variant="caption" color="text.secondary" component="div" noWrap>{row.groupName}{row.movePct ? ` · 标的 ${signedPercent(row.movePct)}` : ''}</Typography>
              </Box>
              <Box sx={{ position: 'relative', height: 14, backgroundColor: '#f1f5f9', borderRadius: 1 }}>
                <Box sx={{ position: 'absolute', left: '50%', top: -2, bottom: -2, width: '1px', backgroundColor: '#94a3b8' }} />
                <Box sx={{
                  position: 'absolute', top: 2, bottom: 2, width, borderRadius: 1,
                  backgroundColor: negative ? 'error.main' : 'success.main',
                  ...(negative ? { right: '50%' } : { left: '50%' }),
                }} />
              </Box>
              <Typography variant="body2" sx={{ color: pnlColor(row.pnl), textAlign: { sm: 'right' }, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{signedMoney(row.pnl)}</Typography>
            </Box>
          )
        })}
      </Box>
    </Stack>
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
  const contributions = buildScenarioContributions(plan, scenario?.id).filter(row => row.pnl != null)
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
      <DivergingContributions contributions={contributions} />
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
