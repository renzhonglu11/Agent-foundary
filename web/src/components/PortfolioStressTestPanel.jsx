import { useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material'
import AutoAwesomeRoundedIcon from '@mui/icons-material/AutoAwesomeRounded'
import BalanceRoundedIcon from '@mui/icons-material/BalanceRounded'
import BoltRoundedIcon from '@mui/icons-material/BoltRounded'
import QueryStatsRoundedIcon from '@mui/icons-material/QueryStatsRounded'
import ShieldRoundedIcon from '@mui/icons-material/ShieldRounded'

import { compactCurrency, number } from '../utils/formatters.js'
import {
  PORTFOLIO_STRESS_HORIZONS,
  buildHermesStressReviewPayload,
  buildPortfolioStressReport,
} from '../utils/portfolioStress.js'

const kindMeta = {
  baseline: { color: 'default', icon: QueryStatsRoundedIcon },
  defensive: { color: 'success', icon: ShieldRoundedIcon },
  balanced: { color: 'primary', icon: BalanceRoundedIcon },
  elastic: { color: 'warning', icon: BoltRoundedIcon },
}

const confidenceLabels = {
  live_delta: '实时 Delta',
  estimated_delta: '估算 Delta',
  estimated_omega: '估算 Omega',
  estimated_leverage: '估算杠杆',
  estimated_market_value: '市值估算',
  no_data: '低置信度',
}

const productTypeLabels = {
  optionsschein: '权证',
  open_end_turbo: 'Turbo',
  knock_out: 'Knock-out',
  factor_certificate: 'Factor',
}

const selectionFlagLabels = {
  WATCH_PENALIZED: 'WATCH 降权',
  ELASTIC_ONLY: '仅高弹性',
  EXPOSURE_CAPPED_8_PCT: '敞口限至 8%',
}

function signedPercent(value) {
  const numeric = Number(value) || 0
  return `${numeric > 0 ? '+' : ''}${number.format(numeric)}%`
}

function pnlColor(value) {
  if (value > 0) return 'success.main'
  if (value < 0) return 'error.main'
  return 'text.secondary'
}

export default function PortfolioStressTestPanel({ entries, loading, totalMarketValue, totalCostBasis }) {
  const [horizonDays, setHorizonDays] = useState(30)
  const [selectedPortfolioId, setSelectedPortfolioId] = useState(null)
  const [hermesStatus, setHermesStatus] = useState({ loading: true, available: null, model: null })
  const [hermesReview, setHermesReview] = useState({ loading: false, data: null, error: null })
  const report = useMemo(
    () => buildPortfolioStressReport(entries, horizonDays, undefined, { totalMarketValue, totalCostBasis }),
    [entries, horizonDays, totalMarketValue, totalCostBasis],
  )

  const defaultPortfolioId = report.portfolios.find((portfolio) => portfolio.kind === 'balanced')?.id
    || report.portfolios[0]?.id
    || null
  const resolvedPortfolioId = report.portfolios.some((portfolio) => portfolio.id === selectedPortfolioId)
    ? selectedPortfolioId
    : defaultPortfolioId
  const selectedPortfolio = report.portfolios.find((portfolio) => portfolio.id === resolvedPortfolioId) || null

  useEffect(() => {
    const controller = new AbortController()
    fetch('/api/portfolio-stress/hermes-review', { cache: 'no-store', signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`Hermes 状态请求失败: ${response.status}`)
        return response.json()
      })
      .then((payload) => {
        setHermesStatus({ loading: false, available: Boolean(payload?.available), model: payload?.model || null })
      })
      .catch((error) => {
        if (error.name === 'AbortError') return
        setHermesStatus({ loading: false, available: false, model: null })
      })
    return () => controller.abort()
  }, [])

  const handleHorizonChange = (nextHorizon) => {
    setHorizonDays(nextHorizon)
    setSelectedPortfolioId(null)
    setHermesReview({ loading: false, data: null, error: null })
  }

  const requestHermesReview = async () => {
    setHermesReview({ loading: true, data: null, error: null })
    try {
      const response = await fetch('/api/portfolio-stress/hermes-review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildHermesStressReviewPayload(report)),
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(payload?.error || `Hermes 请求失败: ${response.status}`)
      if (!payload?.available) {
        setHermesStatus((current) => ({ ...current, loading: false, available: false }))
        throw new Error(payload?.unavailableReason || '当前环境未安装 Hermes')
      }
      setHermesReview({ loading: false, data: payload, error: null })
      const preferredId = payload.selectedPortfolioIds?.[0]
      if (preferredId && report.portfolios.some((portfolio) => portfolio.id === preferredId)) {
        setSelectedPortfolioId(preferredId)
      }
    } catch (error) {
      setHermesReview({ loading: false, data: null, error })
    }
  }

  if (loading && !report.portfolios.length) {
    return <Box sx={{ py: 3, textAlign: 'center' }}><CircularProgress size={24} /></Box>
  }

  if (!report.portfolios.length) {
    return (
      <Alert severity="info">
        当前没有同时具备产品报价、持仓数量和标的价格的 Tier 1 产品，暂时无法生成组合压力测试。
      </Alert>
    )
  }

  const hermesRankById = new Map(
    (hermesReview.data?.selectedPortfolioIds || []).map((id, index) => [id, index + 1]),
  )
  const hermesReviewById = new Map(
    (hermesReview.data?.reviews || []).map((review) => [review.portfolioId, review]),
  )
  const selectedHermesReview = selectedPortfolio ? hermesReviewById.get(selectedPortfolio.id) : null

  return (
    <Box sx={{ border: '1px solid #dfe6ee', borderRadius: 2, overflow: 'hidden', backgroundColor: '#fbfdff' }}>
      <Stack
        direction={{ xs: 'column', md: 'row' }}
        spacing={1.25}
        sx={{ px: { xs: 1.5, md: 2 }, py: 1.5, justifyContent: 'space-between', alignItems: { xs: 'stretch', md: 'center' } }}
      >
        <Box>
          <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
            <Typography variant="subtitle1" fontWeight={900}>组合压力测试</Typography>
            <Chip size="small" label="无历史概率" variant="outlined" sx={{ height: 20 }} />
            <Chip size="small" label={`${report.eligibleProductCount}/${report.productCount} 可入选`} variant="outlined" sx={{ height: 20 }} />
          </Stack>
          <Typography variant="caption" color="text.secondary">
            所有标的同步承受五档冲击；结果是压力区间，不是预期收益或盈利概率。
          </Typography>
        </Box>

        <Stack direction="row" spacing={0.75} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
          {PORTFOLIO_STRESS_HORIZONS.map((days) => (
            <Button
              key={days}
              size="small"
              variant={horizonDays === days ? 'contained' : 'outlined'}
              onClick={() => handleHorizonChange(days)}
              sx={{ minWidth: 56, textTransform: 'none' }}
            >
              {days} 天
            </Button>
          ))}
          <Chip
            size="small"
            color={hermesStatus.available ? 'success' : 'default'}
            variant="outlined"
            label={hermesStatus.loading
              ? '检查 Hermes…'
              : hermesStatus.available
                ? `${hermesStatus.model || '就绪'}`
                : '本地量化模式'}
          />
          <Button
            size="small"
            variant="contained"
            color="secondary"
            startIcon={hermesReview.loading
              ? <CircularProgress size={14} color="inherit" aria-label="Hermes 评审中" />
              : <AutoAwesomeRoundedIcon />}
            disabled={!hermesStatus.available || hermesReview.loading || report.portfolios.length < 2}
            onClick={requestHermesReview}
            sx={{ textTransform: 'none' }}
          >
            {hermesReview.loading ? 'Hermes 评审中…' : 'Hermes 评审'}
          </Button>
        </Stack>
      </Stack>

      <Divider />

      <Box sx={{ p: { xs: 1.25, md: 1.75 } }}>
        {report.excludedProductCount > 0
          || report.watchIncludedProductCount > 0
          || report.exposureCappedProductCount > 0 ? (
          <Alert severity="warning" sx={{ mb: 1.5, py: 0 }}>
            风险分层：{report.excludedProductCount} 个旧合约或数据不可信产品不进入候选；
            {report.watchIncludedProductCount} 个 WATCH 按触发原因降权，临近障碍的产品仅可进入高弹性组合；
            {report.exposureCappedProductCount} 个集中仓位按 8% NAV 风险敞口比例缩放。
            {report.rollOpportunities?.length
              ? ` ${report.rollOpportunities.length} 个 ROLL 旧合约已登记为换仓机会，需要同标的远期产品数据才能建立替代仓。`
              : ''}
          </Alert>
        ) : null}
        {hermesReview.error ? (
          <Alert severity="info" sx={{ mb: 1.5, py: 0 }}>
            {hermesReview.error.message}。确定性压力测试仍可正常使用。
          </Alert>
        ) : null}
        {hermesReview.data?.summary ? (
          <Alert severity="success" icon={<AutoAwesomeRoundedIcon />} sx={{ mb: 1.5 }}>
            <Typography variant="body2" fontWeight={700}>Hermes 结论</Typography>
            <Typography variant="body2">{hermesReview.data.summary}</Typography>
          </Alert>
        ) : null}

        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, minmax(0, 1fr))', xl: 'repeat(4, minmax(0, 1fr))' }, gap: 1.25 }}>
          {report.portfolios.map((portfolio) => {
            const meta = kindMeta[portfolio.kind] || kindMeta.baseline
            const Icon = meta.icon
            const selected = portfolio.id === resolvedPortfolioId
            const hermesRank = hermesRankById.get(portfolio.id)
            return (
              <Paper
                key={portfolio.id}
                component="button"
                type="button"
                onClick={() => setSelectedPortfolioId(portfolio.id)}
                elevation={selected ? 3 : 0}
                sx={{
                  p: 1.5,
                  border: '1px solid',
                  borderColor: selected ? `${meta.color}.main` : '#dfe6ee',
                  borderRadius: 2,
                  backgroundColor: selected ? '#ffffff' : '#f8fafc',
                  textAlign: 'left',
                  color: 'inherit',
                  cursor: 'pointer',
                  width: '100%',
                  font: 'inherit',
                  '&:hover': { borderColor: `${meta.color}.main`, backgroundColor: '#ffffff' },
                }}
              >
                <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', justifyContent: 'space-between' }}>
                  <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', minWidth: 0 }}>
                    <Icon fontSize="small" color={meta.color} />
                    <Typography variant="body2" fontWeight={900} noWrap>{portfolio.title}</Typography>
                  </Stack>
                  {hermesRank ? <Chip size="small" color="secondary" label={`Hermes #${hermesRank}`} sx={{ height: 19 }} /> : null}
                </Stack>
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5, minHeight: 34 }}>
                  {portfolio.description}
                </Typography>
                <Stack direction="row" spacing={1} sx={{ mt: 1, justifyContent: 'space-between' }}>
                  <Metric label="最差" value={compactCurrency(portfolio.worstPnl)} color="error.main" />
                  <Metric label="最好" value={compactCurrency(portfolio.bestPnl)} color="success.main" />
                  <Metric label="横盘" value={compactCurrency(portfolio.flatPnl)} color={pnlColor(portfolio.flatPnl)} />
                </Stack>
                <Stack direction="row" spacing={0.75} useFlexGap sx={{ mt: 1, flexWrap: 'wrap' }}>
                  <Chip size="small" variant="outlined" label={`${portfolio.productCount} 产品`} sx={{ height: 19 }} />
                  <Chip size="small" variant="outlined" label={`${portfolio.groupCount} 标的`} sx={{ height: 19 }} />
                  <Chip size="small" variant="outlined" label={`${portfolio.scenarioCoveragePct}% 正收益情景`} sx={{ height: 19 }} />
                </Stack>
              </Paper>
            )
          })}
        </Box>

        {selectedPortfolio ? (
          <Box sx={{ mt: 1.5, display: 'grid', gridTemplateColumns: { xs: '1fr', lg: 'minmax(0, 1fr) minmax(0, 1.25fr)' }, gap: 1.25 }}>
            <Paper variant="outlined" sx={{ borderRadius: 2, overflow: 'hidden' }}>
              <Box sx={{ px: 1.5, py: 1, backgroundColor: '#f8fafc' }}>
                <Typography variant="body2" fontWeight={900}>{selectedPortfolio.title} · {horizonDays} 天情景</Typography>
                <Typography variant="caption" color="text.secondary">
                  情景市值 {compactCurrency(selectedPortfolio.currentValue)}；占总资产 {number.format(selectedPortfolio.navWeightPct)}%；
                  占成本本金 {number.format(selectedPortfolio.capitalWeightPct)}%；最差情景 {selectedPortfolio.worstScenarioLabel}。
                </Typography>
              </Box>
              <TableContainer>
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell>联合情景</TableCell>
                      <TableCell align="right">P&amp;L</TableCell>
                      <TableCell align="right">组合回报</TableCell>
                      <TableCell align="right">障碍触发</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {selectedPortfolio.scenarioResults.map((scenario) => (
                      <TableRow key={scenario.id} sx={{ backgroundColor: scenario.id === 'flat' ? '#f8fafc' : undefined }}>
                        <TableCell><Typography variant="body2" fontWeight={scenario.id === 'flat' ? 800 : 500}>{scenario.label}</Typography></TableCell>
                        <TableCell align="right"><Typography variant="body2" fontWeight={700} color={pnlColor(scenario.pnl)}>{compactCurrency(scenario.pnl)}</Typography></TableCell>
                        <TableCell align="right"><Typography variant="body2" color={pnlColor(scenario.returnPct)}>{signedPercent(scenario.returnPct)}</Typography></TableCell>
                        <TableCell align="right">{scenario.barrierBreaches || '—'}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
              {selectedHermesReview ? (
                <Alert severity={selectedHermesReview.verdict === '谨慎' ? 'warning' : 'info'} sx={{ m: 1.25 }}>
                  <Typography variant="body2" fontWeight={800}>{selectedHermesReview.verdict}</Typography>
                  <Typography variant="body2">{selectedHermesReview.reason}</Typography>
                  {selectedHermesReview.risks?.length ? (
                    <Typography variant="caption" color="text.secondary">风险：{selectedHermesReview.risks.join('；')}</Typography>
                  ) : null}
                </Alert>
              ) : null}
            </Paper>

            <Paper variant="outlined" sx={{ borderRadius: 2, overflow: 'hidden' }}>
              <Box sx={{ px: 1.5, py: 1, backgroundColor: '#f8fafc' }}>
                <Typography variant="body2" fontWeight={900}>组合产品与情景权重</Typography>
                <Typography variant="caption" color="text.secondary">
                  {selectedPortfolio.kind === 'baseline'
                    ? '当前基准沿用实际持仓数量。'
                    : '候选组合对超过 8% NAV 的单品风险敞口按比例缩放；只用于情景建模，未生成交易数量。'}
                </Typography>
              </Box>
              <TableContainer sx={{ maxHeight: 360 }}>
                <Table size="small" stickyHeader>
                  <TableHead>
                    <TableRow>
                      <TableCell>产品</TableCell>
                      <TableCell>标的</TableCell>
                      <TableCell>风险处理 / 置信度</TableCell>
                      <TableCell align="right">组合 / 总资产 / 本金</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {selectedPortfolio.products.map((product) => (
                      <TableRow key={product.id}>
                        <TableCell sx={{ maxWidth: 240 }}>
                          <Typography variant="body2" fontWeight={700} noWrap>{product.name}</Typography>
                          <Typography variant="caption" color="text.secondary">{productTypeLabels[product.productType] || product.productType}</Typography>
                        </TableCell>
                        <TableCell><Typography variant="body2" noWrap>{product.groupName}</Typography></TableCell>
                        <TableCell>
                          <Stack direction="row" spacing={0.5} useFlexGap sx={{ flexWrap: 'wrap' }}>
                            <Chip size="small" variant="outlined" label={confidenceLabels[product.confidence] || product.confidence} sx={{ height: 19 }} />
                            {(product.selectionFlags || []).map((flag) => (
                              <Chip
                                key={flag}
                                size="small"
                                color={flag === 'ELASTIC_ONLY' ? 'warning' : 'default'}
                                variant="outlined"
                                label={selectionFlagLabels[flag] || flag}
                                sx={{ height: 19 }}
                              />
                            ))}
                          </Stack>
                        </TableCell>
                        <TableCell align="right">
                          <Typography variant="body2">组合内 {number.format(product.allocationPct)}%</Typography>
                          <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                            总资产 {number.format(product.navWeightPct)}% · 本金 {number.format(product.capitalWeightPct)}%
                          </Typography>
                          {product.positionScalePct < 100 ? (
                            <Typography variant="caption" color="warning.main">采用原仓位的 {number.format(product.positionScalePct)}%</Typography>
                          ) : null}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            </Paper>
          </Box>
        ) : null}

        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1.25 }}>
          计算口径：权证使用 Delta/Omega 与时间损耗近似，到期窗口使用内在价值；Turbo 在终点情景跨越障碍时按归零压力处理；Factor 使用方向化杠杆近似。未模拟盘中路径、发行人信用和买卖价差。
        </Typography>
      </Box>
    </Box>
  )
}

function Metric({ label, value, color }) {
  return (
    <Box sx={{ minWidth: 0 }}>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>{label}</Typography>
      <Typography variant="body2" fontWeight={900} color={color} noWrap>{value}</Typography>
    </Box>
  )
}
