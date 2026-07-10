import { Fragment, useMemo, useState } from 'react'
import {
  Box,
  Card,
  CardContent,
  Chip,
  Collapse,
  IconButton,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Tooltip,
  Typography,
} from '@mui/material'
import KeyboardArrowDownRoundedIcon from '@mui/icons-material/KeyboardArrowDownRounded'
import KeyboardArrowRightRoundedIcon from '@mui/icons-material/KeyboardArrowRightRounded'
import UnfoldLessRoundedIcon from '@mui/icons-material/UnfoldLessRounded'
import UnfoldMoreRoundedIcon from '@mui/icons-material/UnfoldMoreRounded'

import { preciseCurrency } from '../../utils/formatters.js'
import GroupDetailPanel from './GroupDetailPanel.jsx'
import StockNameCell from './StockNameCell.jsx'
import { groupAttentionState, matchesAttentionFilter, riskActionMeta } from './stockAnalysisUi.js'
import { canonicalGroupKey } from '../../utils/watchlistGrouping.js'

export default function WatchlistTable({ tier, rows, search, attentionFilter, riskData }) {
  const [expandedRowIds, setExpandedRowIds] = useState(() => new Set())

  const riskByKey = useMemo(() => {
    const map = new Map()
    if (!Array.isArray(riskData)) return map

    riskData.forEach((riskGroup) => {
      const key = canonicalGroupKey(riskGroup?.symbol)
      if (key && key !== 'unknown') map.set(key, riskGroup)
    })

    return map
  }, [riskData])

  const filteredRows = useMemo(() => rows.filter((row) => {
    const searchText = `${row.groupName} ${row.symbol} ${row.apiStatus} ${row.holdingStatus} ${row.instruments.map((item) => `${item.stockName} ${item.symbol}`).join(' ')}`
    const matchesSearch = !search || searchText.toLowerCase().includes(search.toLowerCase())
    const riskGroup = riskByKey.get(row.key) || riskByKey.get(canonicalGroupKey(row.groupName))
    return matchesSearch && matchesAttentionFilter(riskGroup, attentionFilter)
  }), [attentionFilter, riskByKey, rows, search])

  const toggleRow = (rowId) => {
    setExpandedRowIds((current) => {
      const next = new Set(current)
      if (next.has(rowId)) next.delete(rowId)
      else next.add(rowId)
      return next
    })
  }

  const expandAllRows = () => {
    setExpandedRowIds((current) => {
      const next = new Set(current)
      filteredRows.forEach((row) => next.add(row.id))
      return next
    })
  }

  const toggleAllRows = () => {
    if (allVisibleExpanded) collapseAllRows()
    else expandAllRows()
  }

  const collapseAllRows = () => {
    setExpandedRowIds((current) => {
      const visibleRowIds = new Set(filteredRows.map((row) => row.id))
      return new Set([...current].filter((rowId) => !visibleRowIds.has(rowId)))
    })
  }

  const expandedVisibleCount = filteredRows.reduce((count, row) => count + (expandedRowIds.has(row.id) ? 1 : 0), 0)
  const allVisibleExpanded = filteredRows.length > 0 && expandedVisibleCount === filteredRows.length

  if (!filteredRows.length && attentionFilter !== 'all') return null

  return (
    <Card className="panel-card">
      <CardContent>
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5} sx={{ justifyContent: 'space-between', mb: 2 }}>
          <Box>
            <Typography variant="h6">{tier.title}</Typography>
            <Typography variant="body2" color="text.secondary">{tier.subtitle}</Typography>
          </Box>
          <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
            <Tooltip title={allVisibleExpanded ? '收起全部标的' : '展开全部标的'}>
              <span>
                <IconButton
                  aria-label={allVisibleExpanded ? `收起 ${tier.title} 当前标的组` : `展开 ${tier.title} 当前标的组`}
                  size="small"
                  onClick={toggleAllRows}
                  disabled={!filteredRows.length}
                  sx={{
                    width: 32,
                    height: 32,
                    border: '1px solid #d7dde5',
                    borderRadius: 1.5,
                    color: allVisibleExpanded ? 'primary.main' : 'text.secondary',
                    backgroundColor: allVisibleExpanded ? '#f2f4ff' : '#ffffff',
                    '&:hover': { backgroundColor: allVisibleExpanded ? '#eef1ff' : '#f8fafc' },
                  }}
                >
                  {allVisibleExpanded ? <UnfoldLessRoundedIcon fontSize="small" /> : <UnfoldMoreRoundedIcon fontSize="small" />}
                </IconButton>
              </span>
            </Tooltip>
            <Chip color="primary" size="small" label={`${filteredRows.length} / ${rows.length} 个标的组`} />
          </Stack>
        </Stack>

        <TableContainer
          sx={{
            border: '1px solid #e5eaef',
            borderRadius: 2,
            overflowX: 'auto',
          }}
        >
          <Table size="small" sx={{ minWidth: 880 }} aria-label={`${tier.title} collapsible stock table`}>
            <TableHead>
              <TableRow sx={{ backgroundColor: '#f8fafc' }}>
                <TableCell sx={{ width: 56 }} />
                <TableCell sx={{ fontWeight: 800 }}>标的总览</TableCell>
                <TableCell align="right" sx={{ fontWeight: 800 }}>仓位</TableCell>
                <TableCell sx={{ fontWeight: 800 }}>核心风险</TableCell>
                <TableCell sx={{ fontWeight: 800 }}>建议操作</TableCell>
                <TableCell sx={{ fontWeight: 800 }}>状态</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {filteredRows.map((row) => {
                const open = expandedRowIds.has(row.id)
                const riskGroup = riskByKey.get(row.key) || riskByKey.get(canonicalGroupKey(row.groupName))
                const actionLabel = riskGroup?.groupActionLabel || 'N/A'
                const action = riskActionMeta(actionLabel)
                const attention = groupAttentionState(riskGroup)
                
                return (
                  <Fragment key={row.id}>
                    <TableRow
                      hover
                      onClick={() => toggleRow(row.id)}
                      sx={{
                        cursor: 'pointer',
                        '& > *': { borderBottom: open ? 'none' : '1px solid #edf2f7' },
                      }}
                    >
                      <TableCell>
                        <IconButton
                          aria-label={open ? `收起 ${row.groupName}` : `展开 ${row.groupName}`}
                          size="small"
                          onClick={(event) => {
                            event.stopPropagation()
                            toggleRow(row.id)
                          }}
                        >
                          {open ? <KeyboardArrowDownRoundedIcon /> : <KeyboardArrowRightRoundedIcon />}
                        </IconButton>
                      </TableCell>
                      <TableCell><StockNameCell row={row} /></TableCell>
                      <TableCell align="right">
                        <Typography variant="body2" fontWeight={700}>{preciseCurrency.format(row.marketValue)}</Typography>
                        {riskGroup && <Typography variant="caption" color="text.secondary">组合占比 {formatWeight(riskGroup.grossWeightPct)}</Typography>}
                      </TableCell>
                      <TableCell>
                        <Typography variant="body2" fontWeight={700}>Delta 敞口 {row.deltaExposure != null ? preciseCurrency.format(row.deltaExposure) : '—'}</Typography>
                        {attention.expiryCount > 0 ? <Typography variant="caption" color="warning.main">{attention.expiryCount} 个产品将在 90 天内到期</Typography> : null}
                        {!attention.expiryCount && attention.dataIssueCount > 0 ? <Typography variant="caption" color="warning.main">{attention.dataIssueCount} 个产品数据异常</Typography> : null}
                      </TableCell>
                      <TableCell>
                        <Chip 
                          size="small" 
                          label={action.label}
                          color={action.color}
                          variant={actionLabel === 'N/A' ? 'outlined' : 'filled'}
                          sx={{ fontWeight: 800 }}
                        />
                      </TableCell>
                      <TableCell>
                        <Typography variant="body2" fontWeight={700}>实时 {row.liveQuoteCount}/{row.instruments.length}</Typography>
                        <Typography variant="caption" color="text.secondary">股票 {row.stockCount} · 衍生品 {row.derivativeCount}</Typography>
                      </TableCell>
                    </TableRow>
                    <TableRow>
                      <TableCell colSpan={6} sx={{ p: 0, borderBottom: open ? '1px solid #edf2f7' : 0 }}>
                        <Collapse in={open} timeout="auto" unmountOnExit>
                          <Box sx={{ px: 2, pb: 2, backgroundColor: '#ffffff' }}>
                            <GroupDetailPanel group={row} riskGroup={riskGroup} />
                          </Box>
                        </Collapse>
                      </TableCell>
                    </TableRow>
                  </Fragment>
                )
              })}
              {!filteredRows.length ? (
                <TableRow>
                  <TableCell colSpan={6} sx={{ py: 4, textAlign: 'center' }}>
                    <Typography color="text.secondary">当前筛选下没有标的</Typography>
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </TableContainer>
      </CardContent>
    </Card>
  )
}

function formatWeight(value) {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? `${(numeric * 100).toFixed(1)}%` : '—'
}
