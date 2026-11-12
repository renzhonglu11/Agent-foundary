import { useState } from 'react'
import { Box, Button, Chip, FormControlLabel, MenuItem, Paper, Stack, Switch, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, TextField, Typography } from '@mui/material'
import { compactCurrency, number } from '../../utils/formatters.js'
import { EXIT_LEVEL_META } from '../../utils/labels.js'
import { rowReduction, summarizePlan } from '../../utils/portfolioComparison.js'
import { REDUCTION_STEPS } from '../../utils/positionWhatIf.js'
import { DEFINITIONS, Label, PnlCell, reductionLabel, signedMoney, signedPercent } from './shared.jsx'

const kindNotes = { free: '无上涨代价', hedge: '对冲仓位', neutral: '对最差情景无影响' }

// One row per product or underlying: the effect of reducing only that row.
// Each row picks its own amount for the custom plan.
export function ReductionRankingTable({ rows, reductions, onRowReduction, settings, onSettings, exitLevelOf, flatMonthOf, shock, onClear }) {
  const [moreColumns, setMoreColumns] = useState(false)
  const customCount = Object.values(reductions).filter(pct => pct > 0).length
  return (
    <Stack spacing={1}>
      <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
        <TextField select size="small" label="范围" value={settings.scope} onChange={event => onSettings({ scope: event.target.value })} sx={{ minWidth: 110 }}>
          <MenuItem value="product">按产品</MenuItem>
          <MenuItem value="group">按标的</MenuItem>
        </TextField>
        <TextField select size="small" label="按此幅度计算" value={settings.reduction} onChange={event => onSettings({ reduction: Number(event.target.value) })} sx={{ minWidth: 130 }}>
          {REDUCTION_STEPS.map(pct => <MenuItem key={pct} value={pct}>{reductionLabel(pct)}</MenuItem>)}
        </TextField>
        <TextField select size="small" label="排序" value={settings.sort} onChange={event => onSettings({ sort: event.target.value })} sx={{ minWidth: 150 }}>
          <MenuItem value="efficiency">保护效率</MenuItem>
          <MenuItem value="improvement">最差情景改善金额</MenuItem>
          <MenuItem value="riskDensity">风险密度</MenuItem>
        </TextField>
        <FormControlLabel control={<Switch size="small" checked={moreColumns} onChange={event => setMoreColumns(event.target.checked)} />} label="更多列" />
        <Button size="small" disabled={customCount === 0} onClick={onClear} sx={{ ml: 'auto' }}>清空自定义方案</Button>
      </Stack>
      <TableContainer component={Paper} variant="outlined" sx={{ maxHeight: 440 }}>
        <Table size="small" stickyHeader aria-label="减仓排序" sx={{ minWidth: moreColumns ? 980 : 720, '& th': { whiteSpace: 'nowrap' } }}>
          <TableHead><TableRow>
            <TableCell>{settings.scope === 'group' ? '标的' : '产品 / 标的'}</TableCell>
            <TableCell align="right">市值 / 占比</TableCell>
            <TableCell align="right"><Label tip={DEFINITIONS.worstImprovement}>最差改善</Label></TableCell>
            {moreColumns ? <TableCell align="right"><Label tip={DEFINITIONS.upsideGivenUp}>放弃上涨 {shock}%</Label></TableCell> : null}
            <TableCell align="right"><Label tip={DEFINITIONS.efficiency}>保护效率</Label></TableCell>
            {moreColumns ? <TableCell align="right"><Label tip={DEFINITIONS.cash}>释放现金</Label></TableCell> : null}
            {moreColumns ? <TableCell align="right"><Label tip={DEFINITIONS.riskDensity}>风险密度</Label></TableCell> : null}
            <TableCell align="right"><Label tip={DEFINITIONS.flatMonth}>横盘 30 天</Label></TableCell>
            <TableCell align="right">自定义方案</TableCell>
          </TableRow></TableHead>
          <TableBody>{rows.map(row => {
            const level = exitLevelOf(row)
            const flagged = level === 'urgent' || level === 'warn'
            const current = rowReduction(reductions, row.productIds)
            const flatMonth = flatMonthOf(row)
            return (
              <TableRow key={row.id} hover selected={current !== 0}>
                <TableCell sx={{ maxWidth: 260 }}>
                  <Typography variant="body2" fontWeight={700} noWrap title={row.name}>{row.name}</Typography>
                  <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
                    <Typography variant="caption" color="text.secondary" noWrap>{settings.scope === 'group' ? `${row.productCount} 个产品` : row.groupName}</Typography>
                    {flagged ? <Chip size="small" color={EXIT_LEVEL_META[level].color} label={`退场信号：${EXIT_LEVEL_META[level].label}`} sx={{ height: 18 }} /> : null}
                  </Stack>
                </TableCell>
                <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>{compactCurrency(row.currentValue)}<Typography variant="caption" component="div" color="text.secondary">{number.format(row.weightPct)}%</Typography></TableCell>
                <PnlCell value={row.worstImprovement} />
                {moreColumns ? <PnlCell value={-row.upGivenUp} /> : null}
                <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>
                  {row.kind === 'tradeoff'
                    ? <Typography variant="body2" fontWeight={700} color={row.efficiency >= 1 ? 'success.main' : 'text.primary'}>{number.format(row.efficiency)}</Typography>
                    : <Typography variant="caption" color="text.secondary">{kindNotes[row.kind]}</Typography>}
                </TableCell>
                {moreColumns ? <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>{compactCurrency(row.releasedValue)}</TableCell> : null}
                {moreColumns ? <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>{number.format(row.worstLossPct)}%</TableCell> : null}
                <TableCell align="right" sx={{ whiteSpace: 'nowrap', color: flatMonth != null && flatMonth <= -15 ? 'error.main' : undefined }}>
                  {flatMonth == null ? '—' : signedPercent(Math.round(flatMonth * 10) / 10)}
                </TableCell>
                <TableCell align="right">
                  <TextField
                    select
                    size="small"
                    value={current ?? 'mixed'}
                    onChange={event => onRowReduction(row, Number(event.target.value))}
                    slotProps={{ htmlInput: { 'aria-label': `${row.name} 在自定义方案中的幅度` } }}
                    sx={{ minWidth: 104, '& .MuiSelect-select': { py: 0.5 } }}
                  >
                    {current == null ? <MenuItem value="mixed" disabled>部分产品</MenuItem> : null}
                    <MenuItem value={0}>不减</MenuItem>
                    {REDUCTION_STEPS.map(pct => <MenuItem key={pct} value={pct}>{reductionLabel(pct)}</MenuItem>)}
                  </TextField>
                </TableCell>
              </TableRow>
            )
          })}</TableBody>
        </Table>
      </TableContainer>
      <Typography variant="caption" color="text.secondary">
        每行只动这一项、其余不变，指标按“{reductionLabel(settings.reduction)}”计算。价外权证上涨弹性大，效率通常低于 1，它们的代价是时间损耗，见“横盘 30 天”。
      </Typography>
    </Stack>
  )
}

