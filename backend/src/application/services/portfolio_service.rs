use std::{
    path::{Path, PathBuf},
    sync::{Arc, RwLock},
    time::SystemTime,
};

use anyhow::{Context, anyhow};
use tracing::warn;

use crate::{
    application::{
        ports::{
            transaction_repository::TransactionRepository,
            upload_archive_repository::UploadArchiveRepository,
        },
        services::{
            portfolio_calculator::{
                CalculatorInput, PriceOverride, build_isin_name_map_from_text, calculate_portfolio,
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
    upload_archive_repository: Arc<dyn UploadArchiveRepository>,
    csv_source: Arc<RwLock<String>>,
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
        upload_archive_repository: Arc<dyn UploadArchiveRepository>,
        csv_source: String,
        structured_products_json_path: Option<PathBuf>,
    ) -> Self {
        Self {
            repository,
            upload_archive_repository,
            csv_source: Arc::new(RwLock::new(csv_source)),
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

        self.set_csv_source(path.display().to_string())?;
        self.clear_summary_cache()?;
        if let Err(error) = self.refresh_summary_cache().await {
            warn!(%error, "failed to refresh portfolio summary cache after CSV import");
        }

        Ok(rows)
    }

    pub async fn apply_data_update(
        &self,
        csv_path: Option<&Path>,
    ) -> anyhow::Result<(Option<usize>, PortfolioSummaryResponse)> {
        let imported_rows = if let Some(path) = csv_path {
            let rows = TransactionImporter::new(self.repository.clone())
                .import_csv(path)
                .await?;
            self.set_csv_source(path.display().to_string())?;
            Some(rows)
        } else {
            None
        };

        self.clear_summary_cache()?;
        let summary = self.refresh_summary_cache().await?;

        Ok((imported_rows, summary))
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

    fn set_csv_source(&self, source: String) -> anyhow::Result<()> {
        let mut csv_source = self
            .csv_source
            .write()
            .map_err(|_| anyhow!("portfolio CSV source lock poisoned"))?;
        *csv_source = source;

        Ok(())
    }

    async fn calculate_summary(&self) -> anyhow::Result<PortfolioSummaryResponse> {
        let transactions = self
            .repository
            .list_all()
            .await
            .context("failed to load transactions")?;
        let latest_pdf = self
            .upload_archive_repository
            .latest_pdf_text()
            .await
            .context("failed to load latest uploaded PDF text")?;
        let isin_names = build_isin_name_map_from_text(
            latest_pdf.as_ref().map(|pdf| pdf.extracted_text.as_str()),
        );
        let price_overrides =
            build_structured_product_price_overrides(self.structured_products_json_path.as_deref())
                .context("failed to parse structured products quote overrides")?;
        let csv_source = self
            .csv_source
            .read()
            .map_err(|_| anyhow!("portfolio CSV source lock poisoned"))?
            .clone();

        Ok(calculate_portfolio(
            &transactions,
            CalculatorInput {
                csv_source,
                pdf_source: latest_pdf
                    .as_ref()
                    .map(|pdf| pdf.stored_path.clone())
                    .unwrap_or_else(|| "sqlite://uploaded_files?kind=pdf".to_owned()),
                pdf_text_source: latest_pdf
                    .as_ref()
                    .map(|_| "sqlite://uploaded_files.extracted_text".to_owned()),
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
