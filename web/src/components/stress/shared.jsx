import { Accordion, AccordionDetails, AccordionSummary, Box, TableCell, Tooltip, Typography } from '@mui/material'
import ExpandMoreRoundedIcon from '@mui/icons-material/ExpandMoreRounded'
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined'
import { compactCurrency, number } from '../../utils/formatters.js'

export const reductionLabel = pct => (pct >= 100 ? '退出' : `减 ${pct}%`)

export function signedPercent(value) {
  const numeric = Number(value) || 0
  return `${numeric > 0 ? '+' : ''}${number.format(numeric)}%`
}

export function signedMoney(value) {
  if (value == null) return '—'
  return `${value > 0 ? '+' : ''}${compactCurrency(value)}`
}

export function pnlColor(value) {
  if (value > 0) return 'success.main'
  if (value < 0) return 'error.main'
  return 'text.secondary'
}

export function PnlCell({ value }) {
  return <TableCell align="right" sx={{ color: pnlColor(value), whiteSpace: 'nowrap' }}>{signedMoney(value)}</TableCell>
}

// Definitions shown on hover or focus, so headers can stay short.
export const DEFINITIONS = {
  worstImprovement: '方案的最差情景盈亏减去当前持仓的最差情景盈亏。两者的最差情景可能不是同一个。',
  upsideGivenUp: '在最大上涨情景中，方案比当前持仓少赚的金额。',
  efficiency: '最差情景改善 ÷ 放弃的上涨。等于 1 表示少亏和少赚一样多；只反映所选情景，不含概率。在同步下跌中盈利的仓位是对冲仓位，不参与排序。',
  cash: '方案卖出的市值，按零收益现金处理，不计手续费、买卖价差和税。',
  riskDensity: '每卖出 1 欧元能减少多少最差情景亏损：最差情景改善 ÷ 释放现金。',
  flatMonth: '标的 30 天不动时，这些产品按市值加权的模型回报，来自退场信号。低于 −15% 标红。',
  worstPnl: '该方案在所有情景中最低的盈亏，包括“各标的逆向”。',
}

export function InfoTip({ title }) {
  return (
    <Tooltip title={title} arrow enterTouchDelay={0}>
      <Box component="span" tabIndex={0} aria-label={title} sx={{ display: 'inline-flex', verticalAlign: 'middle', ml: 0.25, color: 'text.disabled', cursor: 'help', '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', borderRadius: '50%' } }}>
        <InfoOutlinedIcon sx={{ fontSize: 15 }} />
      </Box>
    </Tooltip>
  )
}

export function Label({ children, tip }) {
  return <>{children}{tip ? <InfoTip title={tip} /> : null}</>
}

// A collapsed block whose content mounts only when opened.
export function Section({ id, title, summary, defaultExpanded = false, children }) {
  return (
    <Accordion id={id} defaultExpanded={defaultExpanded} disableGutters variant="outlined" slotProps={{ transition: { unmountOnExit: true } }} sx={{ borderRadius: 2, '&:before': { display: 'none' }, overflow: 'hidden' }}>
      <AccordionSummary expandIcon={<ExpandMoreRoundedIcon />} sx={{ minHeight: 48 }}>
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="body2" fontWeight={800}>{title}</Typography>
          {summary ? <Typography variant="caption" color="text.secondary" component="div">{summary}</Typography> : null}
        </Box>
      </AccordionSummary>
      <AccordionDetails sx={{ pt: 0 }}>{children}</AccordionDetails>
    </Accordion>
  )
}
