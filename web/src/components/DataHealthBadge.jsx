import { useEffect, useMemo, useState } from 'react'
import { Box, Button, Chip, Collapse, Dialog, DialogContent, DialogTitle, IconButton, Stack, Typography } from '@mui/material'
import CloseRoundedIcon from '@mui/icons-material/CloseRounded'
import { usePortfolioMonitorStatus } from '../hooks/usePortfolioMonitor.js'
import { buildDataHealth } from '../utils/dataHealth.js'
import { number } from '../utils/formatters.js'
import PortfolioDataMonitor from './PortfolioDataMonitor.jsx'

const chipColors = { error: 'error', warning: 'warning', ok: 'success', loading: 'default' }
export const DATA_HEALTH_PANEL_ID = 'positions-data-health'

export function useDataHealth() {
  const query = usePortfolioMonitorStatus()
  // Re-evaluated on a timer so a monitor that stops updating turns stale.
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 15_000)
    return () => window.clearInterval(timer)
  }, [])
  return useMemo(() => buildDataHealth(query.data, query.error, now), [query.data, query.error, now])
}

const percent = value => `${number.format(Math.round(value * 10) / 10)}%`

function chipLabel(health) {
  const coverage = health.coveragePct != null ? `模型覆盖 ${percent(health.coveragePct)}` : null
  if (health.level === 'loading') return '数据状态读取中'
  if (health.level === 'error') {
    if (health.monitor.color === 'error') return `数据：${health.monitor.label}`
    if (health.faultPositionCount > 0) return `${health.faultPositionCount} 个持仓数据异常`
    return health.faults[0]?.label || '数据异常'
  }
  if (health.level === 'warning') {
    if (health.monitor.color === 'warning') return `数据：${health.monitor.label}`
    return [coverage, `${health.gaps.length} 项待补齐`].filter(Boolean).join(' · ')
  }
  return ['数据正常', coverage].filter(Boolean).join(' · ')
}

export function DataHealthChip({ health, open, onToggle }) {
  return (
    <Chip
      size="small"
      variant="outlined"
      color={chipColors[health.level]}
      label={`${chipLabel(health)} ${open ? '▴' : '▾'}`}
      onClick={onToggle}
      aria-expanded={open}
      aria-controls={DATA_HEALTH_PANEL_ID}
      sx={{ fontWeight: 700 }}
    />
  )
}

function Section({ title, note, rows, empty, extra }) {
  return (
    <Box sx={{ border: '1px solid #e5eaef', borderRadius: 1.5, p: 1.25, backgroundColor: '#ffffff', minWidth: 0 }}>
      <Typography variant="body2" fontWeight={800}>{title}</Typography>
      <Typography variant="caption" color="text.secondary" component="div" sx={{ mb: 0.75 }}>{note}</Typography>
      {extra}
      {rows.length ? (
        <Box component="ul" sx={{ m: 0, pl: 2.25 }}>
          {rows.map(row => (
            <Typography component="li" variant="body2" key={row.code}>
              {row.label}{row.count != null ? <Box component="span" sx={{ color: 'text.secondary' }}> · {row.count} 个持仓</Box> : null}
            </Typography>
          ))}
        </Box>
      ) : !extra ? <Typography variant="body2" color="text.secondary">{empty}</Typography> : null}
    </Box>
  )
}

export function DataHealthPanel({ health, open }) {
  const [detailsOpen, setDetailsOpen] = useState(false)
  const monitorIssue = (health.monitor.color === 'error' || health.monitor.color === 'warning') && health.monitor.issue
  return (
    <>
      <Collapse in={open} unmountOnExit>
        <Box id={DATA_HEALTH_PANEL_ID} sx={{ px: { xs: 1.5, md: 2 }, py: 1.5, borderBottom: '1px solid #e5eaef', backgroundColor: '#f8fafc' }}>
          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: 'repeat(3, minmax(0, 1fr))' }, gap: 1.25 }}>
            <Section
              title="故障"
              note="会触发数据质量预警，需要排查。"
              rows={health.faults}
              empty="没有。"
              extra={monitorIssue ? <Typography variant="body2" color={health.monitor.color === 'error' ? 'error.main' : 'warning.main'} sx={{ mb: 0.5 }}>{health.monitor.label}：{health.monitor.issue}</Typography> : null}
            />
            <Section
              title="可信度限制"
              note="不报警。数值仍会使用，只是无法严格核对行情是否同步。"
              rows={health.limitations}
              empty="没有。"
            />
            <Section
              title="待补齐"
              note="不报警，但可以逐项补上，补齐后模型覆盖率会提高。"
              rows={health.gaps}
              empty="没有。"
            />
          </Box>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ mt: 1.25, alignItems: { sm: 'center' }, justifyContent: 'space-between' }}>
            <Typography variant="caption" color="text.secondary">
              后台监控共 {health.positionCount} 个持仓
              {health.coveragePct != null ? `；模型覆盖 ${percent(health.coveragePct)}（后台风险模型能定价的持仓，占全部持仓绝对市值）` : ''}
              {health.minCoveragePct != null ? `；最低覆盖率阈值 ${percent(health.minCoveragePct)}` : ''}。
            </Typography>
            <Button size="small" variant="outlined" onClick={() => setDetailsOpen(true)}>完整数据监控</Button>
          </Stack>
        </Box>
      </Collapse>
      <Dialog open={detailsOpen} onClose={() => setDetailsOpen(false)} maxWidth="lg" fullWidth aria-labelledby="positions-data-monitor-title">
        <DialogTitle id="positions-data-monitor-title" sx={{ pr: 7 }}>
          完整数据监控
          <IconButton aria-label="关闭" onClick={() => setDetailsOpen(false)} sx={{ position: 'absolute', right: 8, top: 8 }}><CloseRoundedIcon /></IconButton>
        </DialogTitle>
        <DialogContent dividers><PortfolioDataMonitor /></DialogContent>
      </Dialog>
    </>
  )
}
