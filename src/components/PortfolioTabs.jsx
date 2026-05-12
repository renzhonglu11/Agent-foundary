import { Grid } from '@mui/material';
import SummaryCards from './SummaryCards.jsx';
import PortfolioCharts from './PortfolioCharts.jsx';
import PositionsTable from './PositionsTable.jsx';
import RecentActivity from './RecentActivity.jsx';

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
  return <PositionsTable positions={data.positions} totalMarketValue={data.summary.totalMarketValue} />;
}
