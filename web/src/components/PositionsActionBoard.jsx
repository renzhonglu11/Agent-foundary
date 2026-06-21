import { useMemo, useState } from 'react'
import {
  Alert,
  Box,
  Chip,
  Collapse,
  IconButton,
  LinearProgress,
  Stack,
  Tooltip,
  Typography,
  keyframes,
} from '@mui/material'
import { DataGrid } from '@mui/x-data-grid'
import AddCircleRoundedIcon from '@mui/icons-material/AddCircleRounded'
import AutorenewRoundedIcon from '@mui/icons-material/AutorenewRounded'
import CheckCircleRoundedIcon from '@mui/icons-material/CheckCircleRounded'
import KeyboardArrowDownRoundedIcon from '@mui/icons-material/KeyboardArrowDownRounded'
import KeyboardArrowRightRoundedIcon from '@mui/icons-material/KeyboardArrowRightRounded'
import TrendingDownRoundedIcon from '@mui/icons-material/TrendingDownRounded'

import { compactCurrency, number } from '../utils/formatters.js'
import { buildWatchlistGroups, canonicalGroupKey } from '../utils/watchlistGrouping.js'
import ProductMonitoringDashboard from './ProductMonitoringDashboard.jsx'

const actionDefinitions = [
  { id: 'SELL', title: 'SELL', subtitle: '卖出 / 降低风险', color: 'error', icon: TrendingDownRoundedIcon },
  { id: 'ROLL', title: 'ROLL', subtitle: '展期 / 换仓', color: 'warning', icon: AutorenewRoundedIcon },
  { id: 'HOLD', title: 'HOLD', subtitle: '继续持有并监控', color: 'info', icon: CheckCircleRoundedIcon },
  { id: 'BUY', title: 'BUY', subtitle: '允许买入 / 加仓', color: 'success', icon: AddCircleRoundedIcon },
]

const riskActionColors = {
  EXIT_NOW: 'error',
  REDUCE_CONCENTRATION: 'error',
  REDUCE_RISK: 'error',
  REDUCE_DERIVATIVE_RISK: 'error',
  ROLL: 'warning',
  CLOSE_OR_ROLL_DERIVATIVE: 'warning',
  HOLD_MONITOR: 'warning',
  SELL: 'error',
  HOLD: 'info',
  BUY: 'success',
  ADD_ALLOWED: 'success',
  BUY_MORE: 'success',
}

const rowClickedPulse = keyframes`
  0% { background-color: rgba(19, 222, 185, 0.28); }
  70% { background-color: rgba(19, 222, 185, 0.14); }
  100% { background-color: transparent; }
`

// ---- signal light helpers ----

const riskSignalColors = {
  HARD_BLOCKED: '#d32f2f',
  WATCH: '#ed6c02',
  OK: '#4caf50',
}

const riskSignalLabels = {
  HARD_BLOCKED: '危险',
  WATCH: '观察',
  OK: '安全',
}

const confidenceLabels = {
  live_delta: '实时 Delta',
  estimated_delta: '估算 Delta',
  estimated_omega: '估算 Omega',
  estimated_leverage: '估算杠杆',
  estimated_market_value: '估算市值',
  no_data: '无数据',
}

function riskTooltipLines(leg) {
  if (!leg) return '无风险数据'
  const lines = [
    `状态: ${riskSignalLabels[leg.legRiskStatus] || leg.legRiskStatus || '—'}`,
    `敞口置信度: ${confidenceLabels[leg.exposureConfidence] || leg.exposureConfidence || '—'}`,
    `数据完整度: ${leg.dataCompletenessRiskScore ?? '—'} / 10`,
  ]
  if (leg.barrierDistancePct != null) lines.push(`障碍距离: ${(leg.barrierDistancePct * 100).toFixed(1)}%`)
  if (leg.quoteAgeHours != null) lines.push(`报价时效: ${leg.quoteAgeHours.toFixed(1)}h`)
  if (leg.daysToExpiry != null) lines.push(`距到期: ${leg.daysToExpiry} 天`)
  if (leg.delta != null) lines.push(`Delta: ${number.format(leg.delta)}`)
  return lines.join('\n')
}

