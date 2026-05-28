import { Box, Card, CardContent, Grid, Stack, Typography, useTheme } from '@mui/material';
import { DataGrid, GridToolbar } from '@mui/x-data-grid';
import { Area, Bar, BarChart, CartesianGrid, ComposedChart, Line, Tooltip, XAxis, YAxis } from 'recharts';
import PaidRoundedIcon from '@mui/icons-material/PaidRounded';
import ReceiptRoundedIcon from '@mui/icons-material/ReceiptRounded';
import PercentRoundedIcon from '@mui/icons-material/PercentRounded';
import InventoryRoundedIcon from '@mui/icons-material/InventoryRounded';
import { compactCurrency, number, preciseCurrency, pnlColor } from '../utils/formatters.js';
import MeasuredChart from './MeasuredChart.jsx';

const MONTHLY_CHART_COLORS = {
  net: '#13deb9',
  tax: '#fa896b',
  cumulative: '#5d87ff',
};

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
  );
}

function ChartTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <Box className="chart-tooltip">
      <Typography fontWeight={700}>{label}</Typography>
      <Stack spacing={0.75} sx={{ mt: 0.75 }}>
        {payload.map((item) => (
          <Stack key={item.dataKey || item.name} direction="row" spacing={1} sx={{ alignItems: 'center', justifyContent: 'space-between', minWidth: 190 }}>
            <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
              <Box
                sx={{
                  width: 9,
                  height: 9,
                  borderRadius: '50%',
                  bgcolor: item.stroke || item.color || item.fill || 'text.secondary',
                  flex: '0 0 auto',
                }}
              />
              <Typography color="text.secondary" variant="body2">{item.name}</Typography>
            </Stack>
            <Typography variant="body2" sx={{ color: 'text.primary', fontWeight: 700 }}>
              {item.dataKey === 'count' ? number.format(item.value) : preciseCurrency.format(item.value)}
            </Typography>
          </Stack>
        ))}
      </Stack>
    </Box>
  );
}

function LegendDot({ color, label }) {
  return (
    <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
      <Box sx={{ width: 9, height: 9, borderRadius: '50%', bgcolor: color }} />
      <Typography variant="caption" color="text.secondary">{label}</Typography>
    </Stack>
  );
}

function DividendCharts({ monthly, topSymbols }) {
  let cumulativeNetAmount = monthly.slice(0, Math.max(0, monthly.length - 24)).reduce((total, item) => total + (item.netAmount || 0), 0);
  const recentMonthly = monthly.slice(-24).map((item) => {
    cumulativeNetAmount += item.netAmount || 0;
    return { ...item, cumulativeNetAmount };
  });
  const topTen = topSymbols.slice(0, 10).map((item) => {
    const label = item.displayName || item.name;
    return { ...item, shortName: label.length > 22 ? `${label.slice(0, 22)}…` : label };
  });

  return (
    <Grid container spacing={2}>
      <Grid size={{ xs: 12, lg: 7 }}>
        <Card className="panel-card">
          <CardContent>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ alignItems: { xs: 'flex-start', sm: 'center' }, justifyContent: 'space-between', mb: 2 }}>
              <Typography variant="h6">Dividend / Interest 月度趋势</Typography>
              <Stack direction="row" spacing={1.5} sx={{ flexWrap: 'wrap', rowGap: 0.5 }}>
                <LegendDot color={MONTHLY_CHART_COLORS.net} label="税后收入" />
                <LegendDot color={MONTHLY_CHART_COLORS.tax} label="税费" />
                <LegendDot color={MONTHLY_CHART_COLORS.cumulative} label="累计收入" />
              </Stack>
            </Stack>
            <Box sx={{ height: 330, minWidth: 0 }}>
              <MeasuredChart minHeight={280}>
                {({ width, height }) => (
                  <ComposedChart width={width} height={height} data={recentMonthly} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                    <CartesianGrid stroke="#e5eaef" vertical={false} />
                    <XAxis dataKey="month" tick={{ fill: '#7c8fac', fontSize: 12 }} axisLine={false} tickLine={false} />
                    <YAxis yAxisId="monthly" tickFormatter={compactCurrency} tick={{ fill: '#7c8fac', fontSize: 12 }} axisLine={false} tickLine={false} width={70} />
                    <YAxis yAxisId="cumulative" orientation="right" tickFormatter={compactCurrency} tick={{ fill: MONTHLY_CHART_COLORS.cumulative, fontSize: 12 }} axisLine={false} tickLine={false} width={72} />
                    <Tooltip content={<ChartTooltip />} />
                    <Area yAxisId="monthly" name="税后收入" type="monotone" dataKey="netAmount" stroke={MONTHLY_CHART_COLORS.net} fill={`${MONTHLY_CHART_COLORS.net}55`} strokeWidth={2} />
                    <Area yAxisId="monthly" name="税费" type="monotone" dataKey="tax" stroke={MONTHLY_CHART_COLORS.tax} fill={`${MONTHLY_CHART_COLORS.tax}33`} strokeWidth={2} />
                    <Line yAxisId="cumulative" name="累计收入" type="monotone" dataKey="cumulativeNetAmount" stroke={MONTHLY_CHART_COLORS.cumulative} strokeWidth={2.6} dot={false} activeDot={{ r: 5, strokeWidth: 0 }} />
                  </ComposedChart>
                )}
              </MeasuredChart>
            </Box>
          </CardContent>
        </Card>
      </Grid>
      <Grid size={{ xs: 12, lg: 5 }}>
        <Card className="panel-card">
          <CardContent>
            <Typography variant="h6" mb={2}>Top 收益来源</Typography>
            <Box sx={{ height: 330, minWidth: 0 }}>
              <MeasuredChart minHeight={280}>
                {({ width, height }) => (
                  <BarChart width={width} height={height} data={topTen} layout="vertical" margin={{ left: 16, right: 16 }}>
                    <CartesianGrid stroke="#e5eaef" horizontal={false} />
                    <XAxis type="number" tickFormatter={compactCurrency} tick={{ fill: '#7c8fac', fontSize: 12 }} axisLine={false} tickLine={false} />
                    <YAxis dataKey="shortName" type="category" tick={{ fill: '#7c8fac', fontSize: 12 }} axisLine={false} tickLine={false} width={150} />
                    <Tooltip content={<ChartTooltip />} />
                    <Bar name="税后收入" dataKey="netAmount" fill="#5d87ff" radius={[0, 6, 6, 0]} />
                  </BarChart>
                )}
              </MeasuredChart>
            </Box>
          </CardContent>
        </Card>
      </Grid>
    </Grid>
  );
}

