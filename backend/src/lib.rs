pub mod api;
pub mod config;
pub mod db;
pub mod domain;
pub mod services;
pub mod telemetry;

use std::net::SocketAddr;

use anyhow::Context;
use tokio::net::TcpListener;
use tracing::{info, warn};

use crate::{
    api::router,
    config::Settings,
    db::{
        connection::connect, migrations::run_migrations,
        transaction_repository::SqliteTransactionRepository,
    },
    services::{portfolio_service::PortfolioService, transaction_importer::TransactionImporter},
};

pub struct App {
    settings: Settings,
    router: axum::Router,
}

impl App {
    pub async fn build(settings: Settings) -> anyhow::Result<Self> {
        let pool = connect(&settings.database_url).await?;
        run_migrations(&pool).await?;

        let repository = SqliteTransactionRepository::new(pool);
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
        );
        portfolio_service
            .refresh_summary_cache()
            .await
            .context("failed to warm portfolio summary cache")?;
        let router = router::build(portfolio_service);

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
