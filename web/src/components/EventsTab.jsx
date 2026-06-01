import { useState } from 'react'
import {
    Alert,
    Box,
    Card,
    CardContent,
    CircularProgress,
    Divider,
    Grid,
    Paper,
    Stack,
    Tab,
    Tabs,
    Typography,
    useTheme,
    Button
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

export default function EventsTab() {
    const theme = useTheme()
    const { loading, error, data } = useFredMacroData()
    const { loading: analysisLoading, data: analysisData, refresh: refreshAnalysis, refreshing: analysisRefreshing } = useMacroAnalysis()
    const [activeChartTab, setActiveChartTab] = useState(0)

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

    // Sector impact config based on macro environment
    const sectorsImpact = [
        {
            title: "🚀 高科技 & 成长板块 (Tech & Growth)",
            impact: "负面 / 压制估值",
            reason: "成长股的估值大部分基于远期现金流。高利率和美债收益率上升会拉高折现率（WACC），从而显著压缩其合理估值倍数（PE/PS）。此外，初创科技企业融资成本显著抬升。",
            suggestion: "在降息周期（利率下行）中，该板块往往最为受益，弹性最大。"
        },
        {
            title: "🏦 银行 & 金融板块 (Financials)",
            impact: "中性偏正面",
            reason: "利率高企和美债收益率上行通常能够拓宽银行的净利息差（NIM），提升核心贷款利差收益。但需要注意，如果收益率曲线深度倒挂，可能压制期限利差，且过度高息会导致信用违约风险抬升。",
            suggestion: "高息环境初期利好零售银行，加息尾声可转为布局高股息险资。"
        },
        {
            title: "🔌 公用事业 & 房托地产 (Utilities & REITs)",
            impact: "负面 / 资金分流",
            reason: "公用事业和房地产板块是典型的高负债、高股息板块。利率上升直接拉高其财务利息开支。同时，当无风险收益率（10Y美债）达到4%-5%时，其3%-5%的股息收益率便失去吸引力，导致资金分流。",
            suggestion: "避险降息通道（利率走弱）中公用事业和REITs会迎来价值重估。"
        },
        {
            title: "🛢️ 能源 & 大宗商品 (Energy & Materials)",
            impact: "正面 (抗通胀)",
            reason: "通胀走高（CPI上升）通常伴随着能源与大宗商品价格的上涨。该板块具有强定价权和天然的通胀对冲属性。在高通胀、加息中早期，能源股往往一枝独秀。",
            suggestion: "在通胀拐点前是极佳的对冲工具，但在经济陷入衰退（GDP走弱）时需警惕需求下行。"
        }
    ]

    const sectors = (analysisData && analysisData.sectors && analysisData.sectors.length > 0) ? analysisData.sectors : sectorsImpact;

    const getImpactColor = (impact) => {
        if (!impact) return { bgcolor: '#f1f5f9', color: '#475569' };
        if (impact.includes("正面") || impact.includes("超配") || impact.includes("多配") || impact.includes("买入")) {
            return { bgcolor: '#dcfce7', color: '#16a34a' };
        }
        if (impact.includes("负面") || impact.includes("低配") || impact.includes("避险") || impact.includes("减配")) {
            return { bgcolor: '#fee2e2', color: '#ef4444' };
        }
        return { bgcolor: '#f1f5f9', color: '#475569' };
    };

    return (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3, p: { xs: 2, md: 3 } }}>

            {/* AI Macro Commentary Card */}
            {analysisData && analysisData.summary_commentary && (
                <Card
                    sx={{
                        borderRadius: 4,
                        boxShadow: '0 4px 25px rgba(0,0,0,0.02)',
                        border: '1px solid #e2e8f0',
                        background: 'linear-gradient(135deg, #f8fafc 0%, #ffffff 100%)',
                        position: 'relative',
                        overflow: 'hidden'
                    }}
                >
                    <CardContent sx={{ p: 3 }}>
                        <Stack spacing={2}>
                            <Stack direction={{ xs: 'column', sm: 'row' }} sx={{ justifyContent: 'space-between', alignItems: { xs: 'flex-start', sm: 'center' }, gap: 2 }}>
                                <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center' }}>
                                    <Box sx={{ p: 1, borderRadius: 2, bgcolor: '#eff6ff', color: '#3b82f6', display: 'flex' }}>
                                        <WhatshotRoundedIcon fontSize="small" />
                                    </Box>
                                    <Typography variant="h6" sx={{ fontWeight: 700, color: '#1e293b' }}>
                                        🤖 AI 宏观经济深度点评 (AI Macro Commentary)
                                    </Typography>
                                </Stack>
                                <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center', alignSelf: { xs: 'flex-end', sm: 'auto' } }}>
                                    <Typography variant="caption" color="text.secondary">
                                        更新于: {analysisData.analysis_date ? new Date(analysisData.analysis_date).toLocaleString('zh-CN') : 'N/A'}
                                    </Typography>
                                    <Button
                                        size="small"
                                        variant="outlined"
                                        startIcon={analysisRefreshing ? <CircularProgress size={14} /> : <AutorenewRoundedIcon />}
                                        onClick={refreshAnalysis}
                                        disabled={analysisRefreshing}
                                        sx={{ borderRadius: 2, textTransform: 'none', px: 1.5 }}
                                    >
                                        {analysisRefreshing ? '正在诊断...' : '实时AI诊断'}
                                    </Button>
                                </Stack>
                            </Stack>
                            <Typography variant="body2" sx={{ color: '#334155', lineHeight: 1.8, fontSize: '0.95rem', fontWeight: 550 }}>
                                {analysisData.summary_commentary}
                            </Typography>
                        </Stack>
                    </CardContent>
                </Card>
            )}

            {/* Header Panel */}
            <Paper
                elevation={0}
                sx={{
                    p: 3,
                    borderRadius: 4,
                    background: 'linear-gradient(135deg, #1e293b 0%, #0f172a 100%)',
                    color: '#ffffff',
                    position: 'relative',
                    overflow: 'hidden',
                    boxShadow: '0 10px 30px rgba(15, 23, 42, 0.08)'
                }}
            >
                <Stack spacing={1.5} sx={{ zIndex: 2, position: 'relative' }}>
                    <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center' }}>
                        <TrendingUpRoundedIcon sx={{ fontSize: 32, color: '#3b82f6' }} />
                        <Typography variant="h5" sx={{ fontWeight: 700, letterSpacing: 0.5 }}>
                            事件与宏观经济面板 (Macro Events)
                        </Typography>
                    </Stack>
                    <Typography variant="body2" sx={{ color: '#94a3b8', maxWidth: 800, lineHeight: 1.6 }}>
                        本板块追踪影响美股核心估值的关键宏观经济指标。利率、通胀、美债收益率及劳动力市场数据，是决定美股牛熊切换与板块轮动最为关键的驱动因子（数据每24小时自动更新）。
                    </Typography>

                    <Box sx={{ pt: 1 }}>
                        {data?.status === 'sandbox_mock' ? (
                            <Alert
                                severity="warning"
                                variant="outlined"
                                sx={{
                                    bgcolor: 'rgba(217, 119, 6, 0.1)',
                                    borderColor: 'rgba(217, 119, 6, 0.3)',
                                    color: '#fbbf24',
                                    '& .MuiAlert-icon': { color: '#fbbf24' }
                                }}
                            >
                                <strong>沙盒模拟模式 (Sandbox Mode)</strong>：当前正使用离线高拟真宏观数据（2023-2026年真实走势）。要连接美联储官方 FRED 获取实时更新，请在根目录 <code>.env</code> 文件中配置 <code>FRED_API_KEY</code> 并重启服务。
                            </Alert>
                        ) : (
                            <Alert
                                severity="success"
                                variant="outlined"
                                sx={{
                                    bgcolor: 'rgba(16, 185, 129, 0.1)',
                                    borderColor: 'rgba(16, 185, 129, 0.3)',
                                    color: '#34d399',
                                    '& .MuiAlert-icon': { color: '#34d399' }
                                }}
                            >
                                <strong>联接实时 FRED API 成功</strong>：所有宏观经济指标均已同步美联储官方最新公布的观测数据。
                            </Alert>
                        )}
                    </Box>
                </Stack>

                {/* Subtle background SVG decorations */}
                <Box
                    sx={{
                        position: 'absolute',
                        right: -30,
                        bottom: -30,
                        opacity: 0.1,
                        color: '#3b82f6',
                        pointerEvents: 'none'
                    }}
                >
                    <PublicRoundedIcon sx={{ fontSize: 240 }} />
                </Box>
            </Paper>

            {/* Grid of Key Macro Indicators (Summary Cards) */}
            <Grid container spacing={2}>

                {/* 1. Fed Funds Rate */}
                <Grid item xs={12} sm={6} md={4}>
                    <Card sx={{ borderRadius: 3, boxShadow: '0 4px 20px rgba(0,0,0,0.02)', border: '1px solid #f1f5f9', position: 'relative', overflow: 'visible', '&:hover': { transform: 'translateY(-4px)', transition: 'all 0.2s ease-in-out', boxShadow: '0 8px 30px rgba(0,0,0,0.06)' } }}>
                        <CardContent sx={{ p: 2.5 }}>
                            <Stack spacing={1}>
                                <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'center' }}>
                                    <Typography variant="subtitle2" color="text.secondary" sx={{ fontWeight: 600 }}>
                                        美联储政策利率 (Fed Funds)
                                    </Typography>
                                    <Box sx={{ p: 1, borderRadius: 2, bgcolor: '#eff6ff', color: '#2563eb' }}>
                                        <AccountBalanceRoundedIcon fontSize="small" />
                                    </Box>
                                </Stack>
                                <Stack direction="row" sx={{ alignItems: 'baseline', gap: 1 }}>
                                    <Typography variant="h4" sx={{ fontWeight: 700 }}>
                                        {fedfunds ? `${fedfunds.value}%` : 'N/A'}
                                    </Typography>
                                    {fedfundsChange && (
                                        <Stack direction="row" sx={{ alignItems: 'center', color: parseFloat(fedfundsChange) >= 0 ? '#ef4444' : '#10b981' }}>
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
                                    <Box sx={{ px: 1, py: 0.3, borderRadius: 1, bgcolor: fedfunds && fedfunds.value > 4.0 ? '#fee2e2' : '#dcfce7', color: fedfunds && fedfunds.value > 4.0 ? '#ef4444' : '#15803d' }}>
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
                    <Card sx={{ borderRadius: 3, boxShadow: '0 4px 20px rgba(0,0,0,0.02)', border: '1px solid #f1f5f9', '&:hover': { transform: 'translateY(-4px)', transition: 'all 0.2s ease-in-out', boxShadow: '0 8px 30px rgba(0,0,0,0.06)' } }}>
                        <CardContent sx={{ p: 2.5 }}>
                            <Stack spacing={1}>
                                <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'center' }}>
                                    <Typography variant="subtitle2" color="text.secondary" sx={{ fontWeight: 600 }}>
                                        美债 10Y-2Y 期限利差
                                    </Typography>
                                    <Box sx={{ p: 1, borderRadius: 2, bgcolor: t10y2y && t10y2y.value < 0 ? '#fef2f2' : '#f0fdf4', color: t10y2y && t10y2y.value < 0 ? '#ef4444' : '#10b981' }}>
                                        <QueryStatsRoundedIcon fontSize="small" />
                                    </Box>
                                </Stack>
                                <Stack direction="row" sx={{ alignItems: 'baseline', gap: 1 }}>
                                    <Typography variant="h4" sx={{ fontWeight: 700, color: t10y2y && t10y2y.value < 0 ? '#ef4444' : 'text.primary' }}>
                                        {t10y2y ? `${t10y2y.value}%` : 'N/A'}
                                    </Typography>
                                    {t10y2yChange && (
                                        <Stack direction="row" sx={{ alignItems: 'center', color: parseFloat(t10y2yChange) >= 0 ? '#10b981' : '#ef4444' }}>
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
                                    <Box sx={{ px: 1, py: 0.3, borderRadius: 1, bgcolor: t10y2y && t10y2y.value < 0 ? '#fee2e2' : '#dcfce7', color: t10y2y && t10y2y.value < 0 ? '#ef4444' : '#15803d' }}>
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
                    <Card sx={{ borderRadius: 3, boxShadow: '0 4px 20px rgba(0,0,0,0.02)', border: '1px solid #f1f5f9', '&:hover': { transform: 'translateY(-4px)', transition: 'all 0.2s ease-in-out', boxShadow: '0 8px 30px rgba(0,0,0,0.06)' } }}>
                        <CardContent sx={{ p: 2.5 }}>
                            <Stack spacing={1}>
                                <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'center' }}>
                                    <Typography variant="subtitle2" color="text.secondary" sx={{ fontWeight: 600 }}>
                                        美国 CPI 通胀年率 (YoY)
                                    </Typography>
                                    <Box sx={{ p: 1, borderRadius: 2, bgcolor: '#fef3c7', color: '#d97706' }}>
                                        <ShowChartRoundedIcon fontSize="small" />
                                    </Box>
                                </Stack>
                                <Stack direction="row" sx={{ alignItems: 'baseline', gap: 1 }}>
                                    <Typography variant="h4" sx={{ fontWeight: 700 }}>
                                        {cpiYoY ? `${cpiYoY.value}%` : 'N/A'}
                                    </Typography>
                                    {cpiChange && (
                                        <Stack direction="row" sx={{ alignItems: 'center', color: parseFloat(cpiChange) >= 0 ? '#ef4444' : '#10b981' }}>
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
                                    <Box sx={{ px: 1, py: 0.3, borderRadius: 1, bgcolor: cpiYoY && cpiYoY.value > 3.0 ? '#fee2e2' : '#dcfce7', color: cpiYoY && cpiYoY.value > 3.0 ? '#ef4444' : '#15803d' }}>
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
                    <Card sx={{ borderRadius: 3, boxShadow: '0 4px 20px rgba(0,0,0,0.02)', border: '1px solid #f1f5f9', '&:hover': { transform: 'translateY(-4px)', transition: 'all 0.2s ease-in-out', boxShadow: '0 8px 30px rgba(0,0,0,0.06)' } }}>
                        <CardContent sx={{ p: 2.5 }}>
                            <Stack spacing={1}>
                                <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'center' }}>
                                    <Typography variant="subtitle2" color="text.secondary" sx={{ fontWeight: 600 }}>
                                        美债 10Y 收益率 (无风险利率)
                                    </Typography>
                                    <Box sx={{ p: 1, borderRadius: 2, bgcolor: '#f5f3ff', color: '#7c3aed' }}>
                                        <BarChartRoundedIcon fontSize="small" />
                                    </Box>
                                </Stack>
                                <Stack direction="row" sx={{ alignItems: 'baseline', gap: 1 }}>
                                    <Typography variant="h4" sx={{ fontWeight: 700 }}>
                                        {dgs10 ? `${dgs10.value}%` : 'N/A'}
                                    </Typography>
                                    {dgs10Change && (
                                        <Stack direction="row" sx={{ alignItems: 'center', color: parseFloat(dgs10Change) >= 0 ? '#ef4444' : '#10b981' }}>
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
                                    <Box sx={{ px: 1, py: 0.3, borderRadius: 1, bgcolor: '#f1f5f9', color: '#475569' }}>
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
                    <Card sx={{ borderRadius: 3, boxShadow: '0 4px 20px rgba(0,0,0,0.02)', border: '1px solid #f1f5f9', '&:hover': { transform: 'translateY(-4px)', transition: 'all 0.2s ease-in-out', boxShadow: '0 8px 30px rgba(0,0,0,0.06)' } }}>
                        <CardContent sx={{ p: 2.5 }}>
                            <Stack spacing={1}>
                                <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'center' }}>
                                    <Typography variant="subtitle2" color="text.secondary" sx={{ fontWeight: 600 }}>
                                        美国失业率 (Unrate)
                                    </Typography>
                                    <Box sx={{ p: 1, borderRadius: 2, bgcolor: '#f0fdfa', color: '#0d9488' }}>
                                        <PublicRoundedIcon fontSize="small" />
                                    </Box>
                                </Stack>
                                <Stack direction="row" sx={{ alignItems: 'baseline', gap: 1 }}>
                                    <Typography variant="h4" sx={{ fontWeight: 700 }}>
                                        {unrate ? `${unrate.value}%` : 'N/A'}
                                    </Typography>
                                    {unrateChange && (
                                        <Stack direction="row" sx={{ alignItems: 'center', color: parseFloat(unrateChange) >= 0 ? '#ef4444' : '#10b981' }}>
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
                                    <Box sx={{ px: 1, py: 0.3, borderRadius: 1, bgcolor: unrate && unrate.value > 4.5 ? '#fee2e2' : '#dcfce7', color: unrate && unrate.value > 4.5 ? '#ef4444' : '#15803d' }}>
                                        <Typography variant="caption" sx={{ fontWeight: 600 }}>
                                            {unrate && unrate.value > 4.5 ? '就业市场走弱' : '劳动力稳固'}
                                        </Typography>
                                    </Box>
                                </Stack>
                            </Stack>
                        </CardContent>
                    </Card>
                </Grid>

                {/* 6. Real GDP */}
                <Grid item xs={12} sm={6} md={4}>
                    <Card sx={{ borderRadius: 3, boxShadow: '0 4px 20px rgba(0,0,0,0.02)', border: '1px solid #f1f5f9', '&:hover': { transform: 'translateY(-4px)', transition: 'all 0.2s ease-in-out', boxShadow: '0 8px 30px rgba(0,0,0,0.06)' } }}>
                        <CardContent sx={{ p: 2.5 }}>
                            <Stack spacing={1}>
                                <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'center' }}>
                                    <Typography variant="subtitle2" color="text.secondary" sx={{ fontWeight: 600 }}>
                                        美国实际 GDP 年化
                                    </Typography>
                                    <Box sx={{ p: 1, borderRadius: 2, bgcolor: '#fdf2f8', color: '#db2777' }}>
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
                                    <Box sx={{ px: 1, py: 0.3, borderRadius: 1, bgcolor: '#f0fdf4', color: '#16a34a' }}>
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
            <Card sx={{ borderRadius: 4, boxShadow: '0 6px 25px rgba(0,0,0,0.03)', border: '1px solid #f1f5f9', overflow: 'hidden' }}>
                <Box sx={{ borderBottom: 1, borderColor: 'divider', bgcolor: '#f8fafc', px: 2 }}>
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
                                            <stop offset="5%" stopColor="#2563eb" stopOpacity={0.2} />
                                            <stop offset="95%" stopColor="#2563eb" stopOpacity={0.01} />
                                        </linearGradient>
                                        <linearGradient id="colorTreasury" x1="0" y1="0" x2="0" y2="1">
                                            <stop offset="5%" stopColor="#7c3aed" stopOpacity={0.2} />
                                            <stop offset="95%" stopColor="#7c3aed" stopOpacity={0.01} />
                                        </linearGradient>
                                    </defs>
                                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                                    <XAxis dataKey="date" stroke="#94a3b8" fontSize={12} tickLine={false} />
                                    <YAxis unit="%" stroke="#94a3b8" fontSize={12} domain={['auto', 'auto']} tickLine={false} axisLine={false} />
                                    <Tooltip
                                        contentStyle={{ border: 'none', borderRadius: 12, boxShadow: '0 8px 30px rgba(0,0,0,0.08)' }}
                                        formatter={(value) => [`${value}%`]}
                                    />
                                    <Legend verticalAlign="top" height={36} />
                                    <Area type="monotone" dataKey="联邦基金利率 (Fed Funds)" stroke="#2563eb" strokeWidth={3} fillOpacity={1} fill="url(#colorFed)" connectNulls={true} />
                                    <Line type="monotone" dataKey="10年期国债收益率 (10Y Yield)" stroke="#7c3aed" strokeWidth={3} dot={{ r: 4 }} activeDot={{ r: 6 }} connectNulls={true} />
                                </ComposedChart>
                            </ResponsiveContainer>
                        )}

                        {/* Chart Tab 1: CPI Inflation Rate YoY */}
                        {activeChartTab === 1 && (
                            <ResponsiveContainer width="100%" height="100%">
                                <AreaChart data={seriesMap['CPI_YOY']?.observations.slice(-24) || []}>
                                    <defs>
                                        <linearGradient id="colorCpi" x1="0" y1="0" x2="0" y2="1">
                                            <stop offset="5%" stopColor="#d97706" stopOpacity={0.25} />
                                            <stop offset="95%" stopColor="#d97706" stopOpacity={0.01} />
                                        </linearGradient>
                                    </defs>
                                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                                    <XAxis dataKey="date" stroke="#94a3b8" fontSize={11} tickLine={false} tickFormatter={d => d.substring(0, 7)} />
                                    <YAxis unit="%" stroke="#94a3b8" fontSize={12} domain={['auto', 'auto']} tickLine={false} axisLine={false} />
                                    <Tooltip
                                        contentStyle={{ border: 'none', borderRadius: 12, boxShadow: '0 8px 30px rgba(0,0,0,0.08)' }}
                                        formatter={(value) => [`${value}%`, '通胀率 (YoY)']}
                                    />
                                    <Legend verticalAlign="top" height={36} />
                                    <ReferenceLine y={2.0} stroke="#10b981" strokeWidth={2} strokeDasharray="5 5" label={{ value: "美联储目标通胀: 2.0%", fill: "#10b981", position: "top", fontSize: 11 }} />
                                    <Area type="monotone" name="美国 CPI 通胀年率 (YoY)" dataKey="value" stroke="#d97706" strokeWidth={3} fillOpacity={1} fill="url(#colorCpi)" connectNulls={true} />
                                </AreaChart>
                            </ResponsiveContainer>
                        )}

                        {/* Chart Tab 2: Yield Curve Spread (T10Y2Y) */}
                        {activeChartTab === 2 && (
                            <ResponsiveContainer width="100%" height="100%">
                                <AreaChart data={seriesMap['T10Y2Y']?.observations || []}>
                                    <defs>
                                        <linearGradient id="colorSpread" x1="0" y1="0" x2="0" y2="1">
                                            <stop offset="5%" stopColor="#ef4444" stopOpacity={0.25} />
                                            <stop offset="95%" stopColor="#ef4444" stopOpacity={0.01} />
                                        </linearGradient>
                                    </defs>
                                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                                    <XAxis dataKey="date" stroke="#94a3b8" fontSize={11} tickLine={false} />
                                    <YAxis unit="%" stroke="#94a3b8" fontSize={12} tickLine={false} axisLine={false} />
                                    <Tooltip
                                        contentStyle={{ border: 'none', borderRadius: 12, boxShadow: '0 8px 30px rgba(0,0,0,0.08)' }}
                                        formatter={(value) => [`${value}%`, '10Y-2Y 期限利差']}
                                    />
                                    <Legend verticalAlign="top" height={36} />
                                    <ReferenceLine y={0} stroke="#475569" strokeWidth={2} label={{ value: "倒挂分界线 (0%)", fill: "#475569", position: "top", fontSize: 11 }} />
                                    <Area type="monotone" name="10Y-2Y 利差" dataKey="value" stroke="#ef4444" strokeWidth={3} fillOpacity={1} fill="url(#colorSpread)" connectNulls={true} />
                                </AreaChart>
                            </ResponsiveContainer>
                        )}

                    </Box>
                </CardContent>
            </Card>

            {/* Sector Impact Analysis Section */}
            <Stack spacing={2.5}>
                <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                    <InfoOutlinedIcon color="primary" />
                    <Typography variant="h6" sx={{ fontWeight: 700 }}>
                        美股行业板块的宏观因果链分析 (Sector Valuation Impact Guide)
                    </Typography>
                </Stack>

                <Grid container spacing={2}>
                    {sectors.map((item, index) => {
                        const colors = getImpactColor(item.impact);
                        return (
                            <Grid item xs={12} md={6} key={index}>
                                <Card
                                    sx={{
                                        borderRadius: 3.5,
                                        boxShadow: '0 4px 20px rgba(0,0,0,0.01)',
                                        border: '1px solid #f1f5f9',
                                        height: '100%',
                                        display: 'flex',
                                        flexDirection: 'column',
                                        '&:hover': {
                                            boxShadow: '0 10px 30px rgba(0,0,0,0.04)',
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
                                                bgcolor: '#f8fafc',
                                                borderLeft: '3px solid #3b82f6',
                                                mt: 1
                                            }}
                                        >
                                            <Stack direction="row" spacing={1} sx={{ alignItems: 'flex-start' }}>
                                                <HelpOutlineRoundedIcon sx={{ fontSize: 16, color: '#3b82f6', mt: 0.2 }} />
                                                <Typography variant="caption" sx={{ color: '#475569', lineHeight: 1.5, fontWeight: 550 }}>
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

            {/* Reddit Trending Section from ApeWisdom */}
            {analysisData && analysisData.reddit_trending && (
                <Stack spacing={2.5}>
                    <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                        <ForumRoundedIcon color="primary" />
                        <Typography variant="h6" sx={{ fontWeight: 700 }}>
                            🔥 Reddit 社区热门讨论标的 (ApeWisdom Reddit Trends)
                        </Typography>
                        <Typography variant="caption" color="text.secondary" sx={{ ml: 1 }}>
                            (自动每24h更新，分析 r/stocks 和 r/Wallstreetbetsnew 提及度)
                        </Typography>
                    </Stack>
                    
                    <Grid container spacing={3}>
                        {/* r/stocks */}
                        <Grid item xs={12} md={6}>
                            <Card sx={{ borderRadius: 3.5, border: '1px solid #f1f5f9', boxShadow: '0 4px 20px rgba(0,0,0,0.01)' }}>
                                <Box sx={{ p: 2, bgcolor: '#f8fafc', borderBottom: '1px solid #f1f5f9', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                    <Typography variant="subtitle2" sx={{ fontWeight: 700, color: '#334155' }}>
                                        📈 r/stocks 热门讨论标的
                                    </Typography>
                                    <Typography variant="caption" color="text.secondary">
                                        Reddit 股票主板
                                    </Typography>
                                </Box>
                                <CardContent sx={{ p: 0 }}>
                                    <Stack divider={<Divider />}>
                                        {analysisData.reddit_trending.stocks && analysisData.reddit_trending.stocks.length > 0 ? (
                                            analysisData.reddit_trending.stocks.map((item, idx) => (
                                                <Box key={idx} sx={{ px: 2.5, py: 1.5, display: 'flex', justifyContent: 'space-between', alignItems: 'center', '&:hover': { bgcolor: '#f8fafc' } }}>
                                                    <Stack direction="row" spacing={2} sx={{ alignItems: 'center' }}>
                                                        <Typography variant="body2" sx={{ fontWeight: 700, color: 'text.secondary', width: 20 }}>
                                                            {idx + 1}
                                                        </Typography>
                                                        <Box sx={{ px: 1.2, py: 0.4, borderRadius: 1.5, bgcolor: '#eff6ff', border: '1px solid #dbeafe' }}>
                                                            <Typography variant="body2" sx={{ fontWeight: 700, color: '#1d4ed8' }}>
                                                                {item.ticker}
                                                            </Typography>
                                                        </Box>
                                                        <Typography variant="body2" sx={{ fontWeight: 550, color: 'text.primary', maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                                            {item.name}
                                                        </Typography>
                                                    </Stack>
                                                    <Stack direction="row" spacing={3} sx={{ alignItems: 'center' }}>
                                                        <Typography variant="body2" sx={{ fontWeight: 600, mr: 1 }}>
                                                            {item.mentions} 提及
                                                        </Typography>
                                                        <Box 
                                                            sx={{ 
                                                                px: 1, 
                                                                py: 0.3, 
                                                                borderRadius: 1, 
                                                                bgcolor: item.mentions_change_pct >= 0 ? '#dcfce7' : '#fee2e2', 
                                                                color: item.mentions_change_pct >= 0 ? '#15803d' : '#b91c1c',
                                                                display: 'flex',
                                                                alignItems: 'center',
                                                                justifyContent: 'center',
                                                                minWidth: 60
                                                            }}
                                                        >
                                                            <Typography variant="caption" sx={{ fontWeight: 700 }}>
                                                                {item.mentions_change_pct >= 0 ? `+${item.mentions_change_pct.toFixed(1)}%` : `${item.mentions_change_pct.toFixed(1)}%`}
                                                            </Typography>
                                                        </Box>
                                                    </Stack>
                                                </Box>
                                            ))
                                        ) : (
                                            <Box sx={{ p: 4, textAlign: 'center' }}>
                                                <Typography color="text.secondary" variant="body2">暂无 Reddit 热门标的数据</Typography>
                                            </Box>
                                        )}
                                    </Stack>
                                </CardContent>
                            </Card>
                        </Grid>

                        {/* r/wallstreetbetsnew */}
                        <Grid item xs={12} md={6}>
                            <Card sx={{ borderRadius: 3.5, border: '1px solid #f1f5f9', boxShadow: '0 4px 20px rgba(0,0,0,0.01)' }}>
                                <Box sx={{ p: 2, bgcolor: '#f8fafc', borderBottom: '1px solid #f1f5f9', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                    <Typography variant="subtitle2" sx={{ fontWeight: 700, color: '#334155' }}>
                                        🦍 r/Wallstreetbetsnew 热门讨论标的
                                    </Typography>
                                    <Typography variant="caption" color="text.secondary">
                                        WSB 散户大本营
                                    </Typography>
                                </Box>
                                <CardContent sx={{ p: 0 }}>
                                    <Stack divider={<Divider />}>
                                        {analysisData.reddit_trending.wallstreetbetsnew && analysisData.reddit_trending.wallstreetbetsnew.length > 0 ? (
                                            analysisData.reddit_trending.wallstreetbetsnew.map((item, idx) => (
                                                <Box key={idx} sx={{ px: 2.5, py: 1.5, display: 'flex', justifyContent: 'space-between', alignItems: 'center', '&:hover': { bgcolor: '#f8fafc' } }}>
                                                    <Stack direction="row" spacing={2} sx={{ alignItems: 'center' }}>
                                                        <Typography variant="body2" sx={{ fontWeight: 700, color: 'text.secondary', width: 20 }}>
                                                            {idx + 1}
                                                        </Typography>
                                                        <Box sx={{ px: 1.2, py: 0.4, borderRadius: 1.5, bgcolor: '#fdf2f8', border: '1px solid #fce7f3' }}>
                                                            <Typography variant="body2" sx={{ fontWeight: 700, color: '#be185d' }}>
                                                                {item.ticker}
                                                            </Typography>
                                                        </Box>
                                                        <Typography variant="body2" sx={{ fontWeight: 550, color: 'text.primary', maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                                            {item.name}
                                                        </Typography>
                                                    </Stack>
                                                    <Stack direction="row" spacing={3} sx={{ alignItems: 'center' }}>
                                                        <Typography variant="body2" sx={{ fontWeight: 600, mr: 1 }}>
                                                            {item.mentions} 提及
                                                        </Typography>
                                                        <Box 
                                                            sx={{ 
                                                                px: 1, 
                                                                py: 0.3, 
                                                                borderRadius: 1, 
                                                                bgcolor: item.mentions_change_pct >= 0 ? '#dcfce7' : '#fee2e2', 
                                                                color: item.mentions_change_pct >= 0 ? '#15803d' : '#b91c1c',
                                                                display: 'flex',
                                                                alignItems: 'center',
                                                                justifyContent: 'center',
                                                                minWidth: 60
                                                            }}
                                                        >
                                                            <Typography variant="caption" sx={{ fontWeight: 700 }}>
                                                                {item.mentions_change_pct >= 0 ? `+${item.mentions_change_pct.toFixed(1)}%` : `${item.mentions_change_pct.toFixed(1)}%`}
                                                            </Typography>
                                                        </Box>
                                                    </Stack>
                                                </Box>
                                            ))
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
