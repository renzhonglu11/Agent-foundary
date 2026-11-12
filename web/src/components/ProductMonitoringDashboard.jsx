import { useEffect, useMemo, useState } from 'react'
import {
  Box,
  Chip,
  IconButton,
  Snackbar,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
  keyframes,
} from '@mui/material'
import CloseRoundedIcon from '@mui/icons-material/CloseRounded'

import NumberField from './shared/NumberField.jsx'
import { number } from '../utils/formatters.js'
import { PRODUCT_TYPE_LABELS } from '../utils/labels.js'
import {
  calculateDrawdown,
  calculateExpiryPnl,
  calculateTimeDecay,
  DEFAULT_SCENARIO_PCTS,
  getOptionDirection,
  getTimeDecayPeriods,
  METHOD_META,
  daysUntil,
} from '../utils/productCalculations.js'

// ---- tab definitions ----

const MONITOR_TABS = [
  { id: 'expiry', label: '到期收益' },
  { id: 'time', label: '时间损耗' },
  { id: 'drawdown', label: '短期情景' },
]

const FACTOR_MONITOR_TABS = [
  { id: 'drawdown', label: '杠杆情景' },
]

// ---- helpers ----

const oneDecimalNumber = new Intl.NumberFormat('de-DE', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
})

const oneDecimalCurrency = new Intl.NumberFormat('de-DE', {
  style: 'currency',
  currency: 'EUR',
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
})

const oneDecimalUsd = new Intl.NumberFormat('de-DE', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
})

const fxRateNumber = new Intl.NumberFormat('de-DE', {
  minimumFractionDigits: 4,
  maximumFractionDigits: 4,
})

const FALLBACK_USD_EUR_RATE = 0.92
const rowAddedPulse = keyframes`
  0% { background-color: rgba(19, 222, 185, 0.28); }
  70% { background-color: rgba(19, 222, 185, 0.14); }
  100% { background-color: transparent; }
`

function roundOne(value) {
  const n = Number(value)
  return Number.isFinite(n) ? Math.round(n * 10) / 10 : null
}

function formatPnl(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return '—'
  const sign = n >= 0 ? '+' : ''
  return `${sign}${oneDecimalCurrency.format(n)}`
}

function formatPnlPct(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return '—'
  const sign = n >= 0 ? '+' : ''
  return `${sign}${oneDecimalNumber.format(n)}%`
}

function productDisplayName(item) {
  const instrument = String(item?.instrument || '').trim()
  if (instrument) return instrument
  return String(item?.stockName || item?.symbol || '未知产品').split(' · ')[0]
}

function buildPnlRecord(type, item, row) {
  const pnl = Number(row?.result?.pnl)
  if (!Number.isFinite(pnl)) return null

  const productKey = item?.id || item?.symbol || productDisplayName(item)
  return {
    id: `${type}:${productKey}:${row.id}`,
    type,
    productName: productDisplayName(item),
    pnl,
    underlyingMovePct: Number(row.pct),
  }
}

function usdRateForItem(item) {
  const raw = Number(item?.underlyingSpotRaw)
  const spot = Number(item?.underlyingSpot)
  if (
    Number.isFinite(raw) && raw > 0
    && Number.isFinite(spot) && spot > 0
    && (item?.underlyingSpotRawCurrency || '').toUpperCase() === 'USD'
  ) {
    return spot / raw
  }

  const rate = Number(item?.underlyingSpotUsdEurRate ?? item?.usdEurRate)
  return Number.isFinite(rate) && rate > 0 ? rate : FALLBACK_USD_EUR_RATE
}

function hasUsdUnderlying(item) {
  return (item?.underlyingSpotRawCurrency || '').toUpperCase() === 'USD'
}

function formatUnderlyingUsd(value, item) {
  const usd = underlyingEurToUsd(value, item)
  if (usd == null) return '—'
  return hasUsdUnderlying(item) ? oneDecimalUsd.format(usd) : oneDecimalCurrency.format(usd)
}

function underlyingEurToUsd(value, item) {
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  if (!hasUsdUnderlying(item)) return n

  const raw = Number(item?.underlyingSpotRaw)
  const spot = Number(item?.underlyingSpot)
  if (
    Number.isFinite(raw) && raw > 0
    && Number.isFinite(spot) && spot > 0
    && (item?.underlyingSpotRawCurrency || '').toUpperCase() === 'USD'
  ) {
    return raw * (n / spot)
  }

  const rate = usdRateForItem(item)
  return rate ? n / rate : n
}

function underlyingUsdToEur(value, item) {
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  return hasUsdUnderlying(item) ? n * usdRateForItem(item) : n
}

