import { useState, useEffect } from 'react'
import {
    Alert,
    Box,
    Card,
    CardContent,
    CircularProgress,
    Divider,
    Grid,
    Paper,
    Snackbar,
    Stack,
    Tab,
    Tabs,
    Typography,
    useTheme,
    Button,
    Tooltip as MuiTooltip
} from '@mui/material'
import TrendingUpRoundedIcon from '@mui/icons-material/TrendingUpRounded'
import TrendingDownRoundedIcon from '@mui/icons-material/TrendingDownRounded'
import AccountBalanceRoundedIcon from '@mui/icons-material/AccountBalanceRounded'
import PublicRoundedIcon from '@mui/icons-material/PublicRounded'
import ShowChartRoundedIcon from '@mui/icons-material/ShowChartRounded'
import QueryStatsRoundedIcon from '@mui/icons-material/QueryStatsRounded'
import BarChartRoundedIcon from '@mui/icons-material/BarChartRounded'
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined'
import HelpOutlineRoundedIcon from '@mui/icons-material/HelpOutlineRounded'
import ForumRoundedIcon from '@mui/icons-material/ForumRounded'
import WhatshotRoundedIcon from '@mui/icons-material/WhatshotRounded'
import AutorenewRoundedIcon from '@mui/icons-material/AutorenewRounded'
import WorkOutlineRoundedIcon from '@mui/icons-material/WorkOutlineRounded'

import {
    Area,
    AreaChart,
    CartesianGrid,
    ComposedChart,
    Line,
    ReferenceLine,
    ResponsiveContainer,
    Tooltip,
    XAxis,
    YAxis,
    Legend
} from 'recharts'

import { useFredMacroData } from '../hooks/useFredMacroData.js'
import { useMacroAnalysis } from '../hooks/useMacroAnalysis.js'
import { dateTime } from '../utils/formatters.js'

const cleanName = (name) => {
    if (!name) return '';
    return name
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>');
};

