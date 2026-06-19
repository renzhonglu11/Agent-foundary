import { Grid } from '@mui/material';
import { useEffect, useMemo, useState } from 'react';
import SummaryCards from './SummaryCards.jsx';
import PortfolioCharts from './PortfolioCharts.jsx';
import PositionsActionBoard from './PositionsActionBoard.jsx';
import PositionsTable from './PositionsTable.jsx';
import RecentActivity from './RecentActivity.jsx';
import { useRiskData } from '../hooks/useRiskData.js';
import { useStructuredProducts } from '../hooks/useStructuredProducts.js';
import { buildWatchlistGroups, collectTier1AlpacaSymbols } from '../utils/watchlistGrouping.js';

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

export function PositionsTab({ data }) {
  const { loading: riskLoading, error: riskError, data: riskData } = useRiskData();
  const { loading: structuredProductsLoading, data: structuredProducts } = useStructuredProducts();
  const [alpacaQuotes, setAlpacaQuotes] = useState([]);

  const stockRowsWithoutAlpaca = useMemo(
    () => (structuredProducts ? buildWatchlistGroups(data, structuredProducts) : {}),
    [data, structuredProducts],
  );
  const tier1AlpacaSymbols = useMemo(
    () => (stockRowsWithoutAlpaca ? collectTier1AlpacaSymbols(stockRowsWithoutAlpaca) : []),
    [stockRowsWithoutAlpaca],
  );
  const tier1AlpacaSymbolKey = tier1AlpacaSymbols.join(',');

  useEffect(() => {
    let cancelled = false;
    let timer = null;

    if (!tier1AlpacaSymbolKey) {
      setAlpacaQuotes([]);
      return () => { cancelled = true; };
    }

    const load = async () => {
      try {
        const query = tier1AlpacaSymbols.map((s) => String(s).trim()).filter(Boolean).join(',');
        const response = await fetch(`/api/stock-analysis/alpaca-quotes?symbols=${encodeURIComponent(query)}`, { cache: 'no-store' });
        if (cancelled) return;
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = await response.json();
        setAlpacaQuotes(Array.isArray(payload?.quotes) ? payload.quotes : []);
        const cacheTtlSeconds = Math.max(Number(payload?.cacheTtlSeconds) || 60, 60) * 1000;
        timer = window.setTimeout(load, cacheTtlSeconds);
      } catch {
        if (cancelled) return;
        setAlpacaQuotes([]);
        timer = window.setTimeout(load, 60_000);
      }
    };

    load();

    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [tier1AlpacaSymbolKey]);

  return (
    <PositionsActionBoard
      data={data}
      riskData={riskData}
      riskLoading={riskLoading}
      riskError={riskError}
      structuredProducts={structuredProducts}
      structuredProductsLoading={structuredProductsLoading}
      alpacaQuotes={alpacaQuotes}
    />
  );
}
