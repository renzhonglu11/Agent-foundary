use chrono::{DateTime, Utc};

use crate::services::fred::FredMacroDataResponse;

#[derive(Debug, Clone)]
pub struct FredMacroDataCacheEntry {
    pub response: FredMacroDataResponse,
    pub fetched_at: DateTime<Utc>,
}

#[async_trait::async_trait]
pub trait FredMacroDataCache: Send + Sync {
    async fn get_latest(&self) -> anyhow::Result<Option<FredMacroDataCacheEntry>>;

    async fn store(&self, entry: &FredMacroDataCacheEntry) -> anyhow::Result<()>;
}