// ========================================================

export default function PositionsActionBoard({ data, riskData, riskLoading, riskError, structuredProducts, structuredProductsLoading, alpacaQuotes, onAddPnlRecord }) {
  const [expandedActionIds, setExpandedActionIds] = useState(() => new Set(['SELL', 'ROLL']))
  const [selectedProduct, setSelectedProduct] = useState(null)
  const [clickedRowId, setClickedRowId] = useState(null)
  const totalMarketValue = Number(data?.summary?.totalMarketValue) || 0
  const tier1Groups = useMemo(() => buildWatchlistGroups(data, structuredProducts, alpacaQuotes).tier1, [data, structuredProducts, alpacaQuotes])
  const riskByKey = useMemo(() => buildRiskMap(riskData), [riskData])
  const groupsWithRisk = useMemo(() => (
    tier1Groups
      .map((group) => {
        const riskGroup = riskByKey.get(group.key) || riskByKey.get(canonicalGroupKey(group.groupName))
        return { group, riskGroup }
      })
      .filter(({ riskGroup }) => Boolean(riskGroup))
  ), [riskByKey, tier1Groups])
  const productEntries = useMemo(() => buildProductActionEntries(groupsWithRisk, totalMarketValue), [groupsWithRisk, totalMarketValue])
  const sections = useMemo(() => (
    actionDefinitions.map((definition) => ({
      ...definition,
      entries: productEntries.filter((entry) => entry.primaryAction === definition.id),
    }))
  ), [productEntries])

  const loading = Boolean(riskLoading || structuredProductsLoading)
  const toggleSection = (actionId) => {
    setExpandedActionIds((current) => {
      const next = new Set(current)
      if (next.has(actionId)) next.delete(actionId)
      else next.add(actionId)
      return next
    })
  }

  const handleRowClick = (row) => {
    setClickedRowId(row.id)
    window.setTimeout(() => setClickedRowId((current) => (current === row.id ? null : current)), 650)
    setSelectedProduct((current) => {
      if (current?.item?.id === row.item.id) return null
      return row
    })
  }

  return (
    <Box sx={{ border: '1px solid #e5eaef', borderRadius: 2, backgroundColor: '#ffffff' }}>
      {/* header */}
      <Box sx={{ px: { xs: 2, md: 2.5 }, py: 1.5, borderBottom: '1px solid #e5eaef', backgroundColor: '#fbfdff' }}>
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={1} sx={{ justifyContent: 'space-between', alignItems: { xs: 'flex-start', md: 'center' } }}>
          <Box>
            <Typography variant="h6" fontSize="1rem">Tier 1 仓位监控</Typography>
            <Typography variant="caption" color="text.secondary">按产品主动作展示当前 Tier 1 衍生品 — 紧凑列表视图</Typography>
          </Box>
          <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
            <Chip size="small" color="primary" label={`${groupsWithRisk.length} 标的组`} />
            <Chip size="small" variant="outlined" label={`${productEntries.length} 产品`} />
          </Stack>
        </Stack>
      </Box>

      {loading ? <LinearProgress /> : null}

      <Stack spacing={1.5} sx={{ p: { xs: 1.5, md: 2 } }}>
        {riskError ? <Alert severity="warning" sx={{ py: 0 }}>风险数据加载失败：{riskError.message}</Alert> : null}

        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: { xs: '1fr', xl: 'minmax(0, 0.9fr) minmax(680px, 1fr)' },
            gap: 1.5,
            alignItems: 'start',
          }}
        >
          <Stack spacing={1.5} sx={{ minWidth: 0, order: { xs: 2, xl: 1 } }}>
            {sections.map((section) => (
              <ActionSection
                key={section.id}
                definition={section}
                entries={section.entries}
                expanded={expandedActionIds.has(section.id)}
                onToggle={() => toggleSection(section.id)}
                onRowClick={handleRowClick}
                clickedRowId={clickedRowId}
              />
            ))}
          </Stack>

          <Box
            sx={{
              position: { xs: 'static', xl: 'sticky' },
              top: { xl: 72 },
              zIndex: 5,
              maxHeight: { xl: 'calc(100vh - 80px)' },
              overflowY: { xl: 'auto' },
              backgroundColor: '#ffffff',
              borderRadius: 2,
              boxShadow: { xs: 'none', xl: '0 8px 24px rgba(15, 23, 42, 0.08)' },
              overscrollBehavior: 'contain',
              minWidth: 0,
              order: { xs: 1, xl: 2 },
            }}
          >
            <ProductMonitoringDashboard
              item={selectedProduct?.item ?? null}
              riskLeg={selectedProduct?.riskLeg ?? null}
              onClose={() => setSelectedProduct(null)}
              onAddPnlRecord={onAddPnlRecord}
            />
          </Box>
        </Box>
      </Stack>
    </Box>
  )
}

