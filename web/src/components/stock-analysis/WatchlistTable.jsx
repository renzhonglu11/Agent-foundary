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
  Typography,
} from '@mui/material'
import KeyboardArrowDownRoundedIcon from '@mui/icons-material/KeyboardArrowDownRounded'
import KeyboardArrowRightRoundedIcon from '@mui/icons-material/KeyboardArrowRightRounded'

import { preciseCurrency } from '../../utils/formatters.js'
import GroupDetailPanel from './GroupDetailPanel.jsx'
import Pill from './Pill.jsx'
import StockNameCell from './StockNameCell.jsx'
import { ratingMeta } from './stockAnalysisUi.js'

const riskActionColors = {
  'REDUCE_CONCENTRATION': 'error',
  'REDUCE_DERIVATIVE_RISK': 'error',
  'CLOSE_OR_ROLL_DERIVATIVE': 'warning',
  'HOLD_MONITOR': 'warning',
  'ADD_ALLOWED': 'success',
}

export default function WatchlistTable({ tier, rows, search, ratingFilter, riskData }) {
  const [expandedRowId, setExpandedRowId] = useState(null)

  const filteredRows = useMemo(() => rows.filter((row) => {
    const searchText = `${row.groupName} ${row.symbol} ${row.rating} ${row.apiStatus} ${row.holdingStatus} ${row.instruments.map((item) => `${item.stockName} ${item.symbol}`).join(' ')}`
    const matchesSearch = !search || searchText.toLowerCase().includes(search.toLowerCase())
    const matchesRating = ratingFilter === '全部评级' || row.rating === ratingFilter
    return matchesSearch && matchesRating
  }), [ratingFilter, rows, search])

  const toggleRow = (rowId) => {
    setExpandedRowId((current) => (current === rowId ? null : rowId))
  }

  return (
    <Card className="panel-card">
      <CardContent>
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={1} sx={{ justifyContent: 'space-between', mb: 2 }}>
          <Box>
            <Typography variant="h6">{tier.title}</Typography>
            <Typography variant="body2" color="text.secondary">{tier.subtitle}</Typography>
          </Box>
          <Chip color="primary" size="small" label={`${filteredRows.length} / ${rows.length} 个标的组`} />
        </Stack>

        <TableContainer
          sx={{
            border: '1px solid #e5eaef',
            borderRadius: 2,
            overflowX: 'auto',
          }}
        >
          <Table size="small" sx={{ minWidth: 960 }} aria-label={`${tier.title} collapsible stock table`}>
            <TableHead>
              <TableRow sx={{ backgroundColor: '#f8fafc' }}>
                <TableCell sx={{ width: 56 }} />
                <TableCell sx={{ fontWeight: 800 }}>标的总览</TableCell>
                <TableCell align="right" sx={{ fontWeight: 800 }}>总市值</TableCell>
                <TableCell align="right" sx={{ fontWeight: 800 }}>Delta Exposure</TableCell>
                <TableCell sx={{ fontWeight: 800 }}>Risk Action</TableCell>
                <TableCell sx={{ fontWeight: 800 }}>实时状态</TableCell>
                <TableCell sx={{ fontWeight: 800 }}>组成</TableCell>
                <TableCell align="right" sx={{ fontWeight: 800 }}>最近交易</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {filteredRows.map((row) => {
                const open = expandedRowId === row.id
                const riskGroup = riskData?.find(r => r.symbol?.toLowerCase() === row.key?.toLowerCase() || r.symbol?.toLowerCase() === row.groupName?.toLowerCase())
                const actionLabel = riskGroup?.groupActionLabel || 'N/A'
                
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
                        {riskGroup && <Typography variant="caption" color="text.secondary">Gross: {(riskGroup.grossWeightPct * 100).toFixed(1)}%</Typography>}
                      </TableCell>
                      <TableCell align="right"><Typography variant="body2" fontWeight={700}>{row.deltaExposure ? preciseCurrency.format(row.deltaExposure) : '—'}</Typography></TableCell>
                      <TableCell>
                        <Chip 
                          size="small" 
                          label={actionLabel.replace(/_/g, ' ')} 
                          color={riskActionColors[actionLabel] || 'default'} 
                          variant={actionLabel === 'N/A' ? 'outlined' : 'filled'}
                        />
                      </TableCell>
                      <TableCell>
                        <Stack direction="row" spacing={0.75} useFlexGap sx={{ flexWrap: 'wrap' }}>
                          <Chip size="small" color={row.liveStockQuoteCount ? 'success' : 'default'} variant="outlined" label={`Alpaca ${row.liveStockQuoteCount}/${row.stockCount}`} />
                          <Chip size="small" color={row.liveDerivativeCount ? 'success' : 'default'} variant="outlined" label={`衍生品 ${row.liveDerivativeCount}/${row.derivativeCount}`} />
                        </Stack>
                      </TableCell>
                      <TableCell>
                        <Stack direction="row" spacing={0.75} useFlexGap sx={{ flexWrap: 'wrap' }}>
                          <Chip size="small" variant="outlined" label={`股票/ETF ${row.stockCount}`} />
                          <Chip size="small" color={row.derivativeCount ? 'info' : 'default'} variant="outlined" label={`衍生品 ${row.derivativeCount}`} />
                        </Stack>
                      </TableCell>
                      <TableCell align="right"><Typography variant="body2">{row.holdingDays === null ? '—' : `${row.holdingDays} 天前`}</Typography></TableCell>
                    </TableRow>
                    <TableRow>
                      <TableCell colSpan={8} sx={{ p: 0, borderBottom: open ? '1px solid #edf2f7' : 0 }}>
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
                  <TableCell colSpan={8} sx={{ py: 4, textAlign: 'center' }}>
                    <Typography color="text.secondary">没有匹配的股票</Typography>
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