// Always visible while the custom plan has positions, wherever the reader is
// in the panel.
export function CustomPlanTray({ baseline, plan, count, selected, onSelect, onClear }) {
  if (!count || !plan) return null
  const summary = summarizePlan(baseline, plan)
  return (
    // Right margin keeps the bar clear of the page's floating import button.
    <Box sx={{ position: 'sticky', bottom: 8, zIndex: 3, mr: 9 }}>
      <Stack direction="row" spacing={1.5} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center', px: 1.5, py: 1, borderRadius: 2, backgroundColor: '#1e293b', color: '#f8fafc', boxShadow: '0 6px 18px rgba(15, 23, 42, 0.25)' }}>
        <Typography variant="body2" fontWeight={800}>自定义方案 · {count} 只</Typography>
        <Typography variant="body2">释放 {compactCurrency(summary?.cashValue ?? 0)}</Typography>
        <Typography variant="body2">最差 {signedMoney(summary?.worstImprovement)}</Typography>
        <Typography variant="body2">放弃上涨 {summary?.upsideGivenUp == null ? '—' : signedMoney(-summary.upsideGivenUp)}</Typography>
        <Typography variant="body2">效率 {summary?.free ? '无代价' : summary?.efficiency == null ? '—' : number.format(summary.efficiency)}</Typography>
        <Stack direction="row" spacing={1} sx={{ ml: 'auto' }}>
          {!selected ? <Button size="small" variant="contained" color="inherit" onClick={onSelect} sx={{ color: '#1e293b' }}>查看</Button> : null}
          <Button size="small" color="inherit" variant="outlined" onClick={onClear}>清空</Button>
        </Stack>
      </Stack>
    </Box>
  )
}
