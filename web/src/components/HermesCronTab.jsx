import { useCallback, useEffect, useState } from 'react'
import { Alert, Box, Card, CardContent, Chip, CircularProgress, Grid, Stack, Tooltip, Typography, useTheme } from '@mui/material'
import { DataGrid, GridToolbar } from '@mui/x-data-grid'
import ScheduleRoundedIcon from '@mui/icons-material/ScheduleRounded'
import CheckCircleRoundedIcon from '@mui/icons-material/CheckCircleRounded'
import PauseCircleRoundedIcon from '@mui/icons-material/PauseCircleRounded'
import ErrorRoundedIcon from '@mui/icons-material/ErrorRounded'
import DnsRoundedIcon from '@mui/icons-material/DnsRounded'
import RefreshRoundedIcon from '@mui/icons-material/RefreshRounded'
import { dateTime, number, relativeDuration } from '../utils/formatters.js'
import { useHermesCronData } from '../hooks/useHermesCronData.js'

function MetricCard({ title, value, sub, icon: Icon, color }) {
    return (
        <Card className="metric-card">
            <CardContent>
                <Stack direction="row" spacing={2} sx={{ justifyContent: 'space-between' }}>
                    <Box>
                        <Typography color="text.secondary" variant="body2">{title}</Typography>
                        <Typography variant="h5" mt={1} color={color}>{value}</Typography>
                        <Typography color="text.secondary" variant="body2" mt={0.5}>{sub}</Typography>
                    </Box>
                    <Box className="metric-icon" sx={{ color }}><Icon /></Box>
                </Stack>
            </CardContent>
        </Card>
    )
}

function statusPillMeta(row) {
    const label = row.statusLabel || 'Scheduled'

    if (row.statusGroup === 'failed' || row.statusGroup === 'delivery_failed') {
        return { label, color: '#fa896b', bg: '#fff1ee', border: '#ffc9bd' }
    }
    if (row.statusGroup === 'paused') {
        return { label, color: '#ffae1f', bg: '#fff9df', border: '#ffe18a' }
    }
    if (row.statusGroup === 'pending') {
        return { label, color: '#49beff', bg: '#edf8ff', border: '#a9dcff' }
    }
    return { label, color: '#13deb9', bg: '#e9fff9', border: '#9bf3df' }
}

function StatusPill({ row }) {
    const meta = statusPillMeta(row)
    return (
        <Box
            component="span"
            sx={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 0.75,
                px: 1,
                py: 0.25,
                borderRadius: '6px',
                border: `1px solid ${meta.border}`,
                backgroundColor: meta.bg,
                color: '#2a3547',
                fontSize: 13,
                fontWeight: 600,
                lineHeight: 1.35,
                whiteSpace: 'nowrap',
            }}
        >
            <Box
                component="span"
                sx={{
                    width: 6,
                    height: 6,
                    borderRadius: '50%',
                    backgroundColor: meta.color,
                    boxShadow: `0 0 0 2px ${meta.bg}`,
                    flexShrink: 0,
                }}
            />
            {meta.label}
        </Box>
    )
}

function TextWithTooltip({ value, variant = 'body2', color, fontWeight }) {
    const text = value || '—'
    return (
        <Tooltip title={text} arrow enterDelay={400} placement="bottom">
            <Typography
                component="span"
                variant={variant}
                color={color}
                fontWeight={fontWeight}
                noWrap
                sx={{ display: 'block', minWidth: 0, maxWidth: '100%' }}
            >
                {text}
            </Typography>
        </Tooltip>
    )
}

