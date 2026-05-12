import { useState } from 'react';
import { Card, CardContent, Dialog, DialogContent, DialogTitle, Grid, IconButton, Stack, Tooltip as MuiTooltip, Typography, Box } from '@mui/material';
import CloseRoundedIcon from '@mui/icons-material/CloseRounded';
import ZoomOutMapRoundedIcon from '@mui/icons-material/ZoomOutMapRounded';
import { Area, AreaChart, CartesianGrid, Cell, Pie, PieChart, Tooltip, XAxis, YAxis } from 'recharts';
import { compactCurrency, preciseCurrency } from '../utils/formatters.js';
import MeasuredChart from './MeasuredChart.jsx';

const COLORS = ['#5d87ff', '#13deb9', '#ffae1f', '#fa896b', '#635bff', '#49beff'];

function ChartTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <Box className="chart-tooltip">
      <Typography fontWeight={700}>{label || payload[0].name}</Typography>
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
              {preciseCurrency.format(item.value)}
            </Typography>
          </Stack>
        ))}
      </Stack>
    </Box>
  );
}

const shortMonth = (month) => month?.slice(2)?.replace('-', '/') || '';

const chartRange = (values) => {
  const valid = values.filter((value) => Number.isFinite(value));
  if (!valid.length) return { min: -1, max: 1 };
  const minValue = Math.min(0, ...valid);
  const maxValue = Math.max(0, ...valid);
  if (minValue === maxValue) return { min: minValue - 1, max: maxValue + 1 };
  const padding = (maxValue - minValue) * 0.12;
  return { min: minValue - padding, max: maxValue + padding };
};

const yScale = (value, min, max, height, topPad = 18, bottomPad = 34) => {
  const innerHeight = height - topPad - bottomPad;
  return topPad + ((max - value) / (max - min)) * innerHeight;
};

function LegendDot({ color, label }) {
  return (
    <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
      <Box sx={{ width: 9, height: 9, borderRadius: '50%', bgcolor: color }} />
      <Typography variant="caption" color="text.secondary">{label}</Typography>
    </Stack>
  );
}

function EmptyChart({ message = '暂无可展示数据' }) {
  return (
    <Box sx={{ height: '100%', display: 'grid', placeItems: 'center', color: 'text.secondary' }}>
      <Typography variant="body2">{message}</Typography>
    </Box>
  );
}

function ChartTitle({ title, onExpand }) {
  return (
    <Stack direction="row" spacing={1} sx={{ alignItems: 'center', justifyContent: 'space-between', mb: 2 }}>
      <Typography variant="h6">{title}</Typography>
      <MuiTooltip title="放大查看交互式图表">
        <IconButton size="small" onClick={onExpand} aria-label={`放大查看${title}`}>
          <ZoomOutMapRoundedIcon fontSize="small" />
        </IconButton>
      </MuiTooltip>
    </Stack>
  );
}

function InteractiveTooltip({ x, y, title, rows, width = 210 }) {
  const clampedX = Math.min(Math.max(92, x), 960 - width - 18);
  const clampedY = Math.max(18, y - 92);
  const height = 34 + rows.length * 21;
  return (
    <g pointerEvents="none">
      <rect x={clampedX} y={clampedY} width={width} height={height} rx="10" fill="rgba(255,255,255,0.98)" stroke="#e5eaef" />
      <text x={clampedX + 12} y={clampedY + 22} fill="#2a3547" fontSize="13" fontWeight="700">{title}</text>
      {rows.map((row, index) => (
        <g key={row.label}>
          <circle cx={clampedX + 14} cy={clampedY + 44 + index * 21} r="4" fill={row.color} />
          <text x={clampedX + 25} y={clampedY + 48 + index * 21} fill="#7c8fac" fontSize="12">{row.label}</text>
          <text x={clampedX + width - 12} y={clampedY + 48 + index * 21} fill="#2a3547" fontSize="12" textAnchor="end">{preciseCurrency.format(row.value || 0)}</text>
        </g>
      ))}
    </g>
  );
}

