use std::{
    path::{Path, PathBuf},
    sync::{Arc, RwLock},
};

use anyhow::{Context, anyhow};
use tracing::warn;

use crate::{
    db::transaction_repository::SqliteTransactionRepository,
    domain::portfolio::PortfolioSummaryResponse,
    services::{
        portfolio_calculator::{CalculatorInput, build_isin_name_map, calculate_portfolio},
        transaction_importer::TransactionImporter,
    },
};

#[derive(Debug, Clone)]
pub struct PortfolioService {
    repository: SqliteTransactionRepository,
    csv_path: PathBuf,
    pdf_path: Arc<RwLock<PathBuf>>,
    pdf_text_path: Option<PathBuf>,
    summary_cache: Arc<RwLock<Option<PortfolioSummaryResponse>>>,
}

impl PortfolioService {
    pub fn new(
        repository: SqliteTransactionRepository,
        csv_path: PathBuf,
        pdf_path: PathBuf,
        pdf_text_path: Option<PathBuf>,
    ) -> Self {
        Self {
            repository,
            csv_path,
            pdf_path: Arc::new(RwLock::new(pdf_path)),
            pdf_text_path,
            summary_cache: Arc::new(RwLock::new(None)),
        }
    }

    pub async fn summary(&self) -> anyhow::Result<PortfolioSummaryResponse> {
        if let Some(summary) = self.cached_summary()? {
            return Ok(summary);
        }

        self.refresh_summary_cache().await
    }

    pub async fn refresh_summary_cache(&self) -> anyhow::Result<PortfolioSummaryResponse> {
        let summary = self.calculate_summary().await?;
        let mut cache = self
            .summary_cache
            .write()
            .map_err(|_| anyhow!("portfolio summary cache lock poisoned"))?;
        *cache = Some(summary.clone());

        Ok(summary)
    }

    pub async fn import_csv(&self, path: &Path) -> anyhow::Result<usize> {
        let rows = TransactionImporter::new(self.repository.clone())
            .import_csv(path)
            .await?;

        self.clear_summary_cache()?;
        if let Err(error) = self.refresh_summary_cache().await {
            warn!(%error, "failed to refresh portfolio summary cache after CSV import");
        }

        Ok(rows)
    }

    pub fn pdf_text_path(&self) -> Option<PathBuf> {
        self.pdf_text_path.clone()
    }

    pub async fn refresh_after_pdf_update(&self, pdf_path: PathBuf) -> anyhow::Result<()> {
        {
            let mut current_pdf_path = self
                .pdf_path
                .write()
                .map_err(|_| anyhow!("portfolio PDF path lock poisoned"))?;
            *current_pdf_path = pdf_path;
        }

        self.clear_summary_cache()?;
        self.refresh_summary_cache().await?;

        Ok(())
    }

    fn cached_summary(&self) -> anyhow::Result<Option<PortfolioSummaryResponse>> {
        let cache = self
            .summary_cache
            .read()
            .map_err(|_| anyhow!("portfolio summary cache lock poisoned"))?;

        Ok(cache.clone())
    }

    fn clear_summary_cache(&self) -> anyhow::Result<()> {
        let mut cache = self
            .summary_cache
            .write()
            .map_err(|_| anyhow!("portfolio summary cache lock poisoned"))?;
        *cache = None;

        Ok(())
    }

    async fn calculate_summary(&self) -> anyhow::Result<PortfolioSummaryResponse> {
        let transactions = self
            .repository
            .list_all()
            .await
            .context("failed to load transactions")?;
        let isin_names = build_isin_name_map(self.pdf_text_path.as_deref())
            .context("failed to parse extracted PDF text")?;
        let pdf_path = self
            .pdf_path
            .read()
            .map_err(|_| anyhow!("portfolio PDF path lock poisoned"))?
            .clone();

        Ok(calculate_portfolio(
            &transactions,
            CalculatorInput {
                csv_source: self.csv_path.display().to_string(),
                pdf_source: pdf_path.display().to_string(),
                pdf_text_source: self
                    .pdf_text_path
                    .as_ref()
                    .filter(|path| path.exists())
                    .map(|path| path.display().to_string()),
                isin_names,
            },
        ))
    }
}