function JobsGrid({ jobs }) {
    const theme = useTheme()
    const [now, setNow] = useState(() => new Date())

    useEffect(() => {
        const timer = window.setInterval(() => setNow(new Date()), 60000)
        return () => window.clearInterval(timer)
    }, [])

    const columns = [
        {
            field: 'name',
            headerName: '任务',
            flex: 1.5,
            minWidth: 270,
            valueGetter: (_, row) => row.name || '',
            renderCell: ({ row }) => (
                <TextWithTooltip value={row.name} fontWeight={700} />
            ),
        },
        {
            field: 'scheduleLabel',
            headerName: '调度',
            minWidth: 190,
            flex: 0.9,
            valueGetter: (_, row) => row.scheduleLabel || row.schedule || '',
            renderCell: ({ row }) => <TextWithTooltip value={row.scheduleLabel || row.schedule} />,
        },
        {
            field: 'nextRunAt',
            headerName: '下次运行',
            minWidth: 165,
            flex: 0.9,
            valueFormatter: (value) => relativeDuration(value, now),
            renderCell: ({ row }) => <Typography variant="body2" fontWeight={700} noWrap>{relativeDuration(row.nextRunAt, now)}</Typography>,
        },
        {
            field: 'lastRunAt',
            headerName: '上次运行',
            minWidth: 165,
            flex: 0.9,
            valueFormatter: (value) => dateTime(value),
            renderCell: ({ row }) => <Typography variant="body2" noWrap>{dateTime(row.lastRunAt)}</Typography>,
        },
        {
            field: 'deliverLabel',
            headerName: '投递目标',
            minWidth: 190,
            flex: 1,
            valueGetter: (_, row) => row.deliverLabel || row.deliver || '',
            renderCell: ({ row }) => (
                <Box sx={{ minWidth: 0 }}>
                    <TextWithTooltip value={row.deliverLabel || row.deliver} />
                    {row.lastDeliveryError && (
                        <TextWithTooltip value={row.lastDeliveryError} variant="caption" color={theme.palette.error.main} />
                    )}
                </Box>
            ),
        },
        {
            field: 'runtime',
            headerName: '模型',
            minWidth: 120,
            flex: 0.55,
            sortable: false,
            valueGetter: (_, row) => row.model || '',
            renderCell: ({ row }) => <TextWithTooltip value={row.model || '默认模型'} />,
        },
        {
            field: 'status',
            headerName: '状态',
            minWidth: 150,
            flex: 0.75,
            valueGetter: (_, row) => statusPillMeta(row).label,
            renderCell: ({ row }) => <StatusPill row={row} />,
        },
        {
            field: 'completedRuns',
            headerName: '已运行',
            type: 'number',
            width: 105,
            valueFormatter: (value) => number.format(value ?? 0),
            renderCell: ({ row }) => <Typography>{number.format(row.completedRuns ?? 0)}</Typography>,
        },
    ]

    return (
        <Card className="panel-card">
            <CardContent>
                <Stack direction={{ xs: 'column', md: 'row' }} spacing={1} sx={{ justifyContent: 'space-between', mb: 2 }}>
                    <Box>
                        <Typography variant="h6">Hermes Cron Jobs</Typography>

                    </Box>
                    <Chip color="primary" size="small" label={`${jobs.length} 个任务`} />
                </Stack>
                <Box className="positions-grid" sx={{ height: 650, width: '100%' }}>
                    <DataGrid
                        rows={jobs}
                        columns={columns}
                        density="compact"
                        disableRowSelectionOnClick
                        initialState={{
                            sorting: { sortModel: [{ field: 'nextRunAt', sort: 'asc' }] },
                            pagination: { paginationModel: { pageSize: 25, page: 0 } },
                        }}
                        pageSizeOptions={[10, 25, 50, 100]}
                        slots={{ toolbar: GridToolbar }}
                        slotProps={{
                            toolbar: {
                                showQuickFilter: true,
                                quickFilterProps: { debounceMs: 250 },
                                csvOptions: { fileName: 'hermes-cron-status' },
                                printOptions: { disableToolbarButton: true },
                            },
                        }}
                    />
                </Box>
            </CardContent>
        </Card>
    )
}

// ---------------------------------------------------------------------------
// Systemd unit status section
// ---------------------------------------------------------------------------
const UNIT_STATE_COLORS = {
    active: '#13deb9',
    inactive: '#ffae1f',
    failed: '#fa896b',
    activating: '#49beff',
    deactivating: '#49beff',
    'not-found': '#8b8b8b',
    error: '#fa896b',
    unknown: '#8b8b8b',
}

const UNIT_ENABLED_COLORS = {
    enabled: '#13deb9',
    disabled: '#ffae1f',
    static: '#49beff',
    indirect: '#13deb9',
    'not-found': '#8b8b8b',
    error: '#fa896b',
    unknown: '#8b8b8b',
}

function stateLabel(state) {
    const map = {
        active: '运行中', inactive: '未运行', failed: '异常',
        activating: '启动中', deactivating: '停止中',
        'not-found': '未安装', error: '查询失败', unknown: '未知',
    }
    return map[state] || state
}