function CashFlowTrend({ data }) {
  const [hoveredIndex, setHoveredIndex] = useState(null);
  const width = 960;
  const height = 320;
  const leftPad = 76;
  const rightPad = 20;
  const topPad = 18;
  const bottomPad = 38;
  const values = data.flatMap((item) => [item.netCash, item.trading]);
  const { min, max } = chartRange(values);
  const innerWidth = width - leftPad - rightPad;
  const step = data.length > 1 ? innerWidth / (data.length - 1) : 0;
  const xFor = (index) => leftPad + index * step;
  const yFor = (value) => yScale(value, min, max, height, topPad, bottomPad);
  const zeroY = yFor(0);
  const netCashPath = data.map((item, index) => `${index === 0 ? 'M' : 'L'} ${xFor(index)} ${yFor(item.netCash)}`).join(' ');
  const tradingPath = data.map((item, index) => `${index === 0 ? 'M' : 'L'} ${xFor(index)} ${yFor(item.trading)}`).join(' ');
  const hoveredItem = hoveredIndex === null ? null : data[hoveredIndex];
  const hoveredX = hoveredIndex === null ? 0 : xFor(hoveredIndex);
  const hoveredY = hoveredItem ? Math.min(yFor(hoveredItem.netCash), yFor(hoveredItem.trading)) : 0;

  if (!data.length || !values.some((value) => Math.abs(value) > 0.01)) return <EmptyChart />;

  return (
    <Box sx={{ width: '100%', height: '100%' }}>
      <Stack direction="row" spacing={2} sx={{ justifyContent: 'flex-end', mb: 1 }}>
        <LegendDot color="#5d87ff" label="净现金" />
        <LegendDot color="#13deb9" label="交易净额" />
      </Stack>
      <Box component="svg" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="xMidYMid meet" sx={{ width: '100%', height: 'calc(100% - 24px)', display: 'block' }}>
        {[0.25, 0.5, 0.75].map((ratio) => {
          const y = topPad + (height - topPad - bottomPad) * ratio;
          return <line key={ratio} x1={leftPad} x2={width - rightPad} y1={y} y2={y} stroke="#e5eaef" />;
        })}
        <line x1={leftPad} x2={width - rightPad} y1={zeroY} y2={zeroY} stroke="rgba(124,143,172,0.35)" strokeDasharray="4 6" />
        <text x={8} y={yFor(max)} fill="#7c8fac" fontSize="12">{compactCurrency(max)}</text>
        <text x={8} y={zeroY + 4} fill="#7c8fac" fontSize="12">€0</text>
        <text x={8} y={yFor(min)} fill="#7c8fac" fontSize="12">{compactCurrency(min)}</text>
        <path d={netCashPath} fill="none" stroke="#5d87ff" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        <path d={tradingPath} fill="none" stroke="#13deb9" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        {data.map((item, index) => (
          <g key={item.month}>
            <circle cx={xFor(index)} cy={yFor(item.netCash)} r={hoveredIndex === index ? 6 : 4} fill="#5d87ff" vectorEffect="non-scaling-stroke" />
            <circle cx={xFor(index)} cy={yFor(item.trading)} r={hoveredIndex === index ? 6 : 4} fill="#13deb9" vectorEffect="non-scaling-stroke" />
            {index % 3 === 0 || index === data.length - 1 ? (
              <text x={xFor(index)} y={height - 10} fill="#7c8fac" fontSize="12" textAnchor="middle">{shortMonth(item.month)}</text>
            ) : null}
          </g>
        ))}
        {data.map((item, index) => (
          <rect
            key={`hit-${item.month}`}
            x={xFor(index) - Math.max(12, step / 2)}
            y={topPad}
            width={Math.max(24, step)}
            height={height - topPad - bottomPad}
            fill="transparent"
            onMouseEnter={() => setHoveredIndex(index)}
            onMouseLeave={() => setHoveredIndex(null)}
          />
        ))}
        {hoveredItem ? (
          <>
            <line x1={hoveredX} x2={hoveredX} y1={topPad} y2={height - bottomPad} stroke="rgba(124,143,172,0.45)" strokeDasharray="4 5" />
            <InteractiveTooltip
              x={hoveredX + 12}
              y={hoveredY}
              title={hoveredItem.month}
              rows={[
                { label: '净现金', value: hoveredItem.netCash, color: '#5d87ff' },
                { label: '交易净额', value: hoveredItem.trading, color: '#13deb9' },
                { label: '入金', value: hoveredItem.deposits, color: '#9ec5fe' },
                { label: '出金', value: hoveredItem.withdrawals, color: '#ff9aa5' },
              ]}
            />
          </>
        ) : null}
      </Box>
    </Box>
  );
}

