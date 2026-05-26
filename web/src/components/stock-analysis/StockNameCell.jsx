import { Box, Typography } from '@mui/material'

export default function StockNameCell({ row }) {
  return (
    <Box sx={{ minWidth: 0 }}>
      <Typography variant="body2" fontWeight={800} noWrap>{row.groupName || row.stockName}</Typography>
      <Typography variant="caption" color="text.secondary" noWrap>
        {row.derivativeCount != null ? `${row.stockCount} 股票/ETF · ${row.derivativeCount} 衍生品` : row.symbol}
      </Typography>
    </Box>
  )
}