function enabledLabel(state) {
    const map = {
        enabled: '已启用', disabled: '已禁用', static: '静态',
        indirect: '间接启用', 'not-found': '未安装', error: '查询失败', unknown: '未知',
    }
    return map[state] || state
}

function SystemdStatusCards() {
    const [data, setData] = useState(null)
    const [error, setError] = useState(null)

    const fetchStatus = useCallback(() => {
        fetch('/api/systemd/units', { cache: 'no-store' })
            .then((r) => r.json())
            .then(setData)
            .catch(setError)
    }, [])

    useEffect(() => {
        fetchStatus()
        const timer = setInterval(fetchStatus, 60000)
        return () => clearInterval(timer)
    }, [fetchStatus])

    if (error) {
        return (
            <Alert severity="info" sx={{ mt: 2 }}>
                systemd 状态暂不可用（可能运行在非 systemd 环境）
            </Alert>
        )
    }

    if (!data || !data.available) {
        return null
    }

    return (
        <Card className="panel-card" sx={{ mt: 2 }}>
            <CardContent>
                <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 2 }}>
                    <DnsRoundedIcon color="primary" />
                    <Typography variant="h6">systemd 服务状态</Typography>
                    <Chip size="small" label={`更新 ${dateTime(data.generatedAt)}`} variant="outlined" />
                </Stack>
                <Grid container spacing={2}>
                    {data.units.map((unit) => (
                        <Grid size={{ xs: 12, sm: 6, md: 4 }} key={unit.unit}>
                            <Card variant="outlined" sx={{ height: '100%' }}>
                                <CardContent sx={{ py: 1.5, px: 2, '&:last-child': { pb: 1.5 } }}>
                                    <Typography variant="body2" fontWeight={700} noWrap>
                                        {unit.label}
                                    </Typography>
                                    <Typography variant="caption" color="text.secondary" noWrap sx={{ display: 'block' }}>
                                        {unit.unit}
                                    </Typography>
                                    <Stack direction="row" spacing={1.5} sx={{ mt: 1 }}>
                                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                                            <Box sx={{
                                                width: 8, height: 8, borderRadius: '50%',
                                                backgroundColor: UNIT_STATE_COLORS[unit.activeState] || '#8b8b8b',
                                                flexShrink: 0,
                                            }} />
                                            <Typography variant="caption" fontWeight={600}>
                                                {stateLabel(unit.activeState)}
                                            </Typography>
                                        </Box>
                                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                                            <Box sx={{
                                                width: 8, height: 8, borderRadius: '50%',
                                                backgroundColor: UNIT_ENABLED_COLORS[unit.enabledState] || '#8b8b8b',
                                                flexShrink: 0,
                                            }} />
                                            <Typography variant="caption" fontWeight={600}>
                                                {enabledLabel(unit.enabledState)}
                                            </Typography>
                                        </Box>
                                    </Stack>
                                </CardContent>
                            </Card>
                        </Grid>
                    ))}
                </Grid>
            </CardContent>
        </Card>
    )
}