function CashFlowAreaWidget({ data }) {
  const hasData = data.length && data.some((item) => Math.abs(item.netCash || 0) > 0.01 || Math.abs(item.trading || 0) > 0.01);

  if (!hasData) return <EmptyChart />;

  return (
    <MeasuredChart minHeight={260}>
      {({ width, height }) => (
        <AreaChart width={width} height={height} data={data} margin={{ top: 8, right: 18, left: 0, bottom: 0 }}>
          <CartesianGrid stroke="#e5eaef" vertical={false} />
          <XAxis dataKey="month" tick={{ fill: '#7c8fac', fontSize: 12 }} axisLine={false} tickLine={false} />
          <YAxis tickFormatter={compactCurrency} tick={{ fill: '#7c8fac', fontSize: 12 }} axisLine={false} tickLine={false} width={76} />
          <Tooltip content={<ChartTooltip />} />
          <Area name="净现金" type="monotone" dataKey="netCash" stroke="#5d87ff" fill="#5d87ff33" strokeWidth={2} />
          <Area name="交易净额" type="monotone" dataKey="trading" stroke="#13deb9" fill="#13deb955" strokeWidth={2} />
        </AreaChart>
      )}
    </MeasuredChart>
  );
}

function MonthlyTradingBars({ data }) {
  const [hoveredIndex, setHoveredIndex] = useState(null);
  const width = 960;
  const height = 250;
  const leftPad = 76;
  const rightPad = 20;
  const topPad = 14;
  const bottomPad = 38;
  const maxValue = Math.max(1, ...data.flatMap((item) => [item.buys, item.sells]));
  const innerWidth = width - leftPad - rightPad;
  const groupWidth = data.length ? innerWidth / data.length : innerWidth;
  const barWidth = Math.max(8, groupWidth * 0.28);
  const yFor = (value) => yScale(value, 0, maxValue, height, topPad, bottomPad);
  const baseY = yFor(0);
  const hoveredItem = hoveredIndex === null ? null : data[hoveredIndex];
  const hoveredX = hoveredIndex === null ? 0 : leftPad + hoveredIndex * groupWidth + groupWidth / 2;
  const hoveredY = hoveredItem ? Math.min(yFor(hoveredItem.buys), yFor(hoveredItem.sells)) : 0;

  if (!data.length || maxValue <= 1) return <EmptyChart />;

  return (
    <Box sx={{ width: '100%', height: '100%' }}>
      <Stack direction="row" spacing={2} sx={{ justifyContent: 'flex-end', mb: 1 }}>
        <LegendDot color="#fa896b" label="买入" />
        <LegendDot color="#13deb9" label="卖出" />
      </Stack>
      <Box component="svg" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="xMidYMid meet" sx={{ width: '100%', height: 'calc(100% - 24px)', display: 'block' }}>
        {[0.25, 0.5, 0.75].map((ratio) => {
          const y = topPad + (height - topPad - bottomPad) * ratio;
          return <line key={ratio} x1={leftPad} x2={width - rightPad} y1={y} y2={y} stroke="#e5eaef" />;
        })}
        <text x={8} y={yFor(maxValue)} fill="#7c8fac" fontSize="12">{compactCurrency(maxValue)}</text>
        <text x={8} y={baseY} fill="#7c8fac" fontSize="12">€0</text>
        {data.map((item, index) => {
          const groupX = leftPad + index * groupWidth + groupWidth / 2;
          const buyHeight = baseY - yFor(item.buys);
          const sellHeight = baseY - yFor(item.sells);
          return (
            <g key={item.month}>
              <rect x={groupX - barWidth - 2} y={baseY - buyHeight} width={barWidth} height={buyHeight} rx="4" fill="#fa896b" opacity={hoveredIndex === null || hoveredIndex === index ? 1 : 0.45} />
              <rect x={groupX + 2} y={baseY - sellHeight} width={barWidth} height={sellHeight} rx="4" fill="#13deb9" opacity={hoveredIndex === null || hoveredIndex === index ? 1 : 0.45} />
              {index % 3 === 0 || index === data.length - 1 ? (
                <text x={groupX} y={height - 10} fill="#7c8fac" fontSize="12" textAnchor="middle">{shortMonth(item.month)}</text>
              ) : null}
            </g>
          );
        })}
        {data.map((item, index) => {
          const groupX = leftPad + index * groupWidth + groupWidth / 2;
          return (
            <rect
              key={`hit-${item.month}`}
              x={groupX - groupWidth / 2}
              y={topPad}
              width={groupWidth}
              height={height - topPad - bottomPad}
              fill="transparent"
              onMouseEnter={() => setHoveredIndex(index)}
              onMouseLeave={() => setHoveredIndex(null)}
            />
          );
        })}
        {hoveredItem ? (
          <>
            <line x1={hoveredX} x2={hoveredX} y1={topPad} y2={height - bottomPad} stroke="rgba(124,143,172,0.38)" strokeDasharray="4 5" />
            <InteractiveTooltip
              x={hoveredX + 12}
              y={hoveredY}
              title={hoveredItem.month}
              rows={[
                { label: '买入', value: hoveredItem.buys, color: '#fa896b' },
                { label: '卖出', value: hoveredItem.sells, color: '#13deb9' },
                { label: '买卖净额', value: (hoveredItem.sells || 0) - (hoveredItem.buys || 0), color: '#5d87ff' },
                { label: '手续费', value: hoveredItem.fees, color: '#ffae1f' },
                { label: '税费', value: hoveredItem.taxes, color: '#635bff' },
              ]}
            />
          </>
        ) : null}
      </Box>
    </Box>
  );
}

