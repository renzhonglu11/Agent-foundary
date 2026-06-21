import { Grid } from '@mui/material';
import { useMemo } from 'react';
import SummaryCards from './SummaryCards.jsx';
import PortfolioCharts from './PortfolioCharts.jsx';
import PositionsActionBoard from './PositionsActionBoard.jsx';
import PositionsTable from './PositionsTable.jsx';
import RecentActivity from './RecentActivity.jsx';
import { useRiskData } from '../hooks/useRiskData.js';
import { useStructuredProducts } from '../hooks/useStructuredProducts.js';
import { useAlpacaQuotes } from '../hooks/useAlpacaQuotes.js';
import { buildWatchlistGroups, collectTier1MonitoringAlpacaSymbols } from '../utils/watchlistGrouping.js';

export function OverviewTab({ data }) {
  return (
    <>
      <SummaryCards summary={data.summary} />
      <PortfolioCharts allocation={data.allocation} monthly={data.monthly} />
      <Grid container spacing={2}>
        <Grid size={{ xs: 12, lg: 8 }}>
          <PositionsTable positions={data.positions} totalMarketValue={data.summary.totalMarketValue} compact />
        </Grid>
        <Grid size={{ xs: 12, lg: 4 }}>
          <RecentActivity transactions={data.recentTransactions} />
        </Grid>
      </Grid>
    </>
  );
}

export function PositionsTab({ data, onAddPnlRecord }) {
  const { loading: riskLoading, error: riskError, data: riskData } = useRiskData();
  const { loading: structuredProductsLoading, data: structuredProducts } = useStructuredProducts();

  const stockRowsWithoutAlpaca = useMemo(
    () => (structuredProducts ? buildWatchlistGroups(data, structuredProducts) : {}),
    [data, structuredProducts],
  );
  const tier1AlpacaSymbols = useMemo(
    () => (stockRowsWithoutAlpaca ? collectTier1MonitoringAlpacaSymbols(stockRowsWithoutAlpaca) : []),
    [stockRowsWithoutAlpaca],
  );
  const { data: alpacaQuotes } = useAlpacaQuotes(tier1AlpacaSymbols, { cacheOnly: true });

  return (
    <PositionsActionBoard
      data={data}
      riskData={riskData}
      riskLoading={riskLoading}
      riskError={riskError}
      structuredProducts={structuredProducts}
      structuredProductsLoading={structuredProductsLoading}
      alpacaQuotes={alpacaQuotes}
      onAddPnlRecord={onAddPnlRecord}
    />
  );
}