function productCalculationItem(item) {
  if (!item) return item
  if (!hasUsdUnderlying(item)) return item
  return {
    ...item,
    strikePrice: underlyingUsdToEur(item.strikePrice, item),
  }
}

function formatStrikeDisplay(value, item) {
  const n = Number(value)
  if (!Number.isFinite(n)) return '—'
  return hasUsdUnderlying(item) ? oneDecimalUsd.format(n) : oneDecimalCurrency.format(n)
}

// ========================================================

// `summary` renders under the product header, e.g. the Positions plan strip.
export default function ProductMonitoringDashboard({ item, riskLeg, onClose, onAddPnlRecord, summary = null }) {
  const [activeTab, setActiveTab] = useState(() => (
    item?.productType === 'factor_certificate' ? 'drawdown' : 'expiry'
  ))
  const [pnlFeedback, setPnlFeedback] = useState({ open: false, message: '' })

  const direction = item ? getOptionDirection(item) : null
  const hasStrike = item ? Number.isFinite(Number(item.strikePrice)) && Number(item.strikePrice) > 0 : false
  const hasRatio = item ? Number.isFinite(Number(item.ratio)) && Number(item.ratio) > 0 : false
  const hasExpiry = item ? Boolean(item.expiry) : false
  const hasSpot = item ? Number.isFinite(Number(item.underlyingSpot)) && Number(item.underlyingSpot) > 0 : false
  const hasPrice = item ? Number.isFinite(Number(item.price)) && Number(item.price) > 0 : false
  const isFactorCert = item?.productType === 'factor_certificate'
  const isOpenEnd = item?.productType === 'open_end_turbo'
  const productKey = item?.id || item?.symbol || item?.stockName
  const monitorTabs = isFactorCert ? FACTOR_MONITOR_TABS : MONITOR_TABS

  useEffect(() => {
    setActiveTab(isFactorCert ? 'drawdown' : 'expiry')
  }, [isFactorCert, productKey])

  const handleAddPnlRecord = (record) => {
    onAddPnlRecord?.(record)
    setPnlFeedback({
      open: true,
      message: `已加入 P&L 模拟器：${record.productName}`,
    })
  }

  return (
    <Box sx={{ border: '1px solid #e5eaef', borderRadius: 2, overflow: 'hidden', backgroundColor: '#ffffff' }}>
      {/* Header */}
      <DashboardHeader item={item} direction={direction} onClose={onClose} />

      {/* Context bar */}
      <DashboardContextBar item={item} riskLeg={riskLeg} direction={direction} />
      {summary}

      {/* Toggle buttons */}
      <Box sx={{ px: 1.5, pt: 1, pb: 0.5 }}>
        <ToggleButtonGroup
          value={activeTab}
          exclusive
          size="small"
          onChange={(_, v) => { if (v) setActiveTab(v) }}
          sx={{
            '& .MuiToggleButton-root': {
              px: 2,
              py: 0.5,
              fontSize: '0.78rem',
              fontWeight: 700,
              textTransform: 'none',
              color: 'text.secondary',
              border: '1px solid #dde3ea',
            },
            '& .MuiToggleButton-root.Mui-selected': {
              color: '#1565c0',
              backgroundColor: '#e3f2fd',
              borderColor: '#90caf9',
            },
          }}
        >
          {monitorTabs.map((tab) => (
            <ToggleButton key={tab.id} value={tab.id}>
              {tab.label}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>
      </Box>

      {/* Tab panels; the bottom padding keeps the page's floating button off the notes */}
      <Box sx={{ p: 1.5, pb: 8 }}>
        {!item ? (
          <Box sx={{ py: 4, textAlign: 'center' }}>
            <Typography variant="body2" color="text.secondary">
              点击上方产品行查看实时监控数据
            </Typography>
            <Typography variant="caption" color="text.disabled" sx={{ mt: 0.5, display: 'block' }}>
              支持到期收益、时间损耗、短期情景三张表
            </Typography>
          </Box>
        ) : (
          <>
            {activeTab === 'expiry' && (
              isFactorCert
                ? <UnavailableMessage reason="Factor Certificate 为 Open End 每日复位产品，不适用到期内在价值计算" />
                : hasStrike && hasRatio
                ? <ExpiryPnlTable key={productKey} item={item} direction={direction} hasSpot={hasSpot} onAddPnlRecord={handleAddPnlRecord} />
                : <UnavailableMessage reason="缺少行权价或比例(Bezugsverhältnis)数据" />
            )}
            {activeTab === 'time' && (
              isFactorCert
                ? <UnavailableMessage reason="Factor Certificate 没有普通期权 Theta；持有结果受每日复位、路径和融资成本影响" />
                : hasPrice
                ? <TimeDecayTable key={productKey} item={item} riskLeg={riskLeg} direction={direction} hasStrike={hasStrike} hasRatio={hasRatio} />
                : <UnavailableMessage reason="产品无当前报价" />
            )}
            {activeTab === 'drawdown' && (
              hasPrice && hasSpot
                ? <DrawdownTable key={productKey} item={item} onAddPnlRecord={handleAddPnlRecord} />
                : <UnavailableMessage reason={!hasSpot ? '缺少标的价格数据' : '产品无当前报价'} />
            )}
          </>
        )}
      </Box>
      <Snackbar
        open={pnlFeedback.open}
        autoHideDuration={1500}
        onClose={() => setPnlFeedback((current) => ({ ...current, open: false }))}
        message={pnlFeedback.message}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
        ContentProps={{
          sx: {
            fontWeight: 800,
            bgcolor: '#2a3547',
            boxShadow: '0 10px 28px rgba(42, 53, 71, 0.22)',
          },
        }}
      />
    </Box>
  )
}

// ---- header ----

function DashboardHeader({ item, direction, onClose }) {

  if (!item) {
    return (
      <Box sx={{ px: 1.5, py: 1, backgroundColor: '#f8fafc', borderBottom: '1px solid #e5eaef' }}>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center', justifyContent: 'space-between' }}>
          <Typography variant="body2" fontWeight={800} color="text.secondary">
            实时监控
          </Typography>
        </Stack>
      </Box>
    )
  }

  const name = item.stockName || item.symbol || '未知产品'
  const productType = item.productType
  const directionLabel = productType === 'factor_certificate'
    ? direction === 'put' ? 'SHORT' : 'LONG'
    : direction === 'call' ? 'CALL' : 'PUT'

  return (
    <Box sx={{ px: 1.5, py: 1, backgroundColor: '#f8fafc', borderBottom: '1px solid #e5eaef' }}>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', justifyContent: 'space-between', minWidth: 0 }}>
        <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', minWidth: 0, flex: 1 }}>
          <Typography variant="body2" fontWeight={800} noWrap sx={{ maxWidth: 320 }}>
            {name.split(' · ')[0]}
          </Typography>
          <Typography variant="caption" color="text.secondary" noWrap sx={{ flexShrink: 0 }}>
            {item.symbol}
          </Typography>
          {direction && (
            <Chip
              size="small"
              label={directionLabel}
              color={direction === 'call' ? 'success' : 'error'}
              variant="filled"
              sx={{ height: 18, '& .MuiChip-label': { px: 0.75, fontSize: '0.65rem', fontWeight: 700 } }}
            />
          )}
          {productType && PRODUCT_TYPE_LABELS[productType] && (
            <Chip
              size="small"
              label={PRODUCT_TYPE_LABELS[productType]}
              variant="outlined"
              sx={{ height: 18, '& .MuiChip-label': { px: 0.75, fontSize: '0.65rem' } }}
            />
          )}
        </Stack>
        <IconButton size="small" onClick={onClose} sx={{ width: 24, height: 24, flexShrink: 0 }}>
          <CloseRoundedIcon fontSize="small" />
        </IconButton>
      </Stack>
    </Box>
  )
}

// ---- context bar ----

function DashboardContextBar({ item, riskLeg, direction }) {
  if (!item) {
    return (
      <Box sx={{ px: 1.5, py: 0.75, borderBottom: '1px solid #e5eaef', backgroundColor: '#fafbfc' }}>
        <Typography variant="caption" color="text.disabled">选中产品后显示关键指标</Typography>
      </Box>
    )
  }

  const finiteOrNull = value => (value != null && Number.isFinite(Number(value)) ? Number(value) : null)
  const spot = finiteOrNull(item.underlyingSpot)
  const strike = finiteOrNull(item.strikePrice)
  const quantity = finiteOrNull(item.quantity)
  const dte = finiteOrNull(riskLeg?.daysToExpiry)
  const isFactorCert = item.productType === 'factor_certificate'
  const isOpenEnd = item.productType === 'open_end_turbo' || isFactorCert
  const marketValue = finiteOrNull(item.marketValue)
  const pnl = finiteOrNull(item.unrealizedPnl)
  const pnlPct = finiteOrNull(item.unrealizedPct)
  const delta = finiteOrNull(item.delta)
  const iv = finiteOrNull(item.iv)
  const leverage = finiteOrNull(item.leverage ?? item.effectiveLeverage)
  const resetBarrier = finiteOrNull(item.resetBarrier)
  const pnlColor = pnl == null ? undefined : pnl >= 0 ? 'success.main' : 'error.main'

  const tiles = [
    { label: '市值', value: marketValue == null ? '—' : oneDecimalCurrency.format(marketValue) },
    { label: '浮盈亏', value: pnl == null ? '—' : formatPnl(pnl), note: pnlPct == null ? null : formatPnlPct(pnlPct), color: pnlColor },
    { label: '距到期', value: dte != null ? `${dte} 天` : isOpenEnd ? '开放式' : '—', color: dte != null && dte < 30 ? 'error.main' : undefined },
    { label: 'Delta', value: delta == null ? '—' : number.format(delta) },
    isFactorCert
      ? { label: 'Factor', value: leverage == null ? '—' : `${oneDecimalNumber.format(leverage)}× ${direction === 'put' ? 'Short' : 'Long'}` }
      : { label: 'IV', value: iv == null ? '—' : `${Math.round(iv * 100)}%` },
    isFactorCert
      ? { label: '持仓', value: quantity == null ? '—' : number.format(quantity) }
      : { label: '杠杆', value: leverage == null ? '—' : `${oneDecimalNumber.format(leverage)}×` },
  ]
  const details = [
    spot != null ? ['标的', formatUnderlyingUsd(spot, item)] : null,
    strike != null ? [isFactorCert ? '基准价' : '行权价', formatStrikeDisplay(strike, item)] : null,
    isFactorCert && resetBarrier != null ? ['Reset Barrier', formatStrikeDisplay(resetBarrier, item)] : null,
    item.expiry ? ['到期', new Date(item.expiry).toLocaleDateString('de-DE', { dateStyle: 'medium' })] : null,
    quantity != null ? ['持仓', number.format(quantity)] : null,
    item.theta != null && Number.isFinite(Number(item.theta)) ? ['Theta', fxRateNumber.format(item.theta)] : null,
    item.currency && item.currency !== 'EUR' ? [`${item.currency}→EUR`, number.format(item.usdEurRate || FALLBACK_USD_EUR_RATE)] : null,
  ].filter(Boolean)

  // Six numbers people look for first, then the contract terms in one line.
  return (
    <Box sx={{ px: 1.5, pt: 1.25, pb: 1, borderBottom: '1px solid #e5eaef' }}>
      <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 0.75 }}>
        {tiles.map(tile => (
          <Box key={tile.label} sx={{ backgroundColor: '#f4f7fa', borderRadius: 1.5, px: 1, py: 0.75, minWidth: 0 }}>
            <Typography variant="caption" color="text.secondary" component="div" sx={{ fontSize: '0.68rem' }}>{tile.label}</Typography>
            <Typography variant="body2" fontWeight={800} noWrap sx={{ fontVariantNumeric: 'tabular-nums', color: tile.color }}>
              {tile.value}
              {tile.note ? <Box component="span" sx={{ fontWeight: 500, fontSize: '0.72rem', ml: 0.5 }}>{tile.note}</Box> : null}
            </Typography>
          </Box>
        ))}
      </Box>
      {details.length ? (
        <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 0.75, fontVariantNumeric: 'tabular-nums' }}>
          {details.map(([label, value]) => `${label} ${value}`).join(' · ')}
        </Typography>
      ) : null}
    </Box>
  )
}