// ---- section ----

function ActionSection({ definition, entries, expanded, onToggle, onRowClick, clickedRowId }) {
  const Icon = definition.icon

  return (
    <Box sx={{ border: '1px solid #e5eaef', borderRadius: 2, overflow: 'hidden' }}>
      {/* section header */}
      <Box
        role="button" tabIndex={0}
        onClick={onToggle}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle() } }}
        sx={{
          px: 1.5, py: 1, cursor: 'pointer', backgroundColor: '#f8fafc',
          borderBottom: expanded ? '1px solid #e5eaef' : 0,
          '&:hover': { backgroundColor: '#f3f7fb' },
        }}
      >
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center', justifyContent: 'space-between' }}>
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
            <IconButton size="small" onClick={(e) => { e.stopPropagation(); onToggle() }} sx={{ width: 24, height: 24 }}>
              {expanded ? <KeyboardArrowDownRoundedIcon fontSize="small" /> : <KeyboardArrowRightRoundedIcon fontSize="small" />}
            </IconButton>
            <Icon fontSize="small" color={definition.color} />
            <Typography variant="body2" fontWeight={900}>{definition.title}</Typography>
            <Typography variant="caption" color="text.secondary">{definition.subtitle}</Typography>
          </Stack>
          <Chip size="small" color={definition.color} label={`${entries.length}`} sx={{ minWidth: 32, height: 20, '& .MuiChip-label': { px: 1 } }} />
        </Stack>
      </Box>

      <Collapse in={expanded} timeout="auto" unmountOnExit>
        {entries.length ? (
          <ProductActionTable entries={entries} onRowClick={onRowClick} clickedRowId={clickedRowId} />
        ) : (
          <Box sx={{ px: 1.5, py: 1.5 }}>
            <Typography variant="body2" color="text.secondary">当前没有匹配的 Tier 1 产品。</Typography>
          </Box>
        )}
      </Collapse>
    </Box>
  )
}

// ---- table columns ----

const actionDescriptions = {
  SELL: '产品风险、到期、障碍价、数据质量或单品敞口触发卖出/减仓',
  BUY: '产品风险预算、Delta、杠杆、期限和敞口满足买入/加仓条件',
  HOLD: '当前无紧急风险，但买入条件不够强',
  EXIT_NOW: '风险已越过退出阈值，优先平仓或清理该产品',
  REDUCE_CONCENTRATION: '该标的敞口集中度过高，建议减持',
  REDUCE_RISK: '衍生品数据质量、杠杆、障碍价或单腿敞口触发风险降档',
  REDUCE_DERIVATIVE_RISK: '衍生品数据缺失或障碍价临近，建议降低风险敞口',
  ROLL: '产品临近到期，建议展期或换到更远期限',
  CLOSE_OR_ROLL_DERIVATIVE: '衍生品临近到期，建议平仓或展期',
  HOLD_MONITOR: '当前无紧急风险，继续持有并监控',
  ADD_ALLOWED: '风险检查通过，允许加仓但不是主动买入建议',
  BUY_MORE: '敞口、Delta、杠杆、期限和组级仓位均满足主动加仓条件',
}

