pub mod api;
pub mod app_state;
pub mod application;
pub mod config;
pub mod domain;
pub mod infrastructure;
pub mod services;
pub mod telemetry;

use std::{net::SocketAddr, sync::Arc};

use anyhow::Context;
use tokio::net::TcpListener;
use tracing::info;

use crate::{
    api::router,
    app_state::AppState,
    application::{
        ports::{fx_rate_cache::FxRateCache, transaction_repository::TransactionRepository},
        services::{
            fx_rate_service::FxRateService, portfolio_service::PortfolioService,
            upload_data_service::UploadDataService,
        },
    },
    config::Settings,
    infrastructure::db::{
        connection::connect, migrations::run_migrations,
        sqlite_fred_macro_data_cache::SqliteFredMacroDataCache,
        sqlite_fx_rate_cache::SqliteFxRateCache,
        sqlite_market_data_repository::SqliteMarketDataRepository,
        sqlite_transaction_repository::SqliteTransactionRepository,
        sqlite_upload_archive_repository::SqliteUploadArchiveRepository,
    },
    services::{
        alpaca_market_data::AlpacaMarketDataService, apewisdom::ApeWisdomService,
        fred::FredService, hermes_cron_status::HermesCronStatusService,
        structured_products_service::StructuredProductsService,
    },
};

pub struct App {
    settings: Settings,
    router: axum::Router,
}

impl App {
    pub async fn build(settings: Settings) -> anyhow::Result<Self> {
        let pool = connect(&settings.database_url).await?;
        run_migrations(&pool).await?;

        let repository: Arc<dyn TransactionRepository> =
            Arc::new(SqliteTransactionRepository::new(pool.clone()));

        let upload_archive_repository = Arc::new(SqliteUploadArchiveRepository::new(pool.clone()));
        let market_data_repository = Arc::new(SqliteMarketDataRepository::new(pool.clone()));
        let portfolio_service = PortfolioService::new(
            repository,
            market_data_repository.clone(),
            upload_archive_repository.clone(),
            settings.database_url.clone(),
            Some(settings.structured_products.output_json_path.clone()),
        );
        portfolio_service
            .refresh_summary_cache()
            .await
            .context("failed to warm portfolio summary cache")?;
        let summary = portfolio_service
            .summary()
            .await
            .context("failed to load warmed portfolio summary")?;
        let structured_products_service = StructuredProductsService::new(
            settings.structured_products.clone(),
            market_data_repository.clone(),
        )
        .context("failed to configure structured products enrichment")?;
        structured_products_service
            .refresh_if_missing(summary)
            .await;
        let fx_rate_cache: Arc<dyn FxRateCache> = Arc::new(SqliteFxRateCache::new(pool.clone()));
        let fx_rate_service = FxRateService::new(fx_rate_cache, settings.fx_rates.clone());
        let alpaca_market_data_service = AlpacaMarketDataService::new(
            settings.alpaca.clone(),
            fx_rate_service,
            market_data_repository,
        );
        let hermes_cron_status_service = HermesCronStatusService::new();
        let ape_wisdom_service = ApeWisdomService::new();
        if let Err(e) = ape_wisdom_service.load_cache_from_file().await {
            tracing::warn!(error = %e, "Failed to load pre-existing ApeWisdom cache from file on startup");
        }
        ape_wisdom_service.start_polling_in_background();

        let fred_macro_data_cache = Arc::new(SqliteFredMacroDataCache::new(pool.clone()));
        let fred_service = FredService::new(settings.fred.clone(), fred_macro_data_cache);
        fred_service.warm_cache_in_background();
        let upload_data_service = UploadDataService::new(
            portfolio_service.clone(),
            structured_products_service.clone(),
            upload_archive_repository,
        );

        let state = Arc::new(AppState::new(
            portfolio_service,
            upload_data_service,
            structured_products_service,
            alpaca_market_data_service,
            hermes_cron_status_service,
            fred_service,
            ape_wisdom_service,
        ));
        let router = router::build(state, &settings.frontend_origin)?;

        Ok(Self { settings, router })
    }

    pub async fn run(self) -> anyhow::Result<()> {
        let addr = SocketAddr::from((self.settings.host, self.settings.port));
        let listener = TcpListener::bind(addr)
            .await
            .with_context(|| format!("failed to bind {addr}"))?;

        info!(%addr, "starting HTTP server");
        axum::serve(listener, self.router)
            .with_graceful_shutdown(shutdown_signal())
            .await
            .context("HTTP server failed")
    }
}

async fn shutdown_signal() {
    let ctrl_c = async {
        if let Err(error) = tokio::signal::ctrl_c().await {
            tracing::error!(%error, "failed to listen for ctrl-c");
        }
    };

    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut signal) => {
                signal.recv().await;
            }
            Err(error) => tracing::error!(%error, "failed to listen for SIGTERM"),
        }
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
}
