import { useState } from 'react';
import { Alert, Box, CircularProgress, Stack, Typography } from '@mui/material';
import DashboardShell from './components/DashboardShell.jsx';
import { OverviewTab, PositionsTab } from './components/PortfolioTabs.jsx';
import DividendTab from './components/DividendTab.jsx';
import HermesCronTab from './components/HermesCronTab.jsx';
import StockAnalysisTab from './components/StockAnalysisTab.jsx';
import { usePortfolioData } from './hooks/usePortfolioData.js';

export default function App() {
  const { loading, error, data } = usePortfolioData();
  const [activeTab, setActiveTab] = useState('overview');

  if (loading) {
    return (
      <Box sx={{ minHeight: '100vh', display: 'grid', placeItems: 'center' }}>
        <Stack spacing={2} sx={{ alignItems: 'center' }}>
          <CircularProgress />
          <Typography color="text.secondary">正在读取 portfolio 数据...</Typography>
        </Stack>
      </Box>
    );
  }

  if (error) {
    return (
      <Box sx={{ minHeight: '100vh', display: 'grid', placeItems: 'center', px: 2 }}>
        <Alert severity="error">数据加载失败：{error.message}。请先运行 npm run generate:data。</Alert>
      </Box>
    );
  }

  const tabs = {
    overview: <OverviewTab data={data} />,
    positions: <PositionsTab data={data} />,
    dividend: <DividendTab dividend={data.dividend} />,
    stockAnalysis: <StockAnalysisTab data={data} />,
    hermesCron: <HermesCronTab />,
  };

  return (
    <DashboardShell source={data.source} generatedAt={data.generatedAt} activeTab={activeTab} onTabChange={setActiveTab}>
      {tabs[activeTab] ?? tabs.overview}
    </DashboardShell>
  );
}