// ---- unavailable ----

function UnavailableMessage({ reason }) {
  return (
    <Box sx={{ py: 3, textAlign: 'center' }}>
      <Typography variant="body2" color="text.secondary">{reason}</Typography>
    </Box>
  )
}

// ---- method chip ----

function MethodChip({ method }) {
  const meta = METHOD_META[method] || { label: method, color: 'default', description: '' }
  return (
    <Tooltip title={meta.description} arrow placement="top" slotProps={{ tooltip: { sx: { cursor: 'default' } } }}>
      <Chip
        size="small"
        label={meta.label}
        color={meta.color}
        variant="filled"
        sx={{ height: 18, '& .MuiChip-label': { px: 0.6, fontSize: '0.62rem', fontWeight: 700 } }}
      />
    </Tooltip>
  )
}

// ========================================================
// Tab 1: Expiry P&L
// ========================================================

function ExpiryPnlTable({ item, direction, hasSpot, onAddPnlRecord }) {
  const [addedRowId, setAddedRowId] = useState(null)
  const spot = Number(item?.underlyingSpot) || 0
  const spotUsd = underlyingEurToUsd(spot, item)
  const usdEurRate = usdRateForItem(item)
  const usdUnderlying = hasUsdUnderlying(item)
  const underlyingCurrencySymbol = usdUnderlying ? '$' : '€'
  const calcItem = useMemo(() => productCalculationItem(item), [item])
  const avgCost = Number(item?.avgCost ?? (item?.costBasis && item?.quantity ? item.costBasis / item.quantity : 0)) || 0
  const quantity = Number(item?.quantity) || 0

  const scenarioCurrency = usdUnderlying ? 'USD' : 'EUR'
  const scenarioSeedKey = `${item?.symbol || item?.id || ''}:${scenarioCurrency}:${spotUsd == null ? 'none' : roundOne(spotUsd)}`
  const buildDefaultScenarios = () => (
    DEFAULT_SCENARIO_PCTS.map((pct) => {
      if (hasSpot) {
        const priceEur = spot * (1 + pct / 100)
        const priceUsd = underlyingEurToUsd(priceEur, item)
        return {
          id: pct,
          pct,
          priceUsd: priceUsd == null ? null : Math.max(0, roundOne(priceUsd)),
        }
      }
      return { id: pct, pct, priceUsd: null }
    })
  )
  const [scenarioState, setScenarioState] = useState(() => ({
    key: scenarioSeedKey,
    currency: scenarioCurrency,
    values: buildDefaultScenarios(),
  }))

  useEffect(() => {
    setScenarioState((current) => {
      if (current.key === scenarioSeedKey) return current
      const hasUserScenarioPrices = current.values.some((scenario) => scenario.priceUsd != null)
      if (hasUserScenarioPrices && current.currency === scenarioCurrency) {
        return current
      }
      return {
        key: scenarioSeedKey,
        currency: scenarioCurrency,
        values: buildDefaultScenarios(),
      }
    })
  }, [scenarioCurrency, scenarioSeedKey])

  const scenarios = scenarioState.values

  const rows = useMemo(() => (
    scenarios.map((scenario) => {
      const scenarioPriceEur = underlyingUsdToEur(scenario.priceUsd, item)
      const result = scenarioPriceEur == null
        ? null
        : calculateExpiryPnl(calcItem, scenarioPriceEur)
      return {
        ...scenario,
        label: scenario.pct > 0 ? `+${oneDecimalNumber.format(scenario.pct)}%` : `${oneDecimalNumber.format(scenario.pct)}%`,
        result,
        isCurrent: Math.abs(Number(scenario.pct) || 0) < 0.05,
      }
    })
  ), [calcItem, item, scenarios])

  const updateScenarioPrice = (id, value) => {
    setScenarioState((current) => ({
      ...current,
      values: current.values.map((scenario) => {
        if (scenario.id !== id) return scenario
        if (value == null) return { ...scenario, priceUsd: null, pct: null }
        const priceUsd = Math.max(0, value)
        const pct = spotUsd && spotUsd > 0 ? ((priceUsd / spotUsd) - 1) * 100 : 0
        return { ...scenario, priceUsd: roundOne(priceUsd), pct: roundOne(pct) }
      }),
    }))
  }

  const updateScenarioPct = (id, value) => {
    setScenarioState((current) => ({
      ...current,
      values: current.values.map((scenario) => {
        if (scenario.id !== id) return scenario
        if (value == null) return { ...scenario, pct: null, priceUsd: null }
        const pct = value
        const priceUsd = spotUsd && spotUsd > 0 ? Math.max(0, spotUsd * (1 + pct / 100)) : null
        return { ...scenario, pct: roundOne(pct), priceUsd: priceUsd == null ? null : roundOne(priceUsd) }
      }),
    }))
  }

  const addRowToSimulator = (row) => {
    const record = buildPnlRecord('expiry', item, row)
    if (!record) return
    onAddPnlRecord?.(record)
    setAddedRowId(row.id)
    window.setTimeout(() => setAddedRowId((current) => (current === row.id ? null : current)), 650)
  }

  return (
    <Stack spacing={1.5}>
      <TableContainer sx={{ border: '1px solid #e5eaef', borderRadius: 1, overflowX: 'auto' }}>
        <Table size="small" sx={{ tableLayout: 'fixed', minWidth: 380 }}>
          <colgroup><col style={{ width: '28%' }} /><col style={{ width: '24%' }} /><col style={{ width: '20%' }} /><col style={{ width: '28%' }} /></colgroup>
          <TableHead>
            <TableRow sx={{ backgroundColor: '#f8fafc' }}>
              <TableCell sx={thSx}>标的价格 ({underlyingCurrencySymbol})</TableCell>
              <TableCell sx={thSx}>变动</TableCell>
              <TableCell sx={thSx}>内在价值</TableCell>
              <TableCell sx={{ ...thSx, textAlign: 'right' }}>到期 P&L</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.map((row) => (
              <TableRow
                key={row.id}
                hover={Boolean(row.result)}
                onClick={() => addRowToSimulator(row)}
                sx={{
                  cursor: row.result ? 'pointer' : 'default',
                  backgroundColor: row.isCurrent ? '#f0f7ff' : undefined,
                  ...(addedRowId === row.id && {
                    animation: `${rowAddedPulse} 650ms ease-out`,
                  }),
                }}
              >
                <TableCell sx={tdSx}>
                  <Box onClick={(event) => event.stopPropagation()}>
                    <NumberField
                      compact
                      ariaLabel="情景价格"
                      value={row.priceUsd}
                      onChange={(value) => updateScenarioPrice(row.id, value)}
                      width="100%"
                      inputSx={{ fontWeight: row.isCurrent ? 800 : 500 }}
                    />
                  </Box>
                </TableCell>
                <TableCell sx={tdSx}>
                  <Box onClick={(event) => event.stopPropagation()}>
                    <NumberField
                      compact
                      ariaLabel="变动百分比"
                      value={row.pct}
                      onChange={(value) => updateScenarioPct(row.id, value)}
                      suffix="%"
                      width="100%"
                      inputSx={{ fontWeight: row.isCurrent ? 800 : 500 }}
                      format={{ signDisplay: 'exceptZero' }}
                    />
                  </Box>
                </TableCell>
                <TableCell sx={tdSx}>
                  <TwoLine main={row.result ? oneDecimalCurrency.format(row.result.intrinsic) : null} />
                </TableCell>
                <TableCell sx={{ ...tdSx, textAlign: 'right' }}>
                  <TwoLine
                    bold
                    main={row.result ? formatPnl(row.result.pnl) : null}
                    sub={row.result ? formatPnlPct(row.result.pnlPct) : null}
                    color={row.result ? signColor(row.result.pnl) : undefined}
                  />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>

      {/* Formula hint */}
      <Typography variant="caption" color="text.secondary">
        {direction === 'call'
          ? `公式: 内在价值 = max(0, 标的价格EUR − 行权价EUR) × ${oneDecimalNumber.format(item.ratio)}；显示价按 USD→EUR ${fxRateNumber.format(usdEurRate)} 换算`
          : `公式: 内在价值 = max(0, 行权价EUR − 标的价格EUR) × ${oneDecimalNumber.format(item.ratio)}；显示价按 USD→EUR ${fxRateNumber.format(usdEurRate)} 换算`}
        ；P&L = (内在价值 − 均价 {oneDecimalCurrency.format(avgCost)}) × {oneDecimalNumber.format(quantity)} 份
      </Typography>
    </Stack>
  )
}

// ========================================================
// Tab 2: Time Decay
// ========================================================

function TimeDecayTable({ item, riskLeg, direction, hasStrike, hasRatio }) {
  const dte = riskLeg?.daysToExpiry ?? daysUntil(item?.expiry)
  const quantity = Number(item?.quantity) || 0
  const calcItem = useMemo(() => productCalculationItem(item), [item])

  const periods = useMemo(() => getTimeDecayPeriods(dte), [dte])

  const rows = useMemo(() => (
    periods.map((period) => {
      const result = calculateTimeDecay(calcItem, period.days)
      return { ...period, result }
    })
  ), [calcItem, periods])

  const hasAnyResult = rows.some((r) => r.result != null)

  if (!hasAnyResult) {
    return <UnavailableMessage reason="无法计算时间损耗 — 缺少价格或到期日数据" />
  }

  return (
    <Stack spacing={1.5}>
      <TableContainer sx={{ border: '1px solid #e5eaef', borderRadius: 1, overflowX: 'auto' }}>
        <Table size="small" sx={{ tableLayout: 'fixed', minWidth: 360 }}>
          <colgroup><col style={{ width: '26%' }} /><col style={{ width: '28%' }} /><col style={{ width: '26%' }} /><col style={{ width: '20%' }} /></colgroup>
          <TableHead>
            <TableRow sx={{ backgroundColor: '#f8fafc' }}>
              <TableCell sx={thSx}>期间</TableCell>
              <TableCell sx={thSx}>产品价格</TableCell>
              <TableCell sx={{ ...thSx, textAlign: 'right' }}>持仓 P&L</TableCell>
              <TableCell sx={thSx}>方法</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.days}>
                <TableCell sx={tdSx}>
                  <TwoLine bold main={row.label} sub={row.result?.days != null ? `${row.result.days} 天` : null} subColor="text.secondary" />
                </TableCell>
                <TableCell sx={tdSx}>
                  <TwoLine
                    main={row.result ? oneDecimalCurrency.format(row.result.newPrice) : null}
                    sub={row.result ? formatPnl(row.result.priceChange) : null}
                    color="text.primary"
                    subColor={row.result ? signColor(row.result.priceChange, true) : undefined}
                  />
                </TableCell>
                <TableCell sx={{ ...tdSx, textAlign: 'right' }}>
                  <TwoLine bold main={row.result ? formatPnl(row.result.pnlChange) : null} color={row.result ? signColor(row.result.pnlChange, true) : undefined} />
                </TableCell>
                <TableCell sx={tdSx}>
                  {row.result ? <MethodChip method={row.result.method} /> : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>

      {/* Context */}
      <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap' }}>
        {item.price != null && (
          <Typography variant="caption" color="text.secondary">
            当前价格: <b>{oneDecimalCurrency.format(item.price)}</b>
          </Typography>
        )}
        {item.theta != null && Number.isFinite(Number(item.theta)) && (
          <Typography variant="caption" color="text.secondary">
            Theta: <b>{fxRateNumber.format(item.theta)}</b>
          </Typography>
        )}
        {dte != null && (
          <Typography variant="caption" color="text.secondary">
            距到期: <b>{dte}天</b>
          </Typography>
        )}
      </Box>

      <Typography variant="caption" color="text.secondary">
        时间价值衰减估算 — 假设标的价格不变。有 Theta 时优先使用 Theta；否则用时间价值线性摊销；最差情况用简化近似。
      </Typography>
    </Stack>
  )
}

// ========================================================
// Tab 3: Short-Term Scenarios
// ========================================================

function DrawdownTable({ item, onAddPnlRecord }) {
  const [addedRowId, setAddedRowId] = useState(null)
  const spot = Number(item?.underlyingSpot) || 0
  const quantity = Number(item?.quantity) || 0
  const [scenarios, setScenarios] = useState(() => (
    DEFAULT_SCENARIO_PCTS.map((pct) => ({ id: pct, pct }))
  ))
  const calcItem = useMemo(() => productCalculationItem(item), [item])
  const isFactorCert = item?.productType === 'factor_certificate'

  const rows = useMemo(() => (
    scenarios.map((scenario) => {
      const result = scenario.pct == null ? null : calculateDrawdown(calcItem, scenario.pct)
      return { ...scenario, result }
    })
  ), [calcItem, scenarios])

  const updateScenarioPct = (id, value) => {
    setScenarios((current) => current.map((scenario) => (
      scenario.id === id
        ? { ...scenario, pct: value == null ? null : roundOne(value) }
        : scenario
    )))
  }

  const hasAnyResult = rows.some((r) => r.result != null)

  if (!hasAnyResult) {
    return <UnavailableMessage reason="无法计算短期情景 — 缺少价格和标的价格数据" />
  }

  const addRowToSimulator = (row) => {
    const record = buildPnlRecord('drawdown', item, row)
    if (!record) return
    onAddPnlRecord?.(record)
    setAddedRowId(row.id)
    window.setTimeout(() => setAddedRowId((current) => (current === row.id ? null : current)), 650)
  }

  return (
    <Stack spacing={1.5}>
      <TableContainer sx={{ border: '1px solid #e5eaef', borderRadius: 1, overflowX: 'auto' }}>
        <Table size="small" sx={{ tableLayout: 'fixed', minWidth: 380 }}>
          <colgroup><col style={{ width: '27%' }} /><col style={{ width: '27%' }} /><col style={{ width: '27%' }} /><col style={{ width: '19%' }} /></colgroup>
          <TableHead>
            <TableRow sx={{ backgroundColor: '#f8fafc' }}>
              <TableCell sx={thSx}>标的变动 → 价格</TableCell>
              <TableCell sx={thSx}>产品价格</TableCell>
              <TableCell sx={{ ...thSx, textAlign: 'right' }}>P&L</TableCell>
              <TableCell sx={thSx}>方法</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.map((row) => {
              return (
                <TableRow
                  key={row.id}
                  hover={Boolean(row.result)}
                  onClick={() => addRowToSimulator(row)}
                  sx={{
                    cursor: row.result ? 'pointer' : 'default',
                    ...(addedRowId === row.id && {
                      animation: `${rowAddedPulse} 650ms ease-out`,
                    }),
                  }}
                >
                  <TableCell sx={tdSx}>
                    <Box onClick={(event) => event.stopPropagation()}>
                      <NumberField
                        compact
                        ariaLabel="标的变动百分比"
                        value={row.pct}
                        onChange={(value) => updateScenarioPct(row.id, value)}
                        suffix="%"
                        width="100%"
                        inputSx={{
                          fontWeight: Math.abs(Number(row.pct) || 0) < 0.05 ? 800 : 500,
                          '& .MuiOutlinedInput-input': {
                            color: row.pct < 0 ? 'error.main' : row.pct > 0 ? 'success.main' : 'text.primary',
                          },
                        }}
                        format={{ signDisplay: 'exceptZero' }}
                      />
                    </Box>
                    {row.result ? (
                      <Typography variant="caption" color="text.secondary" component="div" sx={{ fontSize: '0.68rem', mt: 0.25, fontVariantNumeric: 'tabular-nums' }}>
                        → {formatUnderlyingUsd(row.result.newSpot, item)}
                      </Typography>
                    ) : null}
                  </TableCell>
                  <TableCell sx={tdSx}>
                    <TwoLine
                      main={row.result ? oneDecimalCurrency.format(row.result.newPrice) : null}
                      sub={row.result ? formatPnl(row.result.priceChange) : null}
                      color="text.primary"
                      subColor={row.result ? signColor(row.result.priceChange, true) : undefined}
                    />
                  </TableCell>
                  <TableCell sx={{ ...tdSx, textAlign: 'right' }}>
                    <TwoLine
                      bold
                      main={row.result ? formatPnl(row.result.pnl) : null}
                      sub={row.result?.pnlPct != null ? formatPnlPct(row.result.pnlPct) : null}
                      color={row.result ? signColor(row.result.pnl, true) : undefined}
                    />
                  </TableCell>
                  <TableCell sx={tdSx}>
                    {row.result ? <MethodChip method={row.result.method} /> : null}
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </TableContainer>

      {/* Context */}
      <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap' }}>
        {item.price != null && (
          <Typography variant="caption" color="text.secondary">
            当前价格: <b>{oneDecimalCurrency.format(item.price)}</b>
          </Typography>
        )}
        {item.delta != null && Number.isFinite(Number(item.delta)) && (
          <Typography variant="caption" color="text.secondary">
            Delta: <b>{oneDecimalNumber.format(item.delta)}</b>
          </Typography>
        )}
        {item.omega != null && Number.isFinite(Number(item.omega)) && (
          <Typography variant="caption" color="text.secondary">
            Omega: <b>{oneDecimalNumber.format(item.omega)}</b>
          </Typography>
        )}
        {isFactorCert && item.leverage != null && Number.isFinite(Number(item.leverage)) && (
          <Typography variant="caption" color="text.secondary">
            Factor: <b>{oneDecimalNumber.format(item.leverage)}× {getOptionDirection(item) === 'put' ? 'Short' : 'Long'}</b>
          </Typography>
        )}
        {isFactorCert && item.resetBarrier != null && Number.isFinite(Number(item.resetBarrier)) && (
          <Typography variant="caption" color="text.secondary">
            Reset Barrier: <b>{formatStrikeDisplay(item.resetBarrier, item)}</b>
          </Typography>
        )}
        <Typography variant="caption" color="text.secondary">
          标的价格: <b>{formatUnderlyingUsd(spot, item)}</b>
        </Typography>
      </Box>

      <Typography variant="caption" color="text.secondary">
        {isFactorCert
          ? 'Factor 单周期情景估算 — 按当前产品价格 × (1 + 方向 × Factor × 标的涨跌幅) 计算。产品每日复位且具有路径依赖；多日实际结果还受盘中调整、融资成本和发行人定价影响。'
          : '短期情景估算 — 假设当前剩余时间价值仍在。优先使用 Delta 估算；无 Delta 时用 Omega；均无时用内在价值近似。注意：Delta 线性估算忽略 Gamma 曲率效应，实际大幅波动时偏差较大。'}
      </Typography>
    </Stack>
  )
}

// ---- shared table styles ----

// A value with a smaller second line, so one column can carry two numbers.
function TwoLine({ main, sub, color, subColor, bold = false }) {
  if (main == null) return <Typography variant="body2" color="text.disabled">—</Typography>
  return (
    <Box sx={{ fontVariantNumeric: 'tabular-nums' }}>
      <Typography variant="body2" fontWeight={bold ? 700 : 400} sx={{ color, fontSize: '0.78rem' }} noWrap>{main}</Typography>
      {sub != null ? <Typography variant="caption" component="div" sx={{ color: subColor ?? color ?? 'text.secondary', fontSize: '0.68rem' }} noWrap>{sub}</Typography> : null}
    </Box>
  )
}

const signColor = (value, zeroIsLoss = false) => (value > 0 || (!zeroIsLoss && value === 0) ? 'success.main' : 'error.main')

const thSx = {
  py: 0.75,
  px: 1,
  fontSize: '0.7rem',
  fontWeight: 800,
  color: 'text.secondary',
  borderBottom: '1px solid #e5eaef',
  backgroundColor: '#f8fafc',
}

const tdSx = {
  py: 0.75,
  px: 1,
  fontSize: '0.78rem',
  borderBottom: '1px solid #f0f2f5',
  fontVariantNumeric: 'tabular-nums',
}