// ---------------------------------------------------------------------------
// Auto-refresh status (Tier 1 structured products)
// ---------------------------------------------------------------------------
function AutoRefreshStatusCard() {
    const [status, setStatus] = useState(null)

    const fetchStatus = useCallback(() => {
        fetch('/api/structured-products-enrichment/status', { cache: 'no-store' })
            .then((r) => r.json())
            .then(setStatus)
            .catch(() => {})
    }, [])

    useEffect(() => {
        fetchStatus()
        const timer = setInterval(fetchStatus, 30000)
        return () => clearInterval(timer)
    }, [fetchStatus])

    if (!status) return null

    const active = status.autoRefreshActive
    const lastRefresh = status.lastScheduledRefreshAt
    const lastActualRefresh = status.lastFinishedAt || status.lastStartedAt
    const waitingForFirstSchedule = active && !lastRefresh

    return (
        <Card className="panel-card" sx={{ mt: 2 }}>
            <CardContent>
                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} sx={{ justifyContent: 'space-between', alignItems: { xs: 'flex-start', sm: 'center' } }}>
                    <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                        <RefreshRoundedIcon color={active ? 'success' : 'disabled'} />
                        <Box>
                            <Typography variant="h6" component="span">Tier 1 自动刷新</Typography>
                            <Chip
                                size="small"
                                label={active ? '运行中' : '已停止'}
                                color={active ? 'success' : 'default'}
                                sx={{ ml: 1 }}
                            />
                        </Box>
                    </Stack>
                    <Stack direction="row" spacing={2} useFlexGap sx={{ flexWrap: 'wrap' }}>
                        <Typography variant="body2" color="text.secondary">
                            上次调度刷新：{lastRefresh ? dateTime(lastRefresh) : '—'}
                        </Typography>
                        <Typography variant="body2" color="text.secondary">
                            上次实际刷新：{lastActualRefresh ? dateTime(lastActualRefresh) : '—'}
                        </Typography>
                        {status.running && (
                            <Typography variant="body2" color="primary.main" fontWeight={600}>
                                正在刷新中 ({status.progressPercent}%)
                            </Typography>
                        )}
                    </Stack>
                </Stack>
                {waitingForFirstSchedule && (
                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
                        尚未触发调度；自动刷新只在 XETRA 交易日 08:00–22:00 CET 内执行，周末和节假日会等待下一交易窗口。
                    </Typography>
                )}
            </CardContent>
        </Card>
    )
}

export default function HermesCronTab() {
    const theme = useTheme()
    const { loading, error, data, refreshedAt } = useHermesCronData()

    if (loading) {
        return (
            <Box sx={{ minHeight: 360, display: 'grid', placeItems: 'center' }}>
                <Stack spacing={2} sx={{ alignItems: 'center' }}>
                    <CircularProgress />
                    <Typography color="text.secondary">正在读取 Hermes cron 状态...</Typography>
                </Stack>
            </Box>
        )
    }

    if (error) {
        return <Alert severity="error">Hermes cron 状态加载失败：{error.message}。请确认当前页面地址能访问 /data/hermes-cron-status.json。</Alert>
    }

    const summary = data?.summary || {}
    const jobs = data?.jobs || []
    const source = data?.source || {}

    return (
        <Stack spacing={2}>
            {source.readError && <Alert severity="warning">Cron 数据源读取异常：{source.readError}</Alert>}
            <Grid container spacing={2}>
                <Grid size={{ xs: 12, sm: 6, lg: 3 }}>
                    <MetricCard title="总任务" value={number.format(summary.total ?? 0)} sub={`数据生成 ${dateTime(data.generatedAt)}`} icon={ScheduleRoundedIcon} color={theme.palette.primary.main} />
                </Grid>
                <Grid size={{ xs: 12, sm: 6, lg: 3 }}>
                    <MetricCard title="运行中 / 已启用" value={number.format(summary.active ?? 0)} sub="enabled 且未暂停" icon={CheckCircleRoundedIcon} color={theme.palette.success.main} />
                </Grid>
                <Grid size={{ xs: 12, sm: 6, lg: 3 }}>
                    <MetricCard title="暂停" value={number.format(summary.paused ?? 0)} sub="paused 或 enabled=false" icon={PauseCircleRoundedIcon} color={theme.palette.warning.main} />
                </Grid>
                <Grid size={{ xs: 12, sm: 6, lg: 3 }}>
                    <MetricCard title="异常" value={number.format(summary.error ?? 0)} sub={`${summary.withDeliveryError ?? 0} 个投递错误`} icon={ErrorRoundedIcon} color={theme.palette.error.main} />
                </Grid>
            </Grid>

            <SystemdStatusCards />
            <AutoRefreshStatusCard />

            <Card className="panel-card">
                <CardContent>
                    <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5} sx={{ justifyContent: 'space-between', alignItems: { xs: 'flex-start', md: 'center' } }}>
                        <Box>
                            <Typography variant="h6">数据源</Typography>
                            <Typography variant="body2" color="text.secondary">读取本机 Hermes cron jobs.json 的脱敏快照，不包含任务完整 prompt。</Typography>
                        </Box>
                        <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
                            <Chip color="primary" variant="outlined" label={`页面刷新 ${dateTime(refreshedAt)}`} />
                        </Stack>
                    </Stack>
                </CardContent>
            </Card>

            <JobsGrid jobs={jobs} />
        </Stack>
    )
}
