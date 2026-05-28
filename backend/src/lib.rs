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
use tracing::{info, warn};

use crate::{
    api::router,
    app_state::AppState,
    application::{
        ports::{fx_rate_cache::FxRateCache, transaction_repository::TransactionRepository},
        services::{
            fx_rate_service::FxRateService, portfolio_service::PortfolioService,
            transaction_importer::TransactionImporter, upload_data_service::UploadDataService,
        },
    },
    config::Settings,
    infrastructure::db::{
        connection::connect, migrations::run_migrations, sqlite_fx_rate_cache::SqliteFxRateCache,
        sqlite_transaction_repository::SqliteTransactionRepository,
    },
    services::{
        alpaca_market_data::AlpacaMarketDataService, hermes_cron_status::HermesCronStatusService,
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
        if settings.csv_path.exists() {
            TransactionImporter::new(repository.clone())
                .import_csv(&settings.csv_path)
                .await
                .with_context(|| format!("failed to import {}", settings.csv_path.display()))?;
        } else {
            warn!(
                path = %settings.csv_path.display(),
                "CSV file not found; starting with empty portfolio data"
            );
            repository
                .replace_all(&[])
                .await
                .context("failed to clear transactions for missing CSV data")?;
        }

        let portfolio_service = PortfolioService::new(
            repository,
            settings.csv_path.clone(),
            settings.pdf_path.clone(),
            settings.pdf_text_path.clone(),
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
        let structured_products_service =
            StructuredProductsService::new(settings.structured_products.clone())
                .context("failed to configure structured products enrichment")?;
        structured_products_service.refresh_if_missing(summary);
        let fx_rate_cache: Arc<dyn FxRateCache> = Arc::new(SqliteFxRateCache::new(pool.clone()));
        let fx_rate_service = FxRateService::new(fx_rate_cache, settings.fx_rates.clone());
        let alpaca_market_data_service =
            AlpacaMarketDataService::new(settings.alpaca.clone(), fx_rate_service);
        let hermes_cron_status_service = HermesCronStatusService::new();
        let upload_data_service = UploadDataService::new(
            portfolio_service.clone(),
            structured_products_service.clone(),
        );

        let state = Arc::new(AppState::new(
            portfolio_service,
            upload_data_service,
            structured_products_service,
            alpaca_market_data_service,
            hermes_cron_status_service,
        ));
        let router = router::build(state);

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