export default function EventsTab() {
    const theme = useTheme()
    const { loading, error, data } = useFredMacroData()
    const { loading: analysisLoading, data: analysisData, refresh: refreshAnalysis, refreshing: analysisRefreshing } = useMacroAnalysis({ refreshMs: 60_000 })
    const [activeChartTab, setActiveChartTab] = useState(0)
    const [snackbarOpen, setSnackbarOpen] = useState(false)
    const [prevRefreshing, setPrevRefreshing] = useState(false)

    useEffect(() => {
        if (prevRefreshing && !analysisRefreshing) {
            if (analysisData?.used_cache) {
                setSnackbarOpen(true)
            }
        }
        setPrevRefreshing(analysisRefreshing)
    }, [analysisRefreshing, prevRefreshing, analysisData])

    const handleCloseSnackbar = (event, reason) => {
        if (reason === 'clickaway') return;
        setSnackbarOpen(false);
    }

    if (loading) {
        return (
            <Box sx={{ py: 8, display: 'grid', placeItems: 'center' }}>
                <Stack spacing={2} sx={{ alignItems: 'center' }}>
                    <CircularProgress size={50} />
                    <Typography color="text.secondary">正在加载 FRED 宏观经济数据...</Typography>
                </Stack>
            </Box>
        )
    }

    if (error) {
        return (
            <Box sx={{ p: 3 }}>
                <Alert severity="error">
                    无法加载宏观事件数据：{error.message}。请检查后端服务是否启动。
                </Alert>
            </Box>
        )
    }

    const seriesMap = {}
    if (data && data.series) {
        data.series.forEach((s) => {
            seriesMap[s.id] = s
        })
    }

    const getLatestValue = (seriesId) => {
        const series = seriesMap[seriesId]
        if (!series || !series.observations || series.observations.length === 0) return null
        return series.observations[series.observations.length - 1]
    }

    const getPreviousValue = (seriesId) => {
        const series = seriesMap[seriesId]
        if (!series || !series.observations || series.observations.length < 2) return null
        return series.observations[series.observations.length - 2]
    }

    // Extract latest points for summary cards
    const fedfunds = getLatestValue('FEDFUNDS')
    const t10y2y = getLatestValue('T10Y2Y')
    const cpiYoY = getLatestValue('CPI_YOY')
    const unrate = getLatestValue('UNRATE')
    const dgs10 = getLatestValue('DGS10')
    const gdpc1 = getLatestValue('GDPC1')
    const payems = getLatestValue('PAYEMS')

    // Change computation
    const getChange = (seriesId) => {
        const latest = getLatestValue(seriesId)
        const prev = getPreviousValue(seriesId)
        if (!latest || !prev) return null
        return (latest.value - prev.value).toFixed(2)
    }

    const fedfundsChange = getChange('FEDFUNDS')
    const t10y2yChange = getChange('T10Y2Y')
    const cpiChange = getChange('CPI_YOY')
    const unrateChange = getChange('UNRATE')
    const dgs10Change = getChange('DGS10')
    const payemsChange = getChange('PAYEMS')

    const getRedditTrendBadge = (item) => {
        const value = item?.mentions_change_pct
        if (!Number.isFinite(value)) {
            return {
                label: '新上榜',
                bgcolor: '#dfe6ee',
                color: '#748396'
            }
        }

        return {
            label: value >= 0 ? `+${value.toFixed(1)}%` : `${value.toFixed(1)}%`,
            bgcolor: value >= 0 ? '#e7f6ed' : '#fdeceb',
            color: value >= 0 ? '#157a3b' : '#ad322c'
        }
    }

    const RedditTrendBadge = ({ item }) => {
        const badge = getRedditTrendBadge(item)

        return (
            <Box
                sx={{
                    px: 1,
                    py: 0.3,
                    borderRadius: 1,
                    bgcolor: badge.bgcolor,
                    color: badge.color,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    minWidth: 66
                }}
            >
                <Typography variant="caption" sx={{ fontWeight: 700 }}>
                    {badge.label}
                </Typography>
            </Box>
        )
    }

    const redditTrending = analysisData?.reddit_trending || {}
    const stocksTrends = redditTrending.stocks || []
    const wallstreetbetsTrends = redditTrending.wallstreetbets || redditTrending.wallstreetbetsnew || []
    const redditTrendsUpdatedAt = redditTrending.updated_at ? dateTime(redditTrending.updated_at) : '等待数据更新'

    // Prepare overlay dataset for Interest Rates & Yields (FEDFUNDS + DGS10)
    const getOverlayData = () => {
        const fed = seriesMap['FEDFUNDS']?.observations || []
        const treasury = seriesMap['DGS10']?.observations || []

        // Merge by monthly or sample (DGS10 is daily, FEDFUNDS is monthly)
        // To keep it simple and clean, align daily DGS10 to nearest month or just interpolate monthly DGS10 average.
        // Let's create a combined dataset keyed by date
        const monthlyTreasury = {}
        treasury.forEach(obs => {
            const monthKey = obs.date.substring(0, 7) + "-01"
            if (!monthlyTreasury[monthKey]) {
                monthlyTreasury[monthKey] = []
            }
            monthlyTreasury[monthKey].push(obs.value)
        })

        let lastKnownTreasury = null
        const combined = []
        fed.forEach(fObs => {
            const tVals = monthlyTreasury[fObs.date] || []
            let tAvg = tVals.length > 0 ? (tVals.reduce((a, b) => a + b, 0) / tVals.length) : null

            if (tAvg !== null) {
                lastKnownTreasury = parseFloat(tAvg.toFixed(2))
            }

            combined.push({
                date: fObs.date.substring(0, 7),
                '联邦基金利率 (Fed Funds)': fObs.value,
                '10年期国债收益率 (10Y Yield)': lastKnownTreasury !== null ? lastKnownTreasury : undefined
            })
        })
        return combined.slice(-24) // Show last 24 months
    }

    const getLaborEconomyData = () => {
        const unemployment = seriesMap['UNRATE']?.observations || []
        const gdp = seriesMap['GDPC1']?.observations || []
        const sortedGdp = [...gdp].sort((a, b) => new Date(a.date) - new Date(b.date))
        let gdpIndex = 0
        let lastKnownGdp = null

        return unemployment.map((uObs) => {
            const unemploymentDate = new Date(uObs.date)

            while (
                gdpIndex < sortedGdp.length
                && new Date(sortedGdp[gdpIndex].date) <= unemploymentDate
            ) {
                lastKnownGdp = sortedGdp[gdpIndex].value
                gdpIndex += 1
            }

            return {
                date: uObs.date.substring(0, 7),
                '失业率 (Unemployment Rate)': uObs.value,
                '实际GDP (Real GDP)': lastKnownGdp ?? undefined
            }
        }).slice(-36)
    }

    const aiCommentaryAvailable = analysisData?.ai_commentary_available !== false
    const hasAiCommentary = Boolean(aiCommentaryAvailable && analysisData?.summary_commentary)
    const sectors = aiCommentaryAvailable && Array.isArray(analysisData?.sectors) ? analysisData.sectors : []

    const getImpactColor = (impact) => {
        if (!impact) return { bgcolor: '#dfe6ee', color: '#4a5a6c' }
        if (impact.includes("正面") || impact.includes("超配") || impact.includes("多配") || impact.includes("买入")) {
            return { bgcolor: '#e7f6ed', color: '#1d9a4c' }
        }
        if (impact.includes("负面") || impact.includes("低配") || impact.includes("避险") || impact.includes("减配")) {
            return { bgcolor: '#fdeceb', color: '#d6453d' }
        }
        return { bgcolor: '#dfe6ee', color: '#4a5a6c' }
    }

    return (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3, p: { xs: 2, md: 3 } }}>
            <Snackbar
                open={snackbarOpen}
                autoHideDuration={6000}
                onClose={handleCloseSnackbar}
                anchorOrigin={{ vertical: 'top', horizontal: 'center' }}
            >
                <Alert onClose={handleCloseSnackbar} severity="info" sx={{ width: '100%', boxShadow: 3 }}>
                    由于宏观核心数据近期未发生变化，已为您提取最新的智能缓存分析结果。
                </Alert>
            </Snackbar>


            <Box sx={{ pt: 1 }}>
                {data?.status === 'sandbox_mock' ? (
                    <Alert
                        severity="warning"
                        variant="outlined"
                        sx={{
                            bgcolor: 'rgba(201, 124, 0, 0.1)',
                            borderColor: 'rgba(201, 124, 0, 0.3)',
                            color: '#c97c00',
                            '& .MuiAlert-icon': { color: '#c97c00' }
                        }}
                    >
                        <strong>沙盒模拟模式 (Sandbox Mode)</strong>：当前正使用离线高拟真宏观数据（2023-2026年真实走势）。要连接美联储官方 FRED 获取实时更新，请在根目录 <code>.env</code> 文件中配置 <code>FRED_API_KEY</code> 并重启服务。
                    </Alert>
                ) : (
                    <Alert
                        severity="success"
                        variant="outlined"
                        sx={{
                            bgcolor: 'rgba(29, 154, 76, 0.1)',
                            borderColor: 'rgba(29, 154, 76, 0.3)',
                            color: '#157a3b',
                            '& .MuiAlert-icon': { color: '#1d9a4c' }
                        }}
                    >
                        <strong>联接实时 FRED API 成功</strong>：所有宏观经济指标均已同步美联储官方最新公布的观测数据。
                    </Alert>
                )}
            </Box>


            {/* AI Macro Commentary Card */}
            {hasAiCommentary && (
                <Card sx={{ borderRadius: 3, border: '1px solid #d9e2ec', boxShadow: 'none', backgroundColor: '#ffffff' }}>
                    <CardContent sx={{ p: { xs: 2, md: 2.5 } }}>
                        <Stack spacing={1.5}>
                            <Stack direction={{ xs: 'column', sm: 'row' }} sx={{ justifyContent: 'space-between', alignItems: { xs: 'flex-start', sm: 'center' }, gap: 1.5 }}>
                                <Stack direction="row" spacing={1.25} sx={{ alignItems: 'center' }}>
                                    <Box sx={{ p: 0.75, borderRadius: 1.5, bgcolor: 'primary.light', color: 'primary.main', display: 'flex' }}>
                                        <WhatshotRoundedIcon fontSize="small" />
                                    </Box>
                                    <Box>
                                        <Typography variant="subtitle1" sx={{ fontWeight: 700, lineHeight: 1.3 }}>AI 宏观点评</Typography>
                                        <Typography variant="caption" color="text.secondary">
                                            模型生成，基于下方 FRED 指标 · 更新于 {analysisData.analysis_date ? new Date(analysisData.analysis_date).toLocaleString('zh-CN') : '未知'}
                                        </Typography>
                                    </Box>
                                </Stack>
                                <Button
                                    size="small"
                                    variant="outlined"
                                    startIcon={analysisRefreshing ? <CircularProgress size={14} /> : <AutorenewRoundedIcon />}
                                    onClick={refreshAnalysis}
                                    disabled={analysisRefreshing}
                                    sx={{ alignSelf: { xs: 'flex-end', sm: 'auto' }, px: 1.5 }}
                                >
                                    {analysisRefreshing ? '正在生成…' : '重新生成点评'}
                                </Button>
                            </Stack>
                            <Typography variant="body2" sx={{ color: 'text.primary', lineHeight: 1.85, fontSize: '0.95rem', maxWidth: '72ch', whiteSpace: 'pre-line' }}>
                                {analysisData.summary_commentary}
                            </Typography>
                        </Stack>
                    </CardContent>
                </Card>
            )}

            {/* Grid of Key Macro Indicators (Summary Cards) */}
            <Grid container spacing={2}>

                {/* 1. Fed Funds Rate */}
                <Grid item xs={12} sm={6} md={4}>
                    <Card sx={{ borderRadius: 3, boxShadow: 'none', border: '1px solid #dfe6ee', position: 'relative', overflow: 'visible', '&:hover': { borderColor: '#c5d1de' } }}>
                        <CardContent sx={{ p: 2.5 }}>
                            <Stack spacing={1}>
                                <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'center' }}>
                                    <Typography variant="subtitle2" color="text.secondary" sx={{ fontWeight: 600 }}>
                                        美联储政策利率 (Fed Funds)
                                    </Typography>
                                    <Box sx={{ p: 1, borderRadius: 2, bgcolor: '#e6f0fc', color: '#2a6fc0' }}>
                                        <AccountBalanceRoundedIcon fontSize="small" />
                                    </Box>
                                </Stack>
                                <Stack direction="row" sx={{ alignItems: 'baseline', gap: 1 }}>
                                    <Typography variant="h4" sx={{ fontWeight: 700 }}>
                                        {fedfunds ? `${fedfunds.value}%` : 'N/A'}
                                    </Typography>
                                    {fedfundsChange && (
                                        <Stack direction="row" sx={{ alignItems: 'center', color: parseFloat(fedfundsChange) >= 0 ? '#d6453d' : '#1d9a4c' }}>
                                            {parseFloat(fedfundsChange) >= 0 ? <TrendingUpRoundedIcon fontSize="small" /> : <TrendingDownRoundedIcon fontSize="small" />}
                                            <Typography variant="caption" sx={{ fontWeight: 600 }}>
                                                {fedfundsChange > 0 ? `+${fedfundsChange}` : fedfundsChange}%
                                            </Typography>
                                        </Stack>
                                    )}
                                </Stack>
                                <Divider sx={{ my: 0.5 }} />
                                <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'center' }}>
                                    <Typography variant="caption" color="text.secondary">
                                        数据公布周期: 每月
                                    </Typography>
                                    <Box sx={{ px: 1, py: 0.3, borderRadius: 1, bgcolor: fedfunds && fedfunds.value > 4.0 ? '#fdeceb' : '#e7f6ed', color: fedfunds && fedfunds.value > 4.0 ? '#d6453d' : '#157a3b' }}>
                                        <Typography variant="caption" sx={{ fontWeight: 600 }}>
                                            {fedfunds && fedfunds.value > 4.0 ? '紧缩/限制性利率' : '宽松/低息环境'}
                                        </Typography>
                                    </Box>
                                </Stack>
                            </Stack>
                        </CardContent>
                    </Card>
                </Grid>

                {/* 2. 10Y-2Y Treasury Yield Spread */}
                <Grid item xs={12} sm={6} md={4}>
                    <Card sx={{ borderRadius: 3, boxShadow: 'none', border: '1px solid #dfe6ee', '&:hover': { borderColor: '#c5d1de' } }}>
                        <CardContent sx={{ p: 2.5 }}>
                            <Stack spacing={1}>
                                <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'center' }}>
                                    <Typography variant="subtitle2" color="text.secondary" sx={{ fontWeight: 600 }}>
                                        美债 10Y-2Y 期限利差
                                    </Typography>
                                    <Box sx={{ p: 1, borderRadius: 2, bgcolor: t10y2y && t10y2y.value < 0 ? '#fdeceb' : '#e7f6ed', color: t10y2y && t10y2y.value < 0 ? '#d6453d' : '#1d9a4c' }}>
                                        <QueryStatsRoundedIcon fontSize="small" />
                                    </Box>
                                </Stack>
                                <Stack direction="row" sx={{ alignItems: 'baseline', gap: 1 }}>
                                    <Typography variant="h4" sx={{ fontWeight: 700, color: t10y2y && t10y2y.value < 0 ? '#d6453d' : 'text.primary' }}>
                                        {t10y2y ? `${t10y2y.value}%` : 'N/A'}
                                    </Typography>
                                    {t10y2yChange && (
                                        <Stack direction="row" sx={{ alignItems: 'center', color: parseFloat(t10y2yChange) >= 0 ? '#1d9a4c' : '#d6453d' }}>
                                            {parseFloat(t10y2yChange) >= 0 ? <TrendingUpRoundedIcon fontSize="small" /> : <TrendingDownRoundedIcon fontSize="small" />}
                                            <Typography variant="caption" sx={{ fontWeight: 600 }}>
                                                {t10y2yChange > 0 ? `+${t10y2yChange}` : t10y2yChange}%
                                            </Typography>
                                        </Stack>
                                    )}
                                </Stack>
                                <Divider sx={{ my: 0.5 }} />
                                <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'center' }}>
                                    <Typography variant="caption" color="text.secondary">
                                        衰退预警器 (前瞻12M)
                                    </Typography>
                                    <Box sx={{ px: 1, py: 0.3, borderRadius: 1, bgcolor: t10y2y && t10y2y.value < 0 ? '#fdeceb' : '#e7f6ed', color: t10y2y && t10y2y.value < 0 ? '#d6453d' : '#157a3b' }}>
                                        <Typography variant="caption" sx={{ fontWeight: 600 }}>
                                            {t10y2y && t10y2y.value < 0 ? '收益率曲线倒挂' : '收益率正常/走平'}
                                        </Typography>
                                    </Box>
                                </Stack>
                            </Stack>
                        </CardContent>
                    </Card>
                </Grid>

                {/* 3. CPI YoY Inflation */}
                <Grid item xs={12} sm={6} md={4}>
                    <Card sx={{ borderRadius: 3, boxShadow: 'none', border: '1px solid #dfe6ee', '&:hover': { borderColor: '#c5d1de' } }}>
                        <CardContent sx={{ p: 2.5 }}>
                            <Stack spacing={1}>
                                <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'center' }}>
                                    <Typography variant="subtitle2" color="text.secondary" sx={{ fontWeight: 600 }}>
                                        美国 CPI 通胀年率 (YoY)
                                    </Typography>
                                    <Box sx={{ p: 1, borderRadius: 2, bgcolor: '#fff4df', color: '#c97c00' }}>
                                        <ShowChartRoundedIcon fontSize="small" />
                                    </Box>
                                </Stack>
                                <Stack direction="row" sx={{ alignItems: 'baseline', gap: 1 }}>
                                    <Typography variant="h4" sx={{ fontWeight: 700 }}>
                                        {cpiYoY ? `${cpiYoY.value}%` : 'N/A'}
                                    </Typography>
                                    {cpiChange && (
                                        <Stack direction="row" sx={{ alignItems: 'center', color: parseFloat(cpiChange) >= 0 ? '#d6453d' : '#1d9a4c' }}>
                                            {parseFloat(cpiChange) >= 0 ? <TrendingUpRoundedIcon fontSize="small" /> : <TrendingDownRoundedIcon fontSize="small" />}
                                            <Typography variant="caption" sx={{ fontWeight: 600 }}>
                                                {cpiChange > 0 ? `+${cpiChange}` : cpiChange}%
                                            </Typography>
                                        </Stack>
                                    )}
                                </Stack>
                                <Divider sx={{ my: 0.5 }} />
                                <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'center' }}>
                                    <Typography variant="caption" color="text.secondary">
                                        美联储政策锚定目标: 2.0%
                                    </Typography>
                                    <Box sx={{ px: 1, py: 0.3, borderRadius: 1, bgcolor: cpiYoY && cpiYoY.value > 3.0 ? '#fdeceb' : '#e7f6ed', color: cpiYoY && cpiYoY.value > 3.0 ? '#d6453d' : '#157a3b' }}>
                                        <Typography variant="caption" sx={{ fontWeight: 600 }}>
                                            {cpiYoY && cpiYoY.value > 3.0 ? '高通胀警戒' : '通胀符合预期'}
                                        </Typography>
                                    </Box>
                                </Stack>
                            </Stack>
                        </CardContent>
                    </Card>
                </Grid>

                {/* 4. 10-Year Treasury Yield */}
                <Grid item xs={12} sm={6} md={4}>
                    <Card sx={{ borderRadius: 3, boxShadow: 'none', border: '1px solid #dfe6ee', '&:hover': { borderColor: '#c5d1de' } }}>
                        <CardContent sx={{ p: 2.5 }}>
                            <Stack spacing={1}>
                                <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'center' }}>
                                    <Typography variant="subtitle2" color="text.secondary" sx={{ fontWeight: 600 }}>
                                        美债 10Y 收益率 (无风险利率)
                                    </Typography>
                                    <Box sx={{ p: 1, borderRadius: 2, bgcolor: '#efedfc', color: '#6250d6' }}>
                                        <BarChartRoundedIcon fontSize="small" />
                                    </Box>
                                </Stack>
                                <Stack direction="row" sx={{ alignItems: 'baseline', gap: 1 }}>
                                    <Typography variant="h4" sx={{ fontWeight: 700 }}>
                                        {dgs10 ? `${dgs10.value}%` : 'N/A'}
                                    </Typography>
                                    {dgs10Change && (
                                        <Stack direction="row" sx={{ alignItems: 'center', color: parseFloat(dgs10Change) >= 0 ? '#d6453d' : '#1d9a4c' }}>
                                            {parseFloat(dgs10Change) >= 0 ? <TrendingUpRoundedIcon fontSize="small" /> : <TrendingDownRoundedIcon fontSize="small" />}
                                            <Typography variant="caption" sx={{ fontWeight: 600 }}>
                                                {dgs10Change > 0 ? `+${dgs10Change}` : dgs10Change}%
                                            </Typography>
                                        </Stack>
                                    )}
                                </Stack>
                                <Divider sx={{ my: 0.5 }} />
                                <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'center' }}>
                                    <Typography variant="caption" color="text.secondary">
                                        全球风险资产之锚/折现率
                                    </Typography>
                                    <Box sx={{ px: 1, py: 0.3, borderRadius: 1, bgcolor: '#dfe6ee', color: '#4a5a6c' }}>
                                        <Typography variant="caption" sx={{ fontWeight: 600 }}>
                                            资产定价基石
                                        </Typography>
                                    </Box>
                                </Stack>
                            </Stack>
                        </CardContent>
                    </Card>
                </Grid>

                {/* 5. Unemployment Rate */}
                <Grid item xs={12} sm={6} md={4}>
                    <Card sx={{ borderRadius: 3, boxShadow: 'none', border: '1px solid #dfe6ee', '&:hover': { borderColor: '#c5d1de' } }}>
                        <CardContent sx={{ p: 2.5 }}>
                            <Stack spacing={1}>
                                <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'center' }}>
                                    <Typography variant="subtitle2" color="text.secondary" sx={{ fontWeight: 600 }}>
                                        美国失业率 (Unrate)
                                    </Typography>
                                    <Box sx={{ p: 1, borderRadius: 2, bgcolor: '#e7f6ed', color: '#1d9a4c' }}>
                                        <PublicRoundedIcon fontSize="small" />
                                    </Box>
                                </Stack>
                                <Stack direction="row" sx={{ alignItems: 'baseline', gap: 1 }}>
                                    <Typography variant="h4" sx={{ fontWeight: 700 }}>
                                        {unrate ? `${unrate.value}%` : 'N/A'}
                                    </Typography>
                                    {unrateChange && (
                                        <Stack direction="row" sx={{ alignItems: 'center', color: parseFloat(unrateChange) >= 0 ? '#d6453d' : '#1d9a4c' }}>
                                            {parseFloat(unrateChange) >= 0 ? <TrendingUpRoundedIcon fontSize="small" /> : <TrendingDownRoundedIcon fontSize="small" />}
                                            <Typography variant="caption" sx={{ fontWeight: 600 }}>
                                                {unrateChange > 0 ? `+${unrateChange}` : unrateChange}%
                                            </Typography>
                                        </Stack>
                                    )}
                                </Stack>
                                <Divider sx={{ my: 0.5 }} />
                                <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'center' }}>
                                    <Typography variant="caption" color="text.secondary">
                                        充分就业区间: 3.5% - 4.5%
                                    </Typography>
                                    <Box sx={{ px: 1, py: 0.3, borderRadius: 1, bgcolor: unrate && unrate.value > 4.5 ? '#fdeceb' : '#e7f6ed', color: unrate && unrate.value > 4.5 ? '#d6453d' : '#157a3b' }}>
                                        <Typography variant="caption" sx={{ fontWeight: 600 }}>
                                            {unrate && unrate.value > 4.5 ? '就业市场走弱' : '劳动力稳固'}
                                        </Typography>
                                    </Box>
                                </Stack>
                            </Stack>
                        </CardContent>
                    </Card>
                </Grid>

                {/* 5b. Nonfarm Payrolls */}
                <Grid item xs={12} sm={6} md={4}>
                    <Card sx={{ borderRadius: 3, boxShadow: 'none', border: '1px solid #dfe6ee', '&:hover': { borderColor: '#c5d1de' } }}>
                        <CardContent sx={{ p: 2.5 }}>
                            <Stack spacing={1}>
                                <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'center' }}>
                                    <Typography variant="subtitle2" color="text.secondary" sx={{ fontWeight: 600 }}>
                                        美国非农就业人数 (PAYEMS)
                                    </Typography>
                                    <Box sx={{ p: 1, borderRadius: 2, bgcolor: '#e6f0fc', color: '#3584d6' }}>
                                        <WorkOutlineRoundedIcon fontSize="small" />
                                    </Box>
                                </Stack>
                                <Stack direction="row" sx={{ alignItems: 'baseline', gap: 1 }}>
                                    <Typography variant="h4" sx={{ fontWeight: 700 }}>
                                        {payems ? `${(payems.value / 1000).toFixed(2)}M` : 'N/A'}
                                    </Typography>
                                    {payemsChange && (
                                        <Stack direction="row" sx={{ alignItems: 'center', color: parseFloat(payemsChange) >= 0 ? '#1d9a4c' : '#d6453d' }}>
                                            {parseFloat(payemsChange) >= 0 ? <TrendingUpRoundedIcon fontSize="small" /> : <TrendingDownRoundedIcon fontSize="small" />}
                                            <Typography variant="caption" sx={{ fontWeight: 600 }}>
                                                {parseFloat(payemsChange) > 0 ? `+${Math.round(parseFloat(payemsChange))}` : Math.round(parseFloat(payemsChange))}K
                                            </Typography>
                                        </Stack>
                                    )}
                                </Stack>
                                <Divider sx={{ my: 0.5 }} />
                                <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'center' }}>
                                    <Typography variant="caption" color="text.secondary">
                                        新增就业强劲阀值: 150K
                                    </Typography>
                                    <Box sx={{
                                        px: 1,
                                        py: 0.3,
                                        borderRadius: 1,
                                        bgcolor: payemsChange && parseFloat(payemsChange) >= 150 ? '#e7f6ed' : (payemsChange && parseFloat(payemsChange) > 0 ? '#e6f0fc' : '#fdeceb'),
                                        color: payemsChange && parseFloat(payemsChange) >= 150 ? '#157a3b' : (payemsChange && parseFloat(payemsChange) > 0 ? '#2a6fc0' : '#d6453d')
                                    }}>
                                        <Typography variant="caption" sx={{ fontWeight: 600 }}>
                                            {payemsChange && parseFloat(payemsChange) >= 150 ? '新增就业强劲' : (payemsChange && parseFloat(payemsChange) > 0 ? '新增就业温和' : '就业人数收缩')}
                                        </Typography>
                                    </Box>
                                </Stack>
                            </Stack>
                        </CardContent>
                    </Card>
                </Grid>

                {/* 6. Real GDP */}
                <Grid item xs={12} sm={6} md={4}>
                    <Card sx={{ borderRadius: 3, boxShadow: 'none', border: '1px solid #dfe6ee', '&:hover': { borderColor: '#c5d1de' } }}>
                        <CardContent sx={{ p: 2.5 }}>
                            <Stack spacing={1}>
                                <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'center' }}>
                                    <Typography variant="subtitle2" color="text.secondary" sx={{ fontWeight: 600 }}>
                                        美国实际 GDP 年化
                                    </Typography>
                                    <Box sx={{ p: 1, borderRadius: 2, bgcolor: '#fbeef4', color: '#c04d82' }}>
                                        <TrendingUpRoundedIcon fontSize="small" />
                                    </Box>
                                </Stack>
                                <Stack direction="row" sx={{ alignItems: 'baseline', gap: 1 }}>
                                    <Typography variant="h4" sx={{ fontWeight: 700 }}>
                                        {gdpc1 ? `$${Math.round(gdpc1.value)}B` : 'N/A'}
                                    </Typography>
                                    <Typography variant="caption" color="text.secondary">
                                        (季调年化指数)
                                    </Typography>
                                </Stack>
                                <Divider sx={{ my: 0.5 }} />
                                <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'center' }}>
                                    <Typography variant="caption" color="text.secondary">
                                        数据公布周期: 每季度
                                    </Typography>
                                    <Box sx={{ px: 1, py: 0.3, borderRadius: 1, bgcolor: '#e7f6ed', color: '#1d9a4c' }}>
                                        <Typography variant="caption" sx={{ fontWeight: 600 }}>
                                            经济稳健扩张
                                        </Typography>
                                    </Box>
                                </Stack>
                            </Stack>
                        </CardContent>
                    </Card>
                </Grid>

            </Grid>

            {/* Interactive Recharts Panel */}
            <Card sx={{ borderRadius: 4, boxShadow: 'none', border: '1px solid #dfe6ee', overflow: 'hidden' }}>
                <Box sx={{ borderBottom: 1, borderColor: 'divider', bgcolor: '#f6f8fb', px: 2 }}>
                    <Tabs
                        value={activeChartTab}
                        onChange={(e, val) => setActiveChartTab(val)}
                        sx={{
                            '& .MuiTab-root': { fontWeight: 600, py: 2 },
                            '& .Mui-selected': { color: 'primary.main' }
                        }}
                    >
                        <Tab label="联邦基金利率 vs 美债收益率" icon={<AccountBalanceRoundedIcon fontSize="small" />} iconPosition="start" />
                        <Tab label="美国 CPI 通胀率趋势" icon={<ShowChartRoundedIcon fontSize="small" />} iconPosition="start" />
                        <Tab label="美债 10Y-2Y 利差变动" icon={<QueryStatsRoundedIcon fontSize="small" />} iconPosition="start" />
                        <Tab label="失业率与实体经济" icon={<PublicRoundedIcon fontSize="small" />} iconPosition="start" />
                    </Tabs>
                </Box>

                <CardContent sx={{ p: 3 }}>
                    <Box sx={{ height: 380, width: '100%' }}>

                        {/* Chart Tab 0: FEDFUNDS vs DGS10 Overlay */}
                        {activeChartTab === 0 && (
                            <ResponsiveContainer width="100%" height="100%">
                                <ComposedChart data={getOverlayData()}>
                                    <defs>
                                        <linearGradient id="colorFed" x1="0" y1="0" x2="0" y2="1">
                                            <stop offset="5%" stopColor="#2a6fc0" stopOpacity={0.2} />
                                            <stop offset="95%" stopColor="#2a6fc0" stopOpacity={0.01} />
                                        </linearGradient>
                                        <linearGradient id="colorTreasury" x1="0" y1="0" x2="0" y2="1">
                                            <stop offset="5%" stopColor="#6250d6" stopOpacity={0.2} />
                                            <stop offset="95%" stopColor="#6250d6" stopOpacity={0.01} />
                                        </linearGradient>
                                    </defs>
                                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#dfe6ee" />
                                    <XAxis dataKey="date" stroke="#8a99ab" fontSize={12} tickLine={false} />
                                    <YAxis unit="%" stroke="#8a99ab" fontSize={12} domain={['auto', 'auto']} tickLine={false} axisLine={false} />
                                    <Tooltip
                                        contentStyle={{ border: 'none', borderRadius: 12, boxShadow: 'none' }}
                                        formatter={(value) => [`${value}%`]}
                                    />
                                    <Legend verticalAlign="top" height={36} />
                                    <Area type="monotone" dataKey="联邦基金利率 (Fed Funds)" stroke="#2a6fc0" strokeWidth={3} fillOpacity={1} fill="url(#colorFed)" connectNulls={true} />
                                    <Line type="monotone" dataKey="10年期国债收益率 (10Y Yield)" stroke="#6250d6" strokeWidth={3} dot={{ r: 4 }} activeDot={{ r: 6 }} connectNulls={true} />
                                </ComposedChart>
                            </ResponsiveContainer>
                        )}

                        {/* Chart Tab 1: CPI Inflation Rate YoY */}
                        {activeChartTab === 1 && (
                            <ResponsiveContainer width="100%" height="100%">
                                <AreaChart data={seriesMap['CPI_YOY']?.observations.slice(-24) || []}>
                                    <defs>
                                        <linearGradient id="colorCpi" x1="0" y1="0" x2="0" y2="1">
                                            <stop offset="5%" stopColor="#c97c00" stopOpacity={0.25} />
                                            <stop offset="95%" stopColor="#c97c00" stopOpacity={0.01} />
                                        </linearGradient>
                                    </defs>
                                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#dfe6ee" />
                                    <XAxis dataKey="date" stroke="#8a99ab" fontSize={11} tickLine={false} tickFormatter={d => d.substring(0, 7)} />
                                    <YAxis unit="%" stroke="#8a99ab" fontSize={12} domain={['auto', 'auto']} tickLine={false} axisLine={false} />
                                    <Tooltip
                                        contentStyle={{ border: 'none', borderRadius: 12, boxShadow: 'none' }}
                                        formatter={(value) => [`${value}%`, '通胀率 (YoY)']}
                                    />
                                    <Legend verticalAlign="top" height={36} />
                                    <ReferenceLine y={2.0} stroke="#1d9a4c" strokeWidth={2} strokeDasharray="5 5" label={{ value: "美联储目标通胀: 2.0%", fill: "#1d9a4c", position: "top", fontSize: 11 }} />
                                    <Area type="monotone" name="美国 CPI 通胀年率 (YoY)" dataKey="value" stroke="#c97c00" strokeWidth={3} fillOpacity={1} fill="url(#colorCpi)" connectNulls={true} />
                                </AreaChart>
                            </ResponsiveContainer>
                        )}

                        {/* Chart Tab 2: Yield Curve Spread (T10Y2Y) */}
                        {activeChartTab === 2 && (
                            <ResponsiveContainer width="100%" height="100%">
                                <AreaChart data={seriesMap['T10Y2Y']?.observations || []}>
                                    <defs>
                                        <linearGradient id="colorSpread" x1="0" y1="0" x2="0" y2="1">
                                            <stop offset="5%" stopColor="#d6453d" stopOpacity={0.25} />
                                            <stop offset="95%" stopColor="#d6453d" stopOpacity={0.01} />
                                        </linearGradient>
                                    </defs>
                                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#dfe6ee" />
                                    <XAxis dataKey="date" stroke="#8a99ab" fontSize={11} tickLine={false} />
                                    <YAxis unit="%" stroke="#8a99ab" fontSize={12} tickLine={false} axisLine={false} />
                                    <Tooltip
                                        contentStyle={{ border: 'none', borderRadius: 12, boxShadow: 'none' }}
                                        formatter={(value) => [`${value}%`, '10Y-2Y 期限利差']}
                                    />
                                    <Legend verticalAlign="top" height={36} />
                                    <ReferenceLine y={0} stroke="#4a5a6c" strokeWidth={2} label={{ value: "倒挂分界线 (0%)", fill: "#4a5a6c", position: "top", fontSize: 11 }} />
                                    <Area type="monotone" name="10Y-2Y 利差" dataKey="value" stroke="#d6453d" strokeWidth={3} fillOpacity={1} fill="url(#colorSpread)" connectNulls={true} />
                                </AreaChart>
                            </ResponsiveContainer>
                        )}

                        {/* Chart Tab 3: Unemployment vs Real GDP */}
                        {activeChartTab === 3 && (
                            <ResponsiveContainer width="100%" height="100%">
                                <ComposedChart data={getLaborEconomyData()}>
                                    <defs>
                                        <linearGradient id="colorUnrate" x1="0" y1="0" x2="0" y2="1">
                                            <stop offset="5%" stopColor="#2a6fc0" stopOpacity={0.2} />
                                            <stop offset="95%" stopColor="#2a6fc0" stopOpacity={0.01} />
                                        </linearGradient>
                                    </defs>
                                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#dfe6ee" />
                                    <XAxis dataKey="date" stroke="#8a99ab" fontSize={11} tickLine={false} />
                                    <YAxis yAxisId="left" unit="%" stroke="#2a6fc0" fontSize={12} domain={['auto', 'auto']} tickLine={false} axisLine={false} />
                                    <YAxis yAxisId="right" orientation="right" stroke="#1d9a4c" fontSize={12} domain={['auto', 'auto']} tickLine={false} axisLine={false} tickFormatter={(value) => `${Math.round(value / 1000)}T`} />
                                    <Tooltip
                                        contentStyle={{ border: 'none', borderRadius: 12, boxShadow: 'none' }}
                                        formatter={(value, name) => {
                                            if (name === '实际GDP (Real GDP)') {
                                                return [`$${Math.round(value).toLocaleString()}B`, name]
                                            }
                                            return [`${value}%`, name]
                                        }}
                                    />
                                    <Legend verticalAlign="top" height={36} />
                                    <Area yAxisId="left" type="monotone" name="失业率 (Unemployment Rate)" dataKey="失业率 (Unemployment Rate)" stroke="#2a6fc0" strokeWidth={3} fillOpacity={1} fill="url(#colorUnrate)" connectNulls={true} />
                                    <Line yAxisId="right" type="monotone" name="实际GDP (Real GDP)" dataKey="实际GDP (Real GDP)" stroke="#1d9a4c" strokeWidth={3} dot={{ r: 3 }} activeDot={{ r: 6 }} connectNulls={true} />
                                </ComposedChart>
                            </ResponsiveContainer>
                        )}

                    </Box>
                </CardContent>
            </Card>

            {/* Sector Impact Analysis Section */}
            {sectors.length > 0 && (
                <Stack spacing={2.5}>
                    <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                        <InfoOutlinedIcon color="primary" />
                        <Typography variant="h6" sx={{ fontWeight: 700 }}>
                            美股行业板块的宏观因果链分析 (Sector Valuation Impact Guide)
                        </Typography>
                    </Stack>

                    <Grid container spacing={2}>
                        {sectors.map((item, index) => {
                            const colors = getImpactColor(item.impact)
                            return (
                                <Grid item xs={12} md={6} key={index}>
                                    <Card
                                        sx={{
                                            borderRadius: 3.5,
                                            boxShadow: 'none',
                                            border: '1px solid #dfe6ee',
                                            height: '100%',
                                            display: 'flex',
                                            flexDirection: 'column',
                                            '&:hover': {
                                                boxShadow: 'none',
                                                borderColor: 'primary.light'
                                            }
                                        }}
                                    >
                                        <CardContent sx={{ p: 3, display: 'flex', flexDirection: 'column', gap: 1.5, height: '100%' }}>
                                            <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'center' }}>
                                                <Typography variant="subtitle1" sx={{ fontWeight: 700, color: 'text.primary' }}>
                                                    {item.title}
                                                </Typography>
                                                <Box sx={{ px: 1.5, py: 0.5, borderRadius: 1.5, bgcolor: colors.bgcolor, color: colors.color }}>
                                                    <Typography variant="caption" sx={{ fontWeight: 700 }}>
                                                        {item.impact}
                                                    </Typography>
                                                </Box>
                                            </Stack>
                                            <Typography variant="body2" color="text.secondary" sx={{ lineHeight: 1.6, flexGrow: 1 }}>
                                                {item.reason}
                                            </Typography>
                                            <Box
                                                sx={{
                                                    p: 1.5,
                                                    borderRadius: 2,
                                                    bgcolor: '#f6f8fb',
                                                    borderLeft: '3px solid #3584d6',
                                                    mt: 1
                                                }}
                                            >
                                                <Stack direction="row" spacing={1} sx={{ alignItems: 'flex-start' }}>
                                                    <HelpOutlineRoundedIcon sx={{ fontSize: 16, color: '#3584d6', mt: 0.2 }} />
                                                    <Typography variant="caption" sx={{ color: '#4a5a6c', lineHeight: 1.5, fontWeight: 550 }}>
                                                        <strong>配置建议:</strong> {item.suggestion}
                                                    </Typography>
                                                </Stack>
                                            </Box>
                                        </CardContent>
                                    </Card>
                                </Grid>
                            )
                        })}
                    </Grid>
                </Stack>
            )}

            {/* Reddit Trending Section from ApeWisdom */}
            {analysisData && analysisData.reddit_trending && (
                <Stack spacing={2.5}>
                    <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                        <ForumRoundedIcon color="primary" />
                        <Typography variant="h6" sx={{ fontWeight: 700 }}>
                            🔥 ApeWisdom Reddit Trends
                        </Typography>
                        <Typography variant="caption" color="text.secondary" sx={{ ml: 1 }}>
                            更新于: {redditTrendsUpdatedAt} · 数据源: r/stocks 和 r/wallstreetbets
                        </Typography>
                    </Stack>

                    <Grid container spacing={3}>
                        {/* r/stocks */}
                        <Grid item xs={12} md={6}>
                            <Card sx={{ borderRadius: 3.5, border: '1px solid #dfe6ee', boxShadow: 'none' }}>
                                <Box sx={{ p: 2, bgcolor: '#f6f8fb', borderBottom: '1px solid #dfe6ee', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                    <Typography variant="subtitle2" sx={{ fontWeight: 700, color: '#2d3b4d' }}>
                                        📈 r/stocks 热门讨论标的
                                    </Typography>
                                    <Typography variant="caption" color="text.secondary">
                                        Reddit 股票主板
                                    </Typography>
                                </Box>
                                <CardContent sx={{ p: 0 }}>
                                    <Stack divider={<Divider />}>
                                        {stocksTrends.length > 0 ? (
                                            stocksTrends.map((item, idx) => {
                                                const cleaned = cleanName(item.name);
                                                const isLong = cleaned.length > 15;
                                                return (
                                                    <Box key={idx} sx={{ px: 2.5, py: 1.5, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) max-content', columnGap: 3, alignItems: 'center', '&:hover': { bgcolor: '#f6f8fb' } }}>
                                                        <Stack direction="row" spacing={2} sx={{ alignItems: 'center', minWidth: 0 }}>
                                                            <Typography variant="body2" sx={{ fontWeight: 700, color: 'text.secondary', width: 20, flexShrink: 0 }}>
                                                                {idx + 1}
                                                            </Typography>
                                                            <Box sx={{ px: 1.2, py: 0.4, borderRadius: 1.5, bgcolor: '#e6f0fc', border: '1px solid #e6f0fc', flexShrink: 0 }}>
                                                                <Typography variant="body2" sx={{ fontWeight: 700, color: '#1f5fa8' }}>
                                                                    {item.ticker}
                                                                </Typography>
                                                            </Box>
                                                            {isLong ? (
                                                                <MuiTooltip title={cleaned} enterDelay={200} arrow>
                                                                    <Typography variant="body2" sx={{ fontWeight: 550, color: 'text.primary', minWidth: 0, maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                                                        {cleaned}
                                                                    </Typography>
                                                                </MuiTooltip>
                                                            ) : (
                                                                <Typography variant="body2" sx={{ fontWeight: 550, color: 'text.primary', minWidth: 0, maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                                                    {cleaned}
                                                                </Typography>
                                                            )}
                                                        </Stack>
                                                        <Stack direction="row" spacing={2.5} sx={{ alignItems: 'center', flexShrink: 0 }}>
                                                            <Typography variant="body2" sx={{ fontWeight: 600, minWidth: 82, textAlign: 'right' }}>
                                                                {item.mentions} 提及
                                                            </Typography>
                                                            <RedditTrendBadge item={item} />
                                                        </Stack>
                                                    </Box>
                                                );
                                            })
                                        ) : (
                                            <Box sx={{ p: 4, textAlign: 'center' }}>
                                                <Typography color="text.secondary" variant="body2">暂无 Reddit 热门标的数据</Typography>
                                            </Box>
                                        )}
                                    </Stack>
                                </CardContent>
                            </Card>
                        </Grid>

                        {/* r/wallstreetbets */}
                        <Grid item xs={12} md={6}>
                            <Card sx={{ borderRadius: 3.5, border: '1px solid #dfe6ee', boxShadow: 'none' }}>
                                <Box sx={{ p: 2, bgcolor: '#f6f8fb', borderBottom: '1px solid #dfe6ee', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                    <Typography variant="subtitle2" sx={{ fontWeight: 700, color: '#2d3b4d' }}>
                                        🦍 r/wallstreetbets 热门讨论标的
                                    </Typography>
                                    <Typography variant="caption" color="text.secondary">
                                        WSB 散户大本营
                                    </Typography>
                                </Box>
                                <CardContent sx={{ p: 0 }}>
                                    <Stack divider={<Divider />}>
                                        {wallstreetbetsTrends.length > 0 ? (
                                            wallstreetbetsTrends.map((item, idx) => {
                                                const cleaned = cleanName(item.name);
                                                const isLong = cleaned.length > 15;
                                                return (
                                                    <Box key={idx} sx={{ px: 2.5, py: 1.5, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) max-content', columnGap: 3, alignItems: 'center', '&:hover': { bgcolor: '#f6f8fb' } }}>
                                                        <Stack direction="row" spacing={2} sx={{ alignItems: 'center', minWidth: 0 }}>
                                                            <Typography variant="body2" sx={{ fontWeight: 700, color: 'text.secondary', width: 20, flexShrink: 0 }}>
                                                                {idx + 1}
                                                            </Typography>
                                                            <Box sx={{ px: 1.2, py: 0.4, borderRadius: 1.5, bgcolor: '#fbeef4', border: '1px solid #fbeef4', flexShrink: 0 }}>
                                                                <Typography variant="body2" sx={{ fontWeight: 700, color: '#a03b6b' }}>
                                                                    {item.ticker}
                                                                </Typography>
                                                            </Box>
                                                            {isLong ? (
                                                                <MuiTooltip title={cleaned} enterDelay={200} arrow>
                                                                    <Typography variant="body2" sx={{ fontWeight: 550, color: 'text.primary', minWidth: 0, maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                                                        {cleaned}
                                                                    </Typography>
                                                                </MuiTooltip>
                                                            ) : (
                                                                <Typography variant="body2" sx={{ fontWeight: 550, color: 'text.primary', minWidth: 0, maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                                                    {cleaned}
                                                                </Typography>
                                                            )}
                                                        </Stack>
                                                        <Stack direction="row" spacing={2.5} sx={{ alignItems: 'center', flexShrink: 0 }}>
                                                            <Typography variant="body2" sx={{ fontWeight: 600, minWidth: 82, textAlign: 'right' }}>
                                                                {item.mentions} 提及
                                                            </Typography>
                                                            <RedditTrendBadge item={item} />
                                                        </Stack>
                                                    </Box>
                                                );
                                            })
                                        ) : (
                                            <Box sx={{ p: 4, textAlign: 'center' }}>
                                                <Typography color="text.secondary" variant="body2">暂无 Reddit 热门标的数据</Typography>
                                            </Box>
                                        )}
                                    </Stack>
                                </CardContent>
                            </Card>
                        </Grid>
                    </Grid>
                </Stack>
            )}

        </Box>
    )
}
