import { Box, Paper, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Typography } from '@mui/material'
import { compactCurrency, number } from '../../utils/formatters.js'
import { summarizePlan } from '../../utils/portfolioComparison.js'
import { DEFINITIONS, Label, PnlCell, pnlColor, signedMoney } from './shared.jsx'

function Tile({ label, tip, value, color }) {
  return (
    <Box sx={{ border: '1px solid #e5eaef', borderRadius: 2, px: 1.5, py: 1, backgroundColor: '#ffffff', minWidth: 0 }}>
      <Typography variant="caption" color="text.secondary" component="div" noWrap><Label tip={tip}>{label}</Label></Typography>
      <Typography sx={{ fontSize: 20, fontWeight: 800, fontVariantNumeric: 'tabular-nums', color: color || 'text.primary' }}>{value}</Typography>
    </Box>
  )
}

// The selected plan's four numbers against the current holdings.
export function PlanSummaryTiles({ baseline, plan }) {
  const isBaseline = !plan || plan.kind === 'baseline'
  const summary = isBaseline ? null : summarizePlan(baseline, plan)
  const upScenario = (baseline?.scenarioResults || [])
    .filter(scenario => !scenario.pathMoves?.length && !scenario.adverse)
    .reduce((selected, scenario) => !selected || scenario.movePct > selected.movePct ? scenario : selected, null)
  return (
    <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'repeat(2, minmax(0, 1fr))', md: 'repeat(4, minmax(0, 1fr))' }, gap: 1 }}>
      {isBaseline ? <>
        <Tile label="最差情景盈亏" tip={DEFINITIONS.worstPnl} value={signedMoney(baseline?.worstPnl)} color={pnlColor(baseline?.worstPnl)} />
        <Tile label={`最大上涨情景盈亏${upScenario ? `（${upScenario.label}）` : ''}`} value={signedMoney(upScenario?.pnl)} color={pnlColor(upScenario?.pnl)} />
        <Tile label="保护效率" tip={DEFINITIONS.efficiency} value="—" />
        <Tile label="释放现金" tip={DEFINITIONS.cash} value={compactCurrency(0)} />
      </> : <>
        <Tile label="最差情景改善" tip={DEFINITIONS.worstImprovement} value={signedMoney(summary?.worstImprovement)} color={pnlColor(summary?.worstImprovement)} />
        <Tile label="放弃的上涨" tip={DEFINITIONS.upsideGivenUp} value={summary?.upsideGivenUp == null ? '—' : signedMoney(-summary.upsideGivenUp)} color={summary?.upsideGivenUp > 0 ? 'error.main' : undefined} />
        <Tile label="保护效率" tip={DEFINITIONS.efficiency} value={summary?.free ? '无上涨代价' : summary?.efficiency == null ? '—' : number.format(summary.efficiency)} color={summary?.efficiency >= 1 || summary?.free ? 'success.main' : undefined} />
        <Tile label="释放现金" tip={DEFINITIONS.cash} value={compactCurrency(summary?.cashValue ?? 0)} />
      </>}
    </Box>
  )
}

export function PlanComparisonTable({ portfolios, baseline, selectedId, onSelect, instantWithoutMoves }) {
  return (
    <TableContainer component={Paper} variant="outlined" sx={{ minWidth: 0 }}>
      <Table size="small" aria-label="方案对比" sx={{ '& th': { whiteSpace: 'nowrap' }, '& tr.Mui-selected td:first-of-type': { boxShadow: 'inset 3px 0 0 #1976d2' } }}>
        <TableHead><TableRow>
          <TableCell>方案</TableCell>
          <TableCell align="right"><Label tip={DEFINITIONS.cash}>释放现金</Label></TableCell>
          <TableCell align="right"><Label tip={DEFINITIONS.worstPnl}>最差情景盈亏</Label></TableCell>
          <TableCell align="right"><Label tip={DEFINITIONS.worstImprovement}>最差改善</Label></TableCell>
          <TableCell align="right"><Label tip={DEFINITIONS.upsideGivenUp}>放弃上涨</Label></TableCell>
        </TableRow></TableHead>
        <TableBody>{portfolios.map(portfolio => {
          const isBaseline = portfolio.kind === 'baseline'
          const summary = isBaseline ? null : summarizePlan(baseline, portfolio)
          const noExposure = portfolio.shockProductCount === 0 && instantWithoutMoves
          const selected = portfolio.id === selectedId
          return (
            <TableRow key={portfolio.id} hover selected={selected} onClick={() => onSelect(portfolio.id)} sx={{ cursor: 'pointer' }}>
              <TableCell sx={{ maxWidth: 260 }}>
                <Typography
                  component="button"
                  type="button"
                  aria-pressed={selected}
                  onClick={event => { event.stopPropagation(); onSelect(portfolio.id) }}
                  variant="body2"
                  sx={{ all: 'unset', cursor: 'pointer', fontWeight: 800, color: 'primary.main', '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main' } }}
                >
                  {isBaseline ? '当前持仓' : portfolio.title}
                </Typography>
                <Typography variant="caption" component="div" color="text.secondary">
                  {portfolio.productCount} 产品 · {portfolio.groupCount} 标的{portfolio.shockProductCount === 0 ? ' · 无直接敞口' : ''}
                </Typography>
              </TableCell>
              <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>{isBaseline ? '—' : compactCurrency(portfolio.cashValue)}</TableCell>
              {noExposure ? <TableCell align="right" sx={{ color: 'text.secondary' }}>不变</TableCell> : <PnlCell value={portfolio.worstPnl} />}
              {isBaseline ? <TableCell align="right" sx={{ color: 'text.secondary' }}>起点</TableCell> : <PnlCell value={summary?.worstImprovement} />}
              {isBaseline ? <TableCell align="right" sx={{ color: 'text.secondary' }}>—</TableCell> : <PnlCell value={summary?.upsideGivenUp == null ? null : -summary.upsideGivenUp} />}
            </TableRow>
          )
        })}</TableBody>
      </Table>
    </TableContainer>
  )
}