const tableColumns = [
  // All content-bearing columns share flex:1 so widths stay even;
  // only the ultra-narrow signal and DTE stay fixed.
  // valueGetter extracts the raw sortable value from nested row data.
  {
    field: 'productName',
    headerName: '产品名称',
    flex: 2.2,
    minWidth: 260,
    valueGetter: (_, row) => productDisplayName(row.item),
    renderCell: ({ row }) => {
      const fullName = productDisplayName(row.item)
      return (
        <Tooltip title={fullName} arrow placement="top" slotProps={{ tooltip: { sx: { cursor: 'default' } } }}>
          <Box sx={{ minWidth: 0, py: 0.25 }}>
            <Typography
              variant="body2"
              fontWeight={700}
              sx={{ whiteSpace: 'normal', overflowWrap: 'anywhere', lineHeight: 1.25 }}
            >
              {fullName}
            </Typography>
            <Typography variant="caption" color="text.secondary" noWrap>{row.item.symbol}</Typography>
          </Box>
        </Tooltip>
      )
    },
  },
  {
    field: 'groupAction',
    headerName: '组动作',
    flex: 1,
    minWidth: 100,
    valueGetter: (_, row) => row.riskGroup?.action?.groupActionLabel || row.riskGroup?.groupActionLabel || '',
    renderCell: ({ row }) => {
      const action = row.riskGroup?.action?.groupActionLabel || row.riskGroup?.groupActionLabel || 'N/A'
      const label = String(action).replace(/_/g, ' ')
      const desc = actionDescriptions[action] || '暂无风险评估'
      return (
        <Tooltip title={desc} arrow placement="top" slotProps={{ tooltip: { sx: { cursor: 'default' } } }}>
          <Chip size="small" color={riskActionColors[action] || 'default'}
            variant={action === 'N/A' ? 'outlined' : 'filled'}
            label={label}
            sx={{ height: 20, '& .MuiChip-label': { px: 0.75, fontSize: '0.7rem' } }}
          />
        </Tooltip>
      )
    },
  },
  {
    field: 'marketValue',
    headerName: '市值',
    type: 'number',
    flex: 1,
    minWidth: 80,
    valueGetter: (_, row) => Number(row.item?.marketValue) || 0,
    renderCell: ({ row }) => (
      <Typography variant="body2" sx={{ fontVariantNumeric: 'tabular-nums' }}>
        {compactCurrency(row.item.marketValue || 0)}
      </Typography>
    ),
  },
  {
    field: 'deltaExposure',
    headerName: 'Δ 敞口',
    type: 'number',
    flex: 1,
    minWidth: 90,
    valueGetter: (_, row) => Number(row.riskLeg?.deltaExposure ?? row.item?.deltaExposureEur) || 0,
    renderCell: ({ row }) => (
      <Typography variant="body2" sx={{ fontVariantNumeric: 'tabular-nums' }}>
        {compactCurrency(row.riskLeg?.deltaExposure ?? row.item.deltaExposureEur)}
      </Typography>
    ),
  },
  {
    field: 'exposurePct',
    headerName: '敞口%',
    type: 'number',
    flex: 1,
    minWidth: 70,
    valueGetter: (_, row) => Number(row.exposurePct) || 0,
    renderCell: ({ row }) => (
      <Typography variant="body2" sx={{ fontVariantNumeric: 'tabular-nums' }}>
        {formatSignedWeight(row.exposurePct)}
      </Typography>
    ),
  },
  {
    field: 'delta',
    headerName: 'Delta',
    type: 'number',
    flex: 1,
    minWidth: 58,
    valueGetter: (_, row) => row.item?.delta ?? null,
    renderCell: ({ row }) => {
      const d = row.item.delta
      return d != null
        ? <Typography variant="body2" sx={{ fontVariantNumeric: 'tabular-nums' }}>{number.format(d)}</Typography>
        : <Typography variant="body2" color="text.disabled">—</Typography>
    },
  },
  {
    field: 'omega',
    headerName: 'Omega',
    type: 'number',
    flex: 1,
    minWidth: 58,
    valueGetter: (_, row) => row.item?.omega ?? null,
    renderCell: ({ row }) => {
      const o = row.item.omega
      return o != null
        ? <Typography variant="body2" sx={{ fontVariantNumeric: 'tabular-nums' }}>{number.format(o)}</Typography>
        : <Typography variant="body2" color="text.disabled">—</Typography>
    },
  },
  {
    field: 'leverage',
    headerName: '杠杆',
    type: 'number',
    flex: 1,
    minWidth: 58,
    valueGetter: (_, row) => Number(row.item?.leverage || row.item?.effectiveLeverage) || 0,
    renderCell: ({ row }) => {
      const lev = row.item.leverage || row.item.effectiveLeverage
      return lev != null
        ? <Typography variant="body2" sx={{ fontVariantNumeric: 'tabular-nums' }}>{number.format(lev)}</Typography>
        : <Typography variant="body2" color="text.disabled">—</Typography>
    },
  },
  {
    field: 'iv',
    headerName: 'IV',
    type: 'number',
    flex: 1,
    minWidth: 58,
    valueGetter: (_, row) => Number(row.item?.iv) || null,
    renderCell: ({ row }) => {
      const iv = row.item.iv
      return iv != null
        ? <Typography variant="body2" sx={{ fontVariantNumeric: 'tabular-nums' }}>{(Number(iv) * 100).toFixed(0)}%</Typography>
        : <Typography variant="body2" color="text.disabled">—</Typography>
    },
  },
  {
    field: 'daysToExpiry',
    headerName: 'DTE',
    type: 'number',
    width: 56,
    valueGetter: (_, row) => row.riskLeg?.daysToExpiry ?? null,
    renderCell: ({ row }) => <DteCell dte={row.riskLeg?.daysToExpiry} />,
  },
  {
    field: 'riskStatus',
    headerName: '信号',
    width: 48,
    valueGetter: (_, row) => row.riskLeg?.legRiskStatus || '',
    renderCell: ({ row }) => <RiskSignal leg={row.riskLeg} />,
  },
  {
    field: 'quantity',
    headerName: '数量',
    type: 'number',
    flex: 1,
    minWidth: 65,
    valueGetter: (_, row) => Number(row.item?.quantity) || 0,
    renderCell: ({ row }) => (
      <Typography variant="body2" sx={{ fontVariantNumeric: 'tabular-nums' }}>
        {number.format(row.item.quantity ?? 0)}
      </Typography>
    ),
  },
]