function ChartDetailDialog({ open, onClose, title, type, data }) {
  const subtitle = type === 'cash'
    ? '鼠标悬停在面积图上即可查看净现金和交易净额。'
    : '鼠标悬停在月份柱状区域即可查看买入、卖出、买卖净额、手续费和税费。';

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="lg">
      <DialogTitle>
        <Stack direction="row" spacing={2} sx={{ alignItems: 'center', justifyContent: 'space-between' }}>
          <Box>
            <Typography variant="h6">{title}</Typography>
            <Typography variant="body2" color="text.secondary">{subtitle}</Typography>
          </Box>
          <IconButton onClick={onClose} aria-label="关闭弹窗">
            <CloseRoundedIcon />
          </IconButton>
        </Stack>
      </DialogTitle>
      <DialogContent dividers>
        <Box sx={{ height: { xs: 420, md: 620 }, minWidth: 0 }}>
          {type === 'cash' ? <CashFlowAreaWidget data={data} /> : <MonthlyTradingBars data={data} />}
        </Box>
      </DialogContent>
    </Dialog>
  );
}

export default function PortfolioCharts({ allocation, monthly }) {
  const [expandedChart, setExpandedChart] = useState(null);
  const recentMonthly = monthly.slice(-18).map((item) => ({
    ...item,
    netCash: (item.deposits || 0) + (item.withdrawals || 0),
    trading: (item.sells || 0) - (item.buys || 0) + (item.income || 0),
    buys: item.buys || 0,
    sells: item.sells || 0,
  }));

  const detailTitle = expandedChart === 'cash' ? '最近 18 个月现金流与交易' : '每月买入 / 卖出';

  return (
    <>
      <Grid container spacing={2}>
        <Grid size={{ xs: 12, lg: 4 }}>
          <Card className="panel-card">
            <CardContent>
              <Typography variant="h6" mb={2}>资产分布</Typography>
              <Box sx={{ height: 280, minWidth: 0, width: '100%' }}>
                {allocation.length ? (
                  <PieChart width={360} height={280} style={{ width: '100%', height: '100%' }}>
                    <Pie data={allocation} dataKey="value" nameKey="name" innerRadius={62} outerRadius={100} paddingAngle={3}>
                      {allocation.map((entry, index) => <Cell key={entry.name} fill={COLORS[index % COLORS.length]} />)}
                    </Pie>
                    <Tooltip content={<ChartTooltip />} />
                  </PieChart>
                ) : (
                  <EmptyChart />
                )}
              </Box>
              <Stack spacing={1}>
                {allocation.map((item, index) => (
                  <Stack key={item.name} direction="row" sx={{ justifyContent: 'space-between', alignItems: 'center' }}>
                    <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                      <Box sx={{ width: 10, height: 10, borderRadius: '50%', bgcolor: COLORS[index % COLORS.length] }} />
                      <Typography variant="body2">{item.name}</Typography>
                    </Stack>
                    <Typography variant="body2" color="text.secondary">{compactCurrency(item.value)}</Typography>
                  </Stack>
                ))}
              </Stack>
            </CardContent>
          </Card>
        </Grid>

        <Grid size={{ xs: 12, lg: 8 }}>
          <Card className="panel-card">
            <CardContent>
              <ChartTitle title="最近 18 个月现金流与交易" onExpand={() => setExpandedChart('cash')} />
              <Box sx={{ height: 350, minWidth: 0, width: '100%' }}>
                <CashFlowAreaWidget data={recentMonthly} />
              </Box>
            </CardContent>
          </Card>
        </Grid>

        <Grid size={{ xs: 12 }}>
          <Card className="panel-card">
            <CardContent>
              <ChartTitle title="每月买入 / 卖出" onExpand={() => setExpandedChart('trading')} />
              <Box sx={{ height: 280, minWidth: 0 }}>
                <MonthlyTradingBars data={recentMonthly} />
              </Box>
            </CardContent>
          </Card>
        </Grid>
      </Grid>

      <ChartDetailDialog
        open={Boolean(expandedChart)}
        onClose={() => setExpandedChart(null)}
        title={detailTitle}
        type={expandedChart}
        data={recentMonthly}
      />
    </>
  );
}
