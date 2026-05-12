use std::path::Path;

use anyhow::{Context, bail};
use serde::Deserialize;
use tracing::info;

use crate::{
    db::transaction_repository::SqliteTransactionRepository,
    domain::{
        money::Money,
        transaction::{AssetClass, Symbol, Transaction},
    },
};

#[derive(Debug, Clone)]
pub struct TransactionImporter {
    repository: SqliteTransactionRepository,
}

impl TransactionImporter {
    pub fn new(repository: SqliteTransactionRepository) -> Self {
        Self { repository }
    }

    pub async fn import_csv(&self, path: &Path) -> anyhow::Result<usize> {
        if !path.exists() {
            bail!("CSV file does not exist: {}", path.display());
        }

        let mut reader = csv::ReaderBuilder::new()
            .flexible(true)
            .from_path(path)
            .with_context(|| format!("failed to open CSV {}", path.display()))?;

        let mut transactions = Vec::new();
        for (index, row) in reader.deserialize::<RawTransaction>().enumerate() {
            let raw = row.with_context(|| format!("failed to parse CSV row {}", index + 2))?;
            transactions.push(raw.into_transaction(index));
        }

        self.repository
            .replace_all(&transactions)
            .await
            .context("failed to persist imported transactions")?;

        info!(rows = transactions.len(), path = %path.display(), "imported transaction CSV");
        Ok(transactions.len())
    }
}

#[derive(Debug, Deserialize)]
struct RawTransaction {
    #[serde(default)]
    transaction_id: String,
    #[serde(default)]
    date: String,
    #[serde(rename = "type", default)]
    transaction_type: String,
    #[serde(default)]
    category: String,
    #[serde(default)]
    asset_class: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    symbol: String,
    #[serde(default)]
    description: String,
    #[serde(default, deserialize_with = "number")]
    amount: f64,
    #[serde(default, deserialize_with = "number")]
    fee: f64,
    #[serde(default, deserialize_with = "number")]
    tax: f64,
    #[serde(default, deserialize_with = "number")]
    shares: f64,
    #[serde(default, deserialize_with = "number")]
    price: f64,
    #[serde(default)]
    currency: String,
}

impl RawTransaction {
    fn into_transaction(self, index: usize) -> Transaction {
        let fallback_id = format!(
            "{}-{}-{}-{}",
            self.date,
            self.transaction_type,
            self.symbol,
            index + 1
        );

        Transaction {
            transaction_id: non_empty(self.transaction_id, fallback_id),
            date: self.date,
            transaction_type: self.transaction_type,
            category: self.category,
            asset_class: AssetClass::normalized(self.asset_class),
            name: self.name,
            symbol: Symbol(self.symbol),
            description: self.description,
            amount: Money(self.amount),
            fee: Money(self.fee),
            tax: Money(self.tax),
            shares: self.shares,
            price: Money(self.price),
            currency: non_empty(self.currency, "EUR".to_owned()),
        }
    }
}

fn non_empty(value: String, fallback: String) -> String {
    if value.is_empty() { fallback } else { value }
}

fn number<'de, D>(deserializer: D) -> Result<f64, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = String::deserialize(deserializer)?;
    if value.trim().is_empty() {
        return Ok(0.0);
    }

    Ok(value.replace(',', ".").parse().unwrap_or(0.0))
}
