import { Card, CardContent, Chip, Grid, LinearProgress, Stack, Typography, Box, useTheme } from '@mui/material';
import TrendingUpRoundedIcon from '@mui/icons-material/TrendingUpRounded';
import AccountBalanceWalletRoundedIcon from '@mui/icons-material/AccountBalanceWalletRounded';
import SavingsRoundedIcon from '@mui/icons-material/SavingsRounded';
import ReceiptLongRoundedIcon from '@mui/icons-material/ReceiptLongRounded';
import PaidRoundedIcon from '@mui/icons-material/PaidRounded';
import { currency, percent, preciseCurrency, pnlColor } from '../utils/formatters.js';

function StatPill({ label, value, color }) {
  return (
    <Stack direction="row" spacing={2} sx={{ justifyContent: 'space-between', alignItems: 'center' }}>
      <Typography variant="body2" color="text.secondary">{label}</Typography>
      <Typography variant="body2" fontWeight={700} color={color}>{value}</Typography>
    </Stack>
  );
}

function PortfolioValueCard({ summary }) {
  const theme = useTheme();
  const investedRatio = summary.totalMarketValue > 0
    ? Math.min(100, Math.max(0, (summary.totalCostBasis / summary.totalMarketValue) * 100))
    : 0;

  return (
    <Card className="metric-card">
      <CardContent>
        <Stack spacing={2.25}>
          <Stack direction="row" spacing={2} sx={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <Box>
              <Typography color="text.secondary" variant="body2">Agent-Foundry</Typography>
              <Typography variant="h3" mt={0.75} fontWeight={900}>{currency.format(summary.totalMarketValue)}</Typography>
              <Typography color="text.secondary" variant="body2" mt={0.5}>估算持仓市值 · {summary.openPositions} 个开放仓位</Typography>
            </Box>
            <Box className="metric-icon" sx={{ color: theme.palette.primary.main }}>
              <AccountBalanceWalletRoundedIcon />
            </Box>
          </Stack>

          <Box>
            <Stack direction="row" sx={{ justifyContent: 'space-between', mb: 0.75 }}>
              <Typography variant="caption" color="text.secondary">成本占市值</Typography>
              <Typography variant="caption" color="text.secondary">{preciseCurrency.format(summary.totalCostBasis)}</Typography>
            </Stack>
            <LinearProgress variant="determinate" value={investedRatio} sx={{ height: 8, borderRadius: 8 }} />
          </Box>

          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.25}>
            <Chip size="small" color="success" variant="outlined" label={`盈利仓位 ${summary.winners}`} />
            <Chip size="small" color="error" variant="outlined" label={`亏损仓位 ${summary.losers}`} />
          </Stack>
        </Stack>
      </CardContent>
    </Card>
  );
}

const polarToCartesian = (cx, cy, r, angle) => {
  const radians = (angle * Math.PI) / 180;
  return {
    x: cx + r * Math.cos(radians),
    y: cy + r * Math.sin(radians),
  };
};

const describeArc = (cx, cy, r, startAngle, endAngle) => {
  const start = polarToCartesian(cx, cy, r, startAngle);
  const end = polarToCartesian(cx, cy, r, endAngle);
  const largeArcFlag = endAngle - startAngle <= 180 ? 0 : 1;
  return `M ${start.x} ${start.y} A ${r} ${r} 0 ${largeArcFlag} 1 ${end.x} ${end.y}`;
};

const profitGaugeColors = {
  unrealized: '#F9F9FD',
  realized: '#5D87FF',
  income: '#EB7900',
};

function GaugeLegend({ label, value, color, valueColor }) {
  return (
    <Stack
      direction="row"
      spacing={0.75}
      sx={{ alignItems: 'center', minWidth: 0, px: 0.25 }}
    >
      <Box sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: color, border: '1px solid #E5EAEF', flexShrink: 0 }} />
      <Typography variant="caption" color="text.secondary" noWrap>{label}</Typography>
      <Typography variant="caption" fontWeight={900} color={valueColor || color} noWrap>{value}</Typography>
    </Stack>
  );
}

