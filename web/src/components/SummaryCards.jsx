import { useState } from 'react'
import { Card, CardContent, Chip, Grid, LinearProgress, Stack, Tooltip, Typography, Box, useTheme } from '@mui/material'
import TrendingUpRoundedIcon from '@mui/icons-material/TrendingUpRounded'
import AccountBalanceWalletRoundedIcon from '@mui/icons-material/AccountBalanceWalletRounded'
import SavingsRoundedIcon from '@mui/icons-material/SavingsRounded'
import ReceiptLongRoundedIcon from '@mui/icons-material/ReceiptLongRounded'
import PaidRoundedIcon from '@mui/icons-material/PaidRounded'
import HelpOutlineRoundedIcon from '@mui/icons-material/HelpOutlineRounded'
import { currency, percent, preciseCurrency, pnlColor } from '../utils/formatters.js'

function StatPill({ label, value, color }) {
    return (
        <Stack direction="row" spacing={1.25} sx={{ justifyContent: 'space-between', alignItems: 'center' }}>
            <Typography variant="body2" color="text.secondary">{label}</Typography>
            <Typography variant="caption" fontWeight={700} color={color}>{value}</Typography>
        </Stack>
    )
}

function PortfolioValueCard({ summary }) {
    const theme = useTheme()
    const investedRatio = summary.totalMarketValue > 0
        ? Math.min(100, Math.max(0, (summary.totalCostBasis / summary.totalMarketValue) * 100))
        : 0

    return (
        <Card className="metric-card" sx={{ height: 'auto' }}>
            <CardContent sx={{ px: 1.25, pt: 1.25, pb: 1.65, '&:last-child': { pb: 1.65 } }}>
                <Stack spacing={0.65}>
                    <Stack direction="row" spacing={1.25} sx={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
                        <Box>

                            <Typography variant="h5" mt={0.1} fontWeight={900}>
                                <Box component="span" sx={{ fontWeight: 900, mr: 0.75 }}>总资产</Box>
                                {currency.format(summary.totalMarketValue)}
                            </Typography>
                            <Typography color="text.secondary" variant="caption" mt={0.1}>估算持仓市值 · {summary.openPositions} 个开放仓位</Typography>
                        </Box>
                        <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', flexShrink: 0 }}>
                            <Stack direction="row" spacing={0.5} sx={{ flexWrap: 'wrap', justifyContent: 'flex-end', alignItems: 'center', rowGap: 0.5, maxWidth: 152, '& .MuiChip-root': { height: 22 }, '& .MuiChip-label': { px: 0.75, fontSize: 11 } }}>
                                <Chip size="small" color="success" variant="outlined" label={`盈利仓位 ${summary.winners}`} />
                                <Chip size="small" color="error" variant="outlined" label={`亏损仓位 ${summary.losers}`} />
                            </Stack>
                            <Box className="metric-icon" sx={{ color: theme.palette.primary.main, width: 30, height: 30, flex: '0 0 30px', borderRadius: 2, '& svg': { fontSize: 19 } }}>
                                <AccountBalanceWalletRoundedIcon />
                            </Box>
                        </Stack>
                    </Stack>

                    <Box>
                        <Stack direction="row" sx={{ justifyContent: 'space-between', mb: 0.25 }}>
                            <Typography variant="caption" color="text.secondary">成本占市值</Typography>
                            <Typography variant="caption" color="text.secondary">{preciseCurrency.format(summary.totalCostBasis)}</Typography>
                        </Stack>
                        <LinearProgress variant="determinate" value={investedRatio} sx={{ height: 5, borderRadius: 8 }} />
                    </Box>

                </Stack>
            </CardContent>
        </Card>
    )
}

const polarToCartesian = (cx, cy, r, angle) => {
    const radians = (angle * Math.PI) / 180
    return {
        x: cx + r * Math.cos(radians),
        y: cy + r * Math.sin(radians),
    }
}

const describeArc = (cx, cy, r, startAngle, endAngle) => {
    const start = polarToCartesian(cx, cy, r, startAngle)
    const end = polarToCartesian(cx, cy, r, endAngle)
    const largeArcFlag = endAngle - startAngle <= 180 ? 0 : 1
    return `M ${start.x} ${start.y} A ${r} ${r} 0 ${largeArcFlag} 1 ${end.x} ${end.y}`
}

const profitGaugeColors = {
    unrealized: '#EEF2F6',
    realized: '#5D87FF',
    income: '#EB7900',
}

function GaugeLegend({ label, color, active = false, dimmed = false, onMouseEnter, onMouseLeave }) {
    return (
        <Stack
            direction="row"
            spacing={0.75}
            onMouseEnter={onMouseEnter}
            onMouseLeave={onMouseLeave}
            sx={{
                alignItems: 'center',
                minWidth: 0,
                px: 0.25,
                cursor: onMouseEnter ? 'pointer' : 'default',
                opacity: dimmed ? 0.46 : 1,
                transform: active ? 'translateY(-1px)' : 'none',
                transition: 'opacity 160ms ease, transform 160ms ease',
            }}
        >
            <Box sx={{ width: active ? 10 : 8, height: active ? 10 : 8, borderRadius: '50%', bgcolor: color, border: '1px solid #E5EAEF', flexShrink: 0, transition: 'width 160ms ease, height 160ms ease' }} />
            <Typography variant="caption" color="text.secondary" fontWeight={active ? 800 : 400} noWrap>{label}</Typography>
        </Stack>
    )
}

function HalfMoonProfitChart({ summary, totalPnl }) {
    const theme = useTheme()
    const [hoveredKey, setHoveredKey] = useState(null)
    const [tooltipPosition, setTooltipPosition] = useState(null)
    const chartColors = {
        realized: profitGaugeColors.realized,
        income: profitGaugeColors.income,
        unrealized: theme.palette.mode === 'dark' ? '#AEB7C2' : profitGaugeColors.unrealized,
    }
    const rawSegments = [
        { id: 'realized', label: '已实现盈亏', shortLabel: '已实现', value: summary.realizedPnl, color: chartColors.realized },
        { id: 'income', label: '股息', shortLabel: '股息', value: summary.income, color: chartColors.income },
        { id: 'unrealized', label: '未实现盈亏', shortLabel: '未实现', value: summary.unrealizedPnl, color: chartColors.unrealized },
    ]
    const visibleSegments = rawSegments.filter((item) => Math.abs(item.value || 0) > 0.01)
    const absoluteTotal = visibleSegments.reduce((sum, item) => sum + Math.abs(item.value), 0)
    const minVisualValue = visibleSegments.length > 1 ? absoluteTotal * 0.055 : 0
    const visualTotal = visibleSegments.reduce((sum, item) => sum + Math.max(Math.abs(item.value), minVisualValue), 0)
    const activeSegment = rawSegments.find((item) => item.id === hoveredKey)
    const activeShare = activeSegment && absoluteTotal > 0
        ? (Math.abs(activeSegment.value) / absoluteTotal) * 100
        : null
    const centerLabel = activeSegment ? activeSegment.shortLabel : '总盈亏 / 股息'
    const centerValue = activeSegment ? activeSegment.value : totalPnl
    const centerCaption = activeSegment && activeShare !== null
        ? `实际占比 ${activeShare.toFixed(1)}%`
        : `浮盈率 ${percent(summary.unrealizedPct)}`
    const updateTooltipPosition = (event) => {
        const rect = event.currentTarget.getBoundingClientRect()
        setTooltipPosition({
            x: Math.min(Math.max(event.clientX - rect.left, 92), rect.width - 92),
            y: Math.min(Math.max(event.clientY - rect.top, 38), rect.height - 18),
        })
    }
    const clearHover = () => {
        setHoveredKey(null)
        setTooltipPosition(null)
    }

    let cursorAngle = 180
    const arcSegments = visibleSegments.length
        ? visibleSegments.map((item) => {
            const sweep = visualTotal > 0
                ? (Math.max(Math.abs(item.value), minVisualValue) / visualTotal) * 180
                : 0
            const startAngle = cursorAngle
            const endAngle = cursorAngle + sweep
            cursorAngle += sweep
            return {
                ...item,
                startAngle,
                endAngle: Math.max(startAngle + 0.5, endAngle),
            }
        })
        : [{ id: 'empty', label: '暂无数据', shortLabel: '暂无', value: 0, color: theme.palette.divider, startAngle: 180, endAngle: 360 }]

    return (
        <Box sx={{ width: '100%', maxWidth: 660, mx: 'auto', mt: -1, alignSelf: 'center' }}>
            <Box
                sx={{
                    position: 'relative',
                    minHeight: 210,
                    pt: 0,
                }}
                onMouseMove={updateTooltipPosition}
                onMouseLeave={clearHover}
            >
                {activeSegment && Math.abs(activeSegment.value || 0) > 0.01 && tooltipPosition && (
                    <Box
                        sx={{
                            position: 'absolute',
                            top: tooltipPosition.y,
                            left: tooltipPosition.x,
                            transform: 'translate(-50%, calc(-100% - 14px))',
                            zIndex: 2,
                            px: 1.5,
                            py: 0.9,
                            minWidth: 168,
                            borderRadius: 3,
                            bgcolor: '#FFFFFF',
                            border: '1px solid #E5EAEF',
                            boxShadow: '0 14px 32px rgba(42, 53, 71, 0.14)',
                            textAlign: 'center',
                            pointerEvents: 'none',
                        }}
                    >
                        <Typography variant="caption" color="text.secondary" fontWeight={800}>
                            {activeSegment.label}
                        </Typography>
                        <Typography variant="body2" color={pnlColor(activeSegment.value, theme)} fontWeight={900} sx={{ mt: 0.25 }}>
                            {preciseCurrency.format(activeSegment.value)}
                        </Typography>
                        <Typography variant="caption" color="text.secondary">
                            实际占比 {activeShare?.toFixed(1)}%
                        </Typography>
                    </Box>
                )}

                <Box
                    sx={{
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        pointerEvents: 'none',
                        mb: 0.75,
                    }}
                >
                    <Typography variant="caption" color="text.secondary" fontWeight={800}>
                        {centerLabel}
                    </Typography>
                    <Typography variant="h4" color={pnlColor(centerValue, theme)} fontWeight={900} sx={{ mt: 0.25, letterSpacing: '-0.03em' }}>
                        {preciseCurrency.format(centerValue)}
                    </Typography>
                    <Typography variant="caption" color="text.secondary" fontWeight={800} sx={{ mt: 0.5 }}>
                        {centerCaption}
                    </Typography>
                </Box>

                <Box
                    component="svg"
                    viewBox="0 24 320 172"
                    role="img"
                    aria-label="盈亏和股息半圆仪表盘"
                    sx={{ width: '100%', height: 132, display: 'block', overflow: 'visible' }}
                >
                    <path
                        d={describeArc(160, 170, 118, 180, 360)}
                        fill="none"
                        stroke={theme.palette.mode === 'dark' ? 'rgba(255,255,255,0.10)' : '#EEF2F6'}
                        strokeWidth="32"
                        strokeLinecap="butt"
                    />
                    {arcSegments.map((segment) => {
                        const isActive = hoveredKey === segment.id
                        const isDimmed = hoveredKey && !isActive && segment.id !== 'empty'
                        return (
                            <path
                                key={segment.id}
                                d={describeArc(160, 170, isActive ? 121 : 118, segment.startAngle, segment.endAngle)}
                                fill="none"
                                stroke={segment.color}
                                strokeWidth={isActive ? 38 : 32}
                                strokeLinecap="butt"
                                opacity={isDimmed ? 0.28 : 1}
                                filter={isActive ? 'drop-shadow(0 10px 16px rgba(42, 53, 71, 0.22))' : 'none'}
                                tabIndex={segment.id === 'empty' ? undefined : 0}
                                role="button"
                                onMouseEnter={() => segment.id !== 'empty' && setHoveredKey(segment.id)}
                                onFocus={() => segment.id !== 'empty' && setHoveredKey(segment.id)}
                                onBlur={() => setHoveredKey(null)}
                                style={{ cursor: segment.id === 'empty' ? 'default' : 'pointer', transition: 'opacity 160ms ease, stroke-width 160ms ease, filter 160ms ease' }}
                            />
                        )
                    })}
                </Box>

            </Box>

            <Stack
                direction="row"
                spacing={{ xs: 0.75, sm: 2 }}
                sx={{ mt: -1.25, justifyContent: 'center', flexWrap: 'wrap', rowGap: 0.5 }}
            >
                {rawSegments.map((segment) => {
                    const isActive = hoveredKey === segment.id
                    const isDimmed = hoveredKey && !isActive
                    return (
                        <GaugeLegend
                            key={segment.id}
                            label={segment.shortLabel}
                            color={segment.color}
                            active={isActive}
                            dimmed={Boolean(isDimmed)}
                            onMouseEnter={() => setHoveredKey(segment.id)}
                            onMouseLeave={clearHover}
                        />
                    )
                })}
            </Stack>
        </Box>
    )
}

function ProfitDashboardCard({ summary }) {
    const theme = useTheme()
    const totalRealizedIncome = summary.realizedPnl + summary.income
    const totalPnl = summary.unrealizedPnl + totalRealizedIncome

    return (
        <Card className="metric-card" sx={{ width: '100%', height: '100%', flex: 1 }}>
            <CardContent sx={{ height: '100%', boxSizing: 'border-box', p: 1.25, '&:last-child': { pb: 1.25 } }}>
                <Stack spacing={0.5} sx={{ height: '100%' }}>
                    <Stack direction="row" spacing={1.25} sx={{ justifyContent: 'space-between', alignItems: 'center' }}>
                        <Typography variant="h6" fontWeight={900}>盈亏 / 股息仪表盘</Typography>
                        <Box className="metric-icon" sx={{ color: pnlColor(totalPnl, theme), width: 30, height: 30, flex: '0 0 30px', borderRadius: 2, '& svg': { fontSize: 19 } }}>
                            <TrendingUpRoundedIcon />
                        </Box>
                    </Stack>

                    <HalfMoonProfitChart summary={summary} totalPnl={totalPnl} />
                </Stack>
            </CardContent>
        </Card>
    )
}

function CashflowCard({ summary }) {
    const theme = useTheme()
    const netExternalCash = summary.totalDeposits + summary.totalWithdrawals

    return (
        <Card className="metric-card" sx={{ height: 'auto' }}>
            <CardContent sx={{ px: 1.25, pt: 1.25, pb: 0.75, '&:last-child': { pb: 0.75 } }}>
                <Stack direction="row" spacing={1.25} sx={{ justifyContent: 'space-between' }}>
                    <Box sx={{ minWidth: 0, flex: 1 }}>
                        <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
                            <Typography color="text.secondary" variant="caption">现金流概览</Typography>
                            <Tooltip title="入金 - 出金后的净外部现金流" arrow placement="top">
                                <Box component="span" sx={{ display: 'inline-flex', color: 'text.disabled', cursor: 'help', '& svg': { fontSize: 14 } }}>
                                    <HelpOutlineRoundedIcon />
                                </Box>
                            </Tooltip>
                        </Stack>
                        <Typography
                            variant="subtitle1"
                            mt={0.15}
                            color={pnlColor(netExternalCash, theme)}
                            sx={{ fontWeight: 900, lineHeight: 1.15, letterSpacing: '-0.01em' }}
                        >
                            {preciseCurrency.format(netExternalCash)}
                        </Typography>
                        <Stack spacing={0.2} sx={{ mt: 0.45 }}>
                            <StatPill label="累计入金" value={preciseCurrency.format(summary.totalDeposits)} color={theme.palette.success.main} />
                            <StatPill label="累计出金" value={preciseCurrency.format(summary.totalWithdrawals)} color={theme.palette.error.main} />
                        </Stack>
                    </Box>
                    <Box className="metric-icon" sx={{ color: theme.palette.primary.main, width: 30, height: 30, flex: '0 0 30px', borderRadius: 2, '& svg': { fontSize: 19 } }}>
                        <PaidRoundedIcon />
                    </Box>
                </Stack>
            </CardContent>
        </Card>
    )
}

function TradingCashflowCard({ summary }) {
    const theme = useTheme()

    return (
        <Card className="metric-card" sx={{ height: 'auto' }}>
            <CardContent sx={{ px: 1.25, pt: 1.25, pb: 0.75, '&:last-child': { pb: 0.75 } }}>
                <Stack direction="row" spacing={1.25} sx={{ justifyContent: 'space-between' }}>
                    <Box sx={{ minWidth: 0, flex: 1 }}>
                        <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
                            <Typography color="text.secondary" variant="caption">交易现金流</Typography>
                            <Tooltip title="买入 / 卖出 / 费用 / 税费后的交易流出入" arrow placement="top">
                                <Box component="span" sx={{ display: 'inline-flex', color: 'text.disabled', cursor: 'help', '& svg': { fontSize: 14 } }}>
                                    <HelpOutlineRoundedIcon />
                                </Box>
                            </Tooltip>
                        </Stack>
                        <Typography
                            variant="subtitle1"
                            mt={0.15}
                            color={pnlColor(summary.tradingCashflow, theme)}
                            sx={{ fontWeight: 900, lineHeight: 1.15, letterSpacing: '-0.01em' }}
                        >
                            {preciseCurrency.format(summary.tradingCashflow)}
                        </Typography>
                        <Stack spacing={0.2} sx={{ mt: 0.45 }}>
                            <StatPill label="开放仓位" value={`${summary.openPositions}`} color={theme.palette.text.primary} />
                            <StatPill label="胜率粗略" value={`${Math.round((summary.winners / Math.max(1, summary.openPositions)) * 100)}%`} color={theme.palette.success.main} />
                        </Stack>
                    </Box>
                    <Box className="metric-icon" sx={{ color: pnlColor(summary.tradingCashflow, theme), width: 30, height: 30, flex: '0 0 30px', borderRadius: 2, '& svg': { fontSize: 19 } }}>
                        <ReceiptLongRoundedIcon />
                    </Box>
                </Stack>
            </CardContent>
        </Card>
    )
}

export default function SummaryCards({ summary }) {
    return (
        <Grid container spacing={2} sx={{ alignItems: 'stretch' }}>
            <Grid size={{ xs: 12, lg: 5 }} sx={{ display: 'flex' }}>
                <Stack spacing={1} sx={{ width: '100%', height: '100%' }}>
                    <PortfolioValueCard summary={summary} />
                    <CashflowCard summary={summary} />
                    <TradingCashflowCard summary={summary} />
                </Stack>
            </Grid>
            <Grid size={{ xs: 12, lg: 7 }} sx={{ display: 'flex' }}>
                <ProfitDashboardCard summary={summary} />
            </Grid>
        </Grid>
    )
}
