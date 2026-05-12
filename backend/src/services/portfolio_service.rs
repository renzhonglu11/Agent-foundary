use std::path::PathBuf;

use anyhow::Context;

use crate::{
    db::transaction_repository::SqliteTransactionRepository,
    domain::portfolio::PortfolioSummaryResponse,
    services::portfolio_calculator::{CalculatorInput, build_isin_name_map, calculate_portfolio},
};

#[derive(Debug, Clone)]
pub struct PortfolioService {
    repository: SqliteTransactionRepository,
    csv_path: PathBuf,
    pdf_path: PathBuf,
    pdf_text_path: Option<PathBuf>,
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
            pdf_path,
            pdf_text_path,
        }
    }

    pub async fn summary(&self) -> anyhow::Result<PortfolioSummaryResponse> {
        let transactions = self
            .repository
            .list_all()
            .await
            .context("failed to load transactions")?;
        let isin_names = build_isin_name_map(self.pdf_text_path.as_deref())
            .context("failed to parse extracted PDF text")?;

        Ok(calculate_portfolio(
            &transactions,
            CalculatorInput {
                csv_source: self.csv_path.display().to_string(),
                pdf_source: self.pdf_path.display().to_string(),
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