function HalfMoonProfitChart({ summary, totalPnl }) {
  const theme = useTheme();
  const segments = [
    { key: 'realized', label: '已实现', value: summary.realizedPnl, color: profitGaugeColors.realized },
    { key: 'income', label: '股息', value: summary.income, color: profitGaugeColors.income },
    { key: 'unrealized', label: '未实现', value: summary.unrealizedPnl, color: profitGaugeColors.unrealized },
  ].filter((item) => Math.abs(item.value || 0) > 0.01);

  const visibleSegments = segments.length ? segments : [{ key: 'empty', label: '暂无', value: 1, color: theme.palette.divider }];
  const absoluteTotal = visibleSegments.reduce((sum, item) => sum + Math.abs(item.value), 0);
  let cursor = 180;

  const arcs = visibleSegments.map((item) => {
    const share = Math.abs(item.value) / absoluteTotal;
    const start = cursor;
    const end = Math.min(360, cursor + share * 180);
    cursor += share * 180;
    return { ...item, start, end };
  });

  return (
    <Stack
      direction="row"
      spacing={{ xs: 1.75, sm: 3 }}
      sx={{ alignItems: 'center', justifyContent: 'center', maxWidth: 560, mx: 'auto' }}
    >
      <Box sx={{ flex: '1 1 0', minWidth: 0, maxWidth: 380 }}>
        <Box component="svg" viewBox="0 0 360 210" role="img" aria-label="盈亏股息半圆图" sx={{ width: '100%', display: 'block' }}>
          <path
            d={describeArc(180, 165, 118, 180, 360)}
            fill="none"
            stroke={theme.palette.primary.light}
            strokeWidth="28"
            strokeLinecap="butt"
          />
          {arcs.map((arc) => (
            <path
              key={arc.key}
              d={describeArc(180, 165, 118, arc.start, arc.end)}
              fill="none"
              stroke={arc.color}
              strokeWidth="28"
              strokeLinecap="butt"
            />
          ))}
          <text x="180" y="132" textAnchor="middle" fill={theme.palette.text.secondary} fontSize="13" fontWeight="700">总盈亏 / 股息</text>
          <text x="180" y="164" textAnchor="middle" fill={pnlColor(totalPnl, theme)} fontSize="31" fontWeight="900">
            {preciseCurrency.format(totalPnl)}
          </text>
        </Box>

        <Stack
          direction="row"
          spacing={{ xs: 0.75, sm: 1 }}
          sx={{ mt: -1, justifyContent: 'space-between', flexWrap: 'nowrap', width: '100%', overflow: 'hidden' }}
        >
          <GaugeLegend label="已实现" value={preciseCurrency.format(summary.realizedPnl)} color={profitGaugeColors.realized} />
          <GaugeLegend label="股息" value={preciseCurrency.format(summary.income)} color={profitGaugeColors.income} valueColor={theme.palette.text.primary} />
          <GaugeLegend
            label="未实现"
            value={preciseCurrency.format(summary.unrealizedPnl)}
            color={profitGaugeColors.unrealized}
            valueColor={theme.palette.text.primary}
          />
        </Stack>
      </Box>

      <Box sx={{ flexShrink: 0, minWidth: { xs: 96, sm: 118 } }}>
        <Typography variant="caption" color="text.secondary" fontWeight={800}>
          浮盈率
        </Typography>
        <Typography
          variant="h4"
          color={pnlColor(summary.unrealizedPct, theme)}
          fontWeight={900}
          sx={{ mt: 0.25, letterSpacing: '-0.02em' }}
        >
          {percent(summary.unrealizedPct)}
        </Typography>
      </Box>
    </Stack>
  );
}

