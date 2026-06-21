import { useState } from 'react';
import { Alert, Box, CircularProgress, Stack, Typography } from '@mui/material';
import DashboardShell from './components/DashboardShell.jsx';
import { OverviewTab, PositionsTab } from './components/PortfolioTabs.jsx';
import DividendTab from './components/DividendTab.jsx';
import HermesCronTab from './components/HermesCronTab.jsx';
import StockAnalysisTab from './components/StockAnalysisTab.jsx';
import EventsTab from './components/EventsTab.jsx';
import { usePortfolioData } from './hooks/usePortfolioData.js';
import { useStructuredProductsDataSync } from './hooks/useStructuredProductsRefreshStatus.js';

export default function App() {
  const { loading, error, data } = usePortfolioData();
  useStructuredProductsDataSync();
  const [activeTab, setActiveTab] = useState('overview');
  const [pnlRecords, setPnlRecords] = useState([]);

  const handleAddPnlRecord = (record) => {
    setPnlRecords((current) => [
      { ...record, recordedAt: Date.now() },
      ...current.filter((item) => item.id !== record.id),
    ]);
  };

  const handleRemovePnlRecord = (recordId) => {
    setPnlRecords((current) => current.filter((record) => record.id !== recordId));
  };

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
    positions: <PositionsTab data={data} onAddPnlRecord={handleAddPnlRecord} />,
    dividend: <DividendTab dividend={data.dividend} />,
    stockAnalysis: <StockAnalysisTab data={data} />,
    events: <EventsTab />,
    hermesCron: <HermesCronTab />,
  };

  return (
    <DashboardShell
      source={data.source}
      generatedAt={data.generatedAt}
      activeTab={activeTab}
      onTabChange={setActiveTab}
      pnlRecords={pnlRecords}
      onRemovePnlRecord={handleRemovePnlRecord}
    >
      {tabs[activeTab] ?? tabs.overview}
    </DashboardShell>
  );
}