// ---- table ----

function ProductActionTable({ entries, onRowClick, clickedRowId }) {
  const rows = useMemo(() => entries.map((entry, index) => ({
    id: `${entry.primaryAction}-${entry.item.id ?? index}`,
    ...entry,
  })), [entries])

  return (
    <Box sx={{ width: '100%' }}>
      <DataGrid
        rows={rows}
        columns={tableColumns}
        density="compact"
        disableRowSelectionOnClick
        onRowClick={({ row }) => onRowClick?.(row)}
        autoHeight
        getRowHeight={() => 'auto'}
        getEstimatedRowHeight={() => 56}
        hideFooter={rows.length <= 25}
        initialState={{
          sorting: { sortModel: [{ field: 'marketValue', sort: 'desc' }] },
          pagination: { paginationModel: { pageSize: 25, page: 0 } },
        }}
        pageSizeOptions={[10, 25, 50]}
        sx={{
          border: 'none',
          fontSize: '0.8rem',
          '& .MuiDataGrid-columnHeaders': { fontSize: '0.75rem' },
          '& .MuiDataGrid-row': { cursor: 'pointer' },
          '& .MuiDataGrid-cell': { py: 0.75, px: 1, display: 'flex', alignItems: 'center' },
          '& .MuiDataGrid-columnHeader': { backgroundColor: '#f8fafc', px: 1 },
          ...(clickedRowId && {
            [`& .MuiDataGrid-row[data-id="${clickedRowId}"]`]: {
              animation: `${rowClickedPulse} 650ms ease-out`,
            },
          }),
        }}
      />
    </Box>
  )
}

// ---- cell renderers ----

function DteCell({ dte }) {
  if (dte == null) return <Typography variant="body2" color="text.disabled" fontSize="inherit">—</Typography>
  const color = dte < 7 ? '#d32f2f' : dte < 30 ? '#ed6c02' : undefined
  return (
    <Typography variant="body2" fontWeight={dte < 7 ? 700 : 400} sx={{ color, fontVariantNumeric: 'tabular-nums' }} fontSize="inherit">
      {dte}
    </Typography>
  )
}

