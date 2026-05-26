use chrono::{DateTime, Utc};

#[derive(Debug, Clone)]
pub struct FxRateCacheEntry {
    pub base_currency: String,
    pub quote_currency: String,
    pub rate: f64,
    pub source: String,
    pub fetched_at: DateTime<Utc>,
}

#[async_trait::async_trait]
pub trait FxRateCache: Send + Sync {
    async fn get_rate(
        &self,
        base_currency: &str,
        quote_currency: &str,
    ) -> anyhow::Result<Option<FxRateCacheEntry>>;

    async fn store_rate(&self, rate: &FxRateCacheEntry) -> anyhow::Result<()>;
}