function DividendRecordsGrid({ records }) {
  const theme = useTheme();
  const columns = [
    { field: 'date', headerName: '日期', width: 115 },
    { field: 'type', headerName: '类型', width: 190 },
    {
      field: 'name',
      headerName: '标的',
      flex: 1.4,
      minWidth: 240,
      renderCell: ({ row }) => (
        <Box sx={{ minWidth: 0 }}>
          <Typography fontWeight={700} noWrap>{row.displayName || row.name}</Typography>
          <Typography variant="caption" color="text.secondary" noWrap>
            {row.pdfName ? `${row.symbol} · CSV: ${row.name}` : row.symbol}
          </Typography>
        </Box>
      ),
    },
    { field: 'assetClass', headerName: '资产类型', width: 120 },
    {
      field: 'grossAmount',
      headerName: '税前/原始金额',
      type: 'number',
      width: 150,
      valueFormatter: (value) => preciseCurrency.format(value ?? 0),
      renderCell: ({ row }) => <Typography>{preciseCurrency.format(row.grossAmount ?? 0)}</Typography>,
    },
    {
      field: 'tax',
      headerName: '税费',
      type: 'number',
      width: 130,
      valueFormatter: (value) => preciseCurrency.format(value ?? 0),
      renderCell: ({ row }) => <Typography color={pnlColor(row.tax, theme)}>{preciseCurrency.format(row.tax ?? 0)}</Typography>,
    },
    {
      field: 'netAmount',
      headerName: '税后金额',
      type: 'number',
      width: 140,
      valueFormatter: (value) => preciseCurrency.format(value ?? 0),
      renderCell: ({ row }) => <Typography fontWeight={700} color={pnlColor(row.netAmount, theme)}>{preciseCurrency.format(row.netAmount ?? 0)}</Typography>,
    },
  ];

  return (
    <Card className="panel-card">
      <CardContent>
        <Typography variant="h6" mb={0.5}>Dividend 明细</Typography>
        <Typography variant="body2" color="text.secondary" mb={2}>支持快速搜索、筛选、排序和 CSV 导出。</Typography>
        <Box className="positions-grid" sx={{ height: 620, width: '100%' }}>
          <DataGrid
            rows={records}
            columns={columns}
            density="compact"
            disableRowSelectionOnClick
            initialState={{
              sorting: { sortModel: [{ field: 'date', sort: 'desc' }] },
              pagination: { paginationModel: { pageSize: 25, page: 0 } },
            }}
            pageSizeOptions={[10, 25, 50, 100]}
            slots={{ toolbar: GridToolbar }}
            slotProps={{
              toolbar: {
                showQuickFilter: true,
                quickFilterProps: { debounceMs: 250 },
                csvOptions: { fileName: 'portfolio-dividends' },
                printOptions: { disableToolbarButton: true },
              },
            }}
          />
        </Box>
      </CardContent>
    </Card>
  );
}

export default function DividendTab({ dividend }) {
  const theme = useTheme();
  const { summary, monthly, topSymbols, records } = dividend;

  return (
    <Stack spacing={2}>
      <Grid container spacing={2}>
        <Grid size={{ xs: 12, sm: 6, lg: 3 }}>
          <MetricCard title="税后 Dividend / Income" value={preciseCurrency.format(summary.netAmount)} sub={`${summary.records} 条记录`} icon={PaidRoundedIcon} color={theme.palette.success.main} />
        </Grid>
        <Grid size={{ xs: 12, sm: 6, lg: 3 }}>
          <MetricCard title="原始金额" value={preciseCurrency.format(summary.grossAmount)} sub="CSV amount 合计" icon={ReceiptRoundedIcon} color={theme.palette.primary.main} />
        </Grid>
        <Grid size={{ xs: 12, sm: 6, lg: 3 }}>
          <MetricCard title="税费" value={preciseCurrency.format(summary.tax)} sub="tax 字段合计" icon={PercentRoundedIcon} color={theme.palette.error.main} />
        </Grid>
        <Grid size={{ xs: 12, sm: 6, lg: 3 }}>
          <MetricCard title="收益来源" value={number.format(summary.symbols)} sub="按 symbol/name 聚合" icon={InventoryRoundedIcon} color={theme.palette.warning.main} />
        </Grid>
      </Grid>
      <DividendCharts monthly={monthly} topSymbols={topSymbols} />
      <DividendRecordsGrid records={records} />
    </Stack>
  );
}