function ProfitDashboardCard({ summary }) {
  const theme = useTheme();
  const totalRealizedIncome = summary.realizedPnl + summary.income;
  const totalPnl = summary.unrealizedPnl + totalRealizedIncome;

  return (
    <Card className="metric-card">
      <CardContent>
        <Stack spacing={1.75}>
          <Stack direction="row" spacing={2} sx={{ justifyContent: 'space-between', alignItems: 'center' }}>
            <Typography variant="h6" fontWeight={900}>盈亏 / 股息仪表盘</Typography>
            <Box className="metric-icon" sx={{ color: pnlColor(totalPnl, theme) }}>
              <TrendingUpRoundedIcon />
            </Box>
          </Stack>

          <HalfMoonProfitChart summary={summary} totalPnl={totalPnl} />
        </Stack>
      </CardContent>
    </Card>
  );
}

function CashflowCard({ summary }) {
  const theme = useTheme();
  const netExternalCash = summary.totalDeposits + summary.totalWithdrawals;

  return (
    <Card className="metric-card">
      <CardContent>
        <Stack direction="row" spacing={2} sx={{ justifyContent: 'space-between' }}>
          <Box sx={{ minWidth: 0, flex: 1 }}>
            <Typography color="text.secondary" variant="body2">现金流概览</Typography>
            <Typography variant="h5" mt={1} color={pnlColor(netExternalCash, theme)}>{preciseCurrency.format(netExternalCash)}</Typography>
            <Typography color="text.secondary" variant="body2" mt={0.5}>入金 - 出金后的净外部现金流</Typography>
            <Stack spacing={0.75} sx={{ mt: 1.5 }}>
              <StatPill label="累计入金" value={preciseCurrency.format(summary.totalDeposits)} color={theme.palette.success.main} />
              <StatPill label="累计出金" value={preciseCurrency.format(summary.totalWithdrawals)} color={theme.palette.error.main} />
            </Stack>
          </Box>
          <Box className="metric-icon" sx={{ color: theme.palette.primary.main }}>
            <PaidRoundedIcon />
          </Box>
        </Stack>
      </CardContent>
    </Card>
  );
}

function TradingCashflowCard({ summary }) {
  const theme = useTheme();

  return (
    <Card className="metric-card">
      <CardContent>
        <Stack direction="row" spacing={2} sx={{ justifyContent: 'space-between' }}>
          <Box sx={{ minWidth: 0, flex: 1 }}>
            <Typography color="text.secondary" variant="body2">交易现金流</Typography>
            <Typography variant="h5" mt={1} color={pnlColor(summary.tradingCashflow, theme)}>{preciseCurrency.format(summary.tradingCashflow)}</Typography>
            <Typography color="text.secondary" variant="body2" mt={0.5}>买入 / 卖出 / 费用 / 税费后的交易流出入</Typography>
            <Stack spacing={0.75} sx={{ mt: 1.5 }}>
              <StatPill label="开放仓位" value={`${summary.openPositions}`} color={theme.palette.text.primary} />
              <StatPill label="胜率粗略" value={`${Math.round((summary.winners / Math.max(1, summary.openPositions)) * 100)}%`} color={theme.palette.success.main} />
            </Stack>
          </Box>
          <Box className="metric-icon" sx={{ color: pnlColor(summary.tradingCashflow, theme) }}>
            <ReceiptLongRoundedIcon />
          </Box>
        </Stack>
      </CardContent>
    </Card>
  );
}

export default function SummaryCards({ summary }) {
  return (
    <Grid container spacing={2}>
      <Grid size={{ xs: 12, lg: 5 }}>
        <PortfolioValueCard summary={summary} />
      </Grid>
      <Grid size={{ xs: 12, lg: 7 }}>
        <ProfitDashboardCard summary={summary} />
      </Grid>
      <Grid size={{ xs: 12, md: 6 }}>
        <CashflowCard summary={summary} />
      </Grid>
      <Grid size={{ xs: 12, md: 6 }}>
        <TradingCashflowCard summary={summary} />
      </Grid>
    </Grid>
  );
}
