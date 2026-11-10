use chrono::{DateTime, Utc};

#[derive(Debug, Clone)]
pub struct MarketQuoteRecord {
    pub provider: String,
    pub feed: String,
    pub symbol: String,
    pub price: f64,
    pub currency: String,
    pub bid_price: f64,
    pub ask_price: f64,
    pub raw_price: f64,
    pub raw_bid_price: f64,
    pub raw_ask_price: f64,
    pub raw_currency: String,
    pub usd_eur_rate: f64,
    pub fx_rate_source: String,
    pub bid_size: i64,
    pub ask_size: i64,
    pub price_source: String,
    pub price_as_of: String,
    pub fetched_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
pub struct RealtimePayloadRecord {
    pub payload_json: String,
    pub updated_at: String,
}

/// A product's implied volatility on one UTC day (`observed_on` is YYYY-MM-DD).
#[derive(Debug, Clone, PartialEq)]
pub struct IvObservation {
    pub isin: String,
    pub observed_on: String,
    pub iv: f64,
}

#[async_trait::async_trait]
pub trait MarketDataRepository: Send + Sync {
    /// Recorded implied volatilities on or after `since` (YYYY-MM-DD).
    async fn load_iv_history(&self, since: &str) -> anyhow::Result<Vec<IvObservation>>;

    async fn load_quotes(
        &self,
        provider: &str,
        feed: &str,
        symbols: &[String],
    ) -> anyhow::Result<Vec<MarketQuoteRecord>>;

    async fn store_quotes(&self, quotes: &[MarketQuoteRecord]) -> anyhow::Result<()>;

    async fn load_payload(&self, key: &str) -> anyhow::Result<Option<String>>;

    async fn load_payload_record(&self, key: &str)
    -> anyhow::Result<Option<RealtimePayloadRecord>>;

    async fn store_payload(
        &self,
        key: &str,
        payload_json: &str,
        updated_at: &str,
    ) -> anyhow::Result<()>;
}
