use crate::{
    application::services::{
        portfolio_service::PortfolioService, upload_data_service::UploadDataService,
    },
    services::{
        alpaca_market_data::AlpacaMarketDataService,
        structured_products_service::StructuredProductsService,
    },
};

#[derive(Clone)]
pub struct AppState {
    pub portfolio_service: PortfolioService,
    pub upload_data_service: UploadDataService,
    pub structured_products_service: StructuredProductsService,
    pub alpaca_market_data_service: AlpacaMarketDataService,
}

impl AppState {
    pub fn new(
        portfolio_service: PortfolioService,
        upload_data_service: UploadDataService,
        structured_products_service: StructuredProductsService,
        alpaca_market_data_service: AlpacaMarketDataService,
    ) -> Self {
        Self {
            portfolio_service,
            upload_data_service,
            structured_products_service,
            alpaca_market_data_service,
        }
    }
}
