use std::{
    path::{Path, PathBuf},
    sync::{Arc, RwLock},
    time::SystemTime,
};

use anyhow::{Context, anyhow};
use tracing::warn;

use crate::{
    application::{
        ports::transaction_repository::TransactionRepository,
        services::{
            portfolio_calculator::{
                CalculatorInput, PriceOverride, build_isin_name_map, calculate_portfolio,
            },
            transaction_importer::TransactionImporter,
        },
    },
    domain::portfolio::PortfolioSummaryResponse,
};
use serde::Deserialize;

#[derive(Clone)]
pub struct PortfolioService {
    repository: Arc<dyn TransactionRepository>,
    csv_path: PathBuf,
    pdf_path: Arc<RwLock<PathBuf>>,
    pdf_text_path: Option<PathBuf>,
    structured_products_json_path: Option<PathBuf>,
    summary_cache: Arc<RwLock<Option<CachedPortfolioSummary>>>,
}

#[derive(Debug, Clone)]
struct CachedPortfolioSummary {
    summary: PortfolioSummaryResponse,
    quote_source_modified_at: Option<SystemTime>,
}

impl PortfolioService {
    pub fn new(
        repository: Arc<dyn TransactionRepository>,
        csv_path: PathBuf,
        pdf_path: PathBuf,
        pdf_text_path: Option<PathBuf>,
        structured_products_json_path: Option<PathBuf>,
    ) -> Self {
        Self {
            repository,
            csv_path,
            pdf_path: Arc::new(RwLock::new(pdf_path)),
            pdf_text_path,
            structured_products_json_path,
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
        *cache = Some(CachedPortfolioSummary {
            summary: summary.clone(),
            quote_source_modified_at: self.quote_source_modified_at(),
        });

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

    pub async fn apply_data_update(
        &self,
        csv_path: Option<&Path>,
        pdf_path: Option<PathBuf>,
    ) -> anyhow::Result<(Option<usize>, PortfolioSummaryResponse)> {
        let imported_rows = if let Some(path) = csv_path {
            Some(
                TransactionImporter::new(self.repository.clone())
                    .import_csv(path)
                    .await?,
            )
        } else {
            None
        };

        if let Some(pdf_path) = pdf_path {
            let mut current_pdf_path = self
                .pdf_path
                .write()
                .map_err(|_| anyhow!("portfolio PDF path lock poisoned"))?;
            *current_pdf_path = pdf_path;
        }

        self.clear_summary_cache()?;
        let summary = self.refresh_summary_cache().await?;

        Ok((imported_rows, summary))
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

        let Some(cached) = cache.as_ref() else {
            return Ok(None);
        };
        if cached.quote_source_modified_at == self.quote_source_modified_at() {
            Ok(Some(cached.summary.clone()))
        } else {
            Ok(None)
        }
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
        let price_overrides =
            build_structured_product_price_overrides(self.structured_products_json_path.as_deref())
                .context("failed to parse structured products quote overrides")?;
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
                price_overrides,
            },
        ))
    }

    fn quote_source_modified_at(&self) -> Option<SystemTime> {
        self.structured_products_json_path
            .as_deref()
            .and_then(|path| std::fs::metadata(path).ok())
            .and_then(|metadata| metadata.modified().ok())
    }
}

#[derive(Debug, Deserialize)]
struct StructuredProductsPayload {
    #[serde(default)]
    items: Vec<StructuredProductQuoteRow>,
}

#[derive(Debug, Deserialize)]
struct StructuredProductQuoteRow {
    isin: Option<String>,
    quote_price: Option<f64>,
    quote_source: Option<String>,
}

fn build_structured_product_price_overrides(
    path: Option<&Path>,
) -> anyhow::Result<std::collections::HashMap<String, PriceOverride>> {
    let Some(path) = path else {
        return Ok(std::collections::HashMap::new());
    };
    if !path.exists() {
        return Ok(std::collections::HashMap::new());
    }

    let content = std::fs::read_to_string(path)?;
    let payload: StructuredProductsPayload = serde_json::from_str(&content)?;
    let overrides = payload
        .items
        .into_iter()
        .filter_map(|item| {
            let isin = item.isin?;
            let price = item.quote_price?;
            let source = item.quote_source?;
            if source == "boerse_frankfurt" && price > 0.0 {
                Some((isin, PriceOverride { price, source }))
            } else {
                None
            }
        })
        .collect();

    Ok(overrides)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_only_live_boerse_quotes_as_price_overrides() -> anyhow::Result<()> {
        let temp = tempfile::NamedTempFile::new()?;
        std::fs::write(
            temp.path(),
            r#"{
              "items": [
                {"isin": "DE000LIVE001", "quote_price": 2.5, "quote_source": "boerse_frankfurt"},
                {"isin": "DE000FALL001", "quote_price": 3.5, "quote_source": "rust_portfolio_summary"}
              ]
            }"#,
        )?;

        let overrides = build_structured_product_price_overrides(Some(temp.path()))?;

        assert_eq!(overrides.len(), 1);
        assert_eq!(overrides["DE000LIVE001"].price, 2.5);
        assert!(!overrides.contains_key("DE000FALL001"));
        Ok(())
    }
}
