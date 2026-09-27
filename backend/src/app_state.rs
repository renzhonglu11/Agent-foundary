use crate::{
    application::services::{
        portfolio_service::PortfolioService, upload_data_service::UploadDataService,
    },
    services::{
        alpaca_market_data::AlpacaMarketDataService, apewisdom::ApeWisdomService,
        fred::FredService, hermes_cron_status::HermesCronStatusService,
        pnl_snapshots::PnlSnapshotService, structured_products_service::StructuredProductsService,
        systemd_status::SystemdStatusService,
    },
};

#[derive(Clone)]
pub struct AppState {
    pub portfolio_monitor: crate::services::portfolio_monitor::PortfolioMonitor,
    pub portfolio_service: PortfolioService,
    pub upload_data_service: UploadDataService,
    pub structured_products_service: StructuredProductsService,
    pub alpaca_market_data_service: AlpacaMarketDataService,
    pub hermes_cron_status_service: HermesCronStatusService,
    pub fred_service: FredService,
    pub ape_wisdom_service: ApeWisdomService,
    pub systemd_status_service: SystemdStatusService,
    pub pnl_snapshot_service: PnlSnapshotService,
}

impl AppState {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        portfolio_service: PortfolioService,
        upload_data_service: UploadDataService,
        structured_products_service: StructuredProductsService,
        alpaca_market_data_service: AlpacaMarketDataService,
        hermes_cron_status_service: HermesCronStatusService,
        fred_service: FredService,
        ape_wisdom_service: ApeWisdomService,
        systemd_status_service: SystemdStatusService,
        pnl_snapshot_service: PnlSnapshotService,
        portfolio_monitor: crate::services::portfolio_monitor::PortfolioMonitor,
    ) -> Self {
        Self {
            portfolio_monitor,
            portfolio_service,
            upload_data_service,
            structured_products_service,
            alpaca_market_data_service,
            hermes_cron_status_service,
            fred_service,
            ape_wisdom_service,
            systemd_status_service,
            pnl_snapshot_service,
        }
    }
}