function RiskSignal({ leg }) {
  if (!leg) return <Typography variant="body2" color="text.disabled" fontSize="inherit">—</Typography>

  const status = leg.legRiskStatus || '—'
  const color = riskSignalColors[status] || '#9e9e9e'
  const tooltip = riskTooltipLines(leg)

  return (
    <Tooltip title={<Box component="span" sx={{ whiteSpace: 'pre-line', fontSize: '0.8rem' }}>{tooltip}</Box>} arrow placement="right" slotProps={{ tooltip: { sx: { cursor: 'default' } } }}>
      <Box
        sx={{
          width: 12, height: 12, borderRadius: '50%',
          backgroundColor: color,
          boxShadow: `0 0 6px ${color}66`,
          flexShrink: 0,
        }}
      />
    </Tooltip>
  )
}

function buildRiskMap(riskData) {
  const map = new Map()
  if (!Array.isArray(riskData)) return map
  riskData.forEach((riskGroup) => {
    const key = canonicalGroupKey(riskGroup?.symbol)
    if (key && key !== 'unknown') map.set(key, riskGroup)
  })
  return map
}

function buildProductActionEntries(groupsWithRisk, totalMarketValue) {
  return groupsWithRisk.flatMap(({ group, riskGroup }) => {
    const riskLegByIsin = new Map((riskGroup?.legs || []).map((leg) => [leg.isin, leg]))
    return group.derivatives.map((item) => {
      const riskLeg = riskLegByIsin.get(item.symbol)
      const exposure = Number(riskLeg?.deltaExposure ?? item.deltaExposureEur)
      return {
        group, riskGroup, item, riskLeg,
        exposurePct: totalMarketValue > 0 && Number.isFinite(exposure) ? exposure / totalMarketValue : null,
        primaryAction: primaryActionForProduct(riskGroup, riskLeg),
      }
    })
  })
}

function primaryActionForProduct(riskGroup, riskLeg) {
  const groupAction = riskGroup?.action?.groupActionLabel || riskGroup?.groupActionLabel
  const daysToExpiry = Number(riskLeg?.daysToExpiry)
  const status = riskLeg?.legRiskStatus
  const confidence = riskLeg?.exposureConfidence
  const allowed = new Set(Array.isArray(riskGroup?.action?.allowedActions) ? riskGroup.action.allowedActions : [])
  const legAction = normalizeProductAction(riskLeg?.primaryAction)

  if (['SELL', 'ROLL', 'HOLD', 'BUY'].includes(legAction)) return legAction
  if (allowed.has('ROLL') && Number.isFinite(daysToExpiry) && daysToExpiry >= 0 && daysToExpiry < 7) return 'ROLL'
  if (status === 'HARD_BLOCKED') return 'SELL'
  if (status === 'WATCH') return 'SELL'
  if (groupAction === 'REDUCE_DERIVATIVE_RISK') return 'SELL'
  if (groupAction === 'CLOSE_OR_ROLL_DERIVATIVE') return 'HOLD'
  if (groupAction === 'ADD_ALLOWED' || ((allowed.has('BUY_MORE') || allowed.has('BUY')) && status === 'OK' && confidence !== 'no_data')) return 'HOLD'
  return 'HOLD'
}

function normalizeProductAction(action) {
  if (action === 'SELL' || action === 'ROLL' || action === 'HOLD' || action === 'BUY') return action
  if (action === 'EXIT_NOW' || action === 'REDUCE_RISK' || action === 'REDUCE_DERIVATIVE_RISK') return 'SELL'
  if (action === 'HOLD_MONITOR' || action === 'CLOSE_OR_ROLL_DERIVATIVE') return 'HOLD'
  if (action === 'ADD_ALLOWED' || action === 'BUY_MORE') return 'BUY'
  return null
}

function productDisplayName(item) {
  const instrument = String(item?.instrument || '').trim()
  if (instrument) return instrument
  return String(item?.stockName || item?.symbol || '').split(' · ')[0]
}

function formatSignedWeight(value) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return '—'
  const sign = numeric * 100 > 0 ? '+' : ''
  return `${sign}${number.format(numeric * 100)}%`
}
