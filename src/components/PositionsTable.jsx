import { Box, Card, CardContent, Chip, LinearProgress, Stack, Typography, useTheme } from '@mui/material';
import { DataGrid, GridToolbar } from '@mui/x-data-grid';
import { number, percent, preciseCurrency, pnlColor } from '../utils/formatters.js';

export default function PositionsTable({ positions, totalMarketValue, compact = false }) {
  const theme = useTheme();

  const rows = positions.map((position) => ({
    id: position.symbol,
    ...position,
    weight: totalMarketValue ? (position.marketValue / totalMarketValue) * 100 : 0,
  }));

  const columns = [
    {
      field: 'name',
      headerName: '标的',
      flex: 1.6,
      minWidth: 220,
      renderCell: ({ row }) => (
        <Box sx={{ minWidth: 0 }}>
          <Typography fontWeight={700} noWrap>{row.displayName || row.name}</Typography>
          <Typography variant="caption" color="text.secondary" noWrap>
            {row.pdfName ? `${row.symbol} · CSV: ${row.name}` : row.symbol}
          </Typography>
        </Box>
      ),
    },
    {
      field: 'assetClass',
      headerName: '类型',
      width: 130,
      renderCell: ({ value }) => <Chip size="small" variant="outlined" label={value} />,
    },
    {
      field: 'quantity',
      headerName: '数量',
      type: 'number',
      width: 120,
      valueFormatter: (value) => number.format(value ?? 0),
      renderCell: ({ row }) => <Typography>{number.format(row.quantity ?? 0)}</Typography>,
    },
    {
      field: 'marketValue',
      headerName: '市值',
      type: 'number',
      width: 140,
      valueFormatter: (value) => preciseCurrency.format(value ?? 0),
      renderCell: ({ row }) => <Typography>{preciseCurrency.format(row.marketValue ?? 0)}</Typography>,
    },
    {
      field: 'weight',
      headerName: '占比',
      type: 'number',
      width: 160,
      valueFormatter: (value) => `${number.format(value ?? 0)}%`,
      renderCell: ({ row }) => (
        <Box sx={{ width: '100%' }}>
          <Typography variant="body2" mb={0.5}>{number.format(row.weight ?? 0)}%</Typography>
          <LinearProgress variant="determinate" value={Math.min(100, row.weight ?? 0)} sx={{ height: 6, borderRadius: 10 }} />
        </Box>
      ),
    },
    {
      field: 'unrealizedPnl',
      headerName: '未实现盈亏',
      type: 'number',
      width: 170,
      valueFormatter: (value) => preciseCurrency.format(value ?? 0),
      renderCell: ({ row }) => (
        <Box sx={{ width: '100%', textAlign: 'right', color: pnlColor(row.unrealizedPnl, theme) }}>
          <Typography fontWeight={700}>{preciseCurrency.format(row.unrealizedPnl)}</Typography>
          <Typography variant="caption">{percent(row.unrealizedPct)}</Typography>
        </Box>
      ),
    },
    {
      field: 'lastTradeDate',
      headerName: '最近交易',
      width: 120,
    },
  ];

  return (
    <Card className="panel-card">
      <CardContent>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ justifyContent: 'space-between', mb: 2 }}>
          <Box>
            <Typography variant="h6">重点持仓</Typography>
            <Typography variant="body2" color="text.secondary">支持搜索、排序、筛选和分页，默认按估算市值排序。</Typography>
          </Box>
          <Chip size="small" color="primary" label={`${rows.length} 个开放仓位`} />
        </Stack>

        <Box className="positions-grid" sx={{ height: compact ? 460 : 720, width: '100%' }}>
          <DataGrid
            rows={rows}
            columns={columns}
            density="compact"
            disableRowSelectionOnClick
            initialState={{
              sorting: { sortModel: [{ field: 'marketValue', sort: 'desc' }] },
              pagination: { paginationModel: { pageSize: 25, page: 0 } },
            }}
            pageSizeOptions={[10, 25, 50, 100]}
            slots={{ toolbar: GridToolbar }}
            slotProps={{
              toolbar: {
                showQuickFilter: true,
                quickFilterProps: { debounceMs: 250 },
                csvOptions: { fileName: 'portfolio-positions' },
                printOptions: { disableToolbarButton: true },
              },
            }}
          />
        </Box>
      </CardContent>
    </Card>
  );
}
