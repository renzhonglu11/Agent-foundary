use chrono::{DateTime, Utc};
use sqlx::{Row, SqlitePool};

use crate::application::ports::fred_macro_data_cache::{
    FredMacroDataCache, FredMacroDataCacheEntry,
};

#[derive(Debug, Clone)]
pub struct SqliteFredMacroDataCache {
    pool: SqlitePool,
}

impl SqliteFredMacroDataCache {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }
}

#[async_trait::async_trait]
impl FredMacroDataCache for SqliteFredMacroDataCache {
    async fn get_latest(&self) -> anyhow::Result<Option<FredMacroDataCacheEntry>> {
        let Some(row) = sqlx::query(
            r#"
            SELECT payload_json, fetched_at
            FROM fred_macro_data_cache
            WHERE cache_key = 'macro_data'
            "#,
        )
        .fetch_optional(&self.pool)
        .await?
        else {
            return Ok(None);
        };

        let response = serde_json::from_str(&row.try_get::<String, _>("payload_json")?)?;
        let fetched_at = DateTime::parse_from_rfc3339(&row.try_get::<String, _>("fetched_at")?)?
            .with_timezone(&Utc);

        Ok(Some(FredMacroDataCacheEntry {
            response,
            fetched_at,
        }))
    }

    async fn store(&self, entry: &FredMacroDataCacheEntry) -> anyhow::Result<()> {
        let payload_json = serde_json::to_string(&entry.response)?;

        sqlx::query(
            r#"
            INSERT INTO fred_macro_data_cache (cache_key, status, payload_json, fetched_at)
            VALUES ('macro_data', ?1, ?2, ?3)
            ON CONFLICT(cache_key) DO UPDATE SET
                status = excluded.status,
                payload_json = excluded.payload_json,
                fetched_at = excluded.fetched_at
            "#,
        )
        .bind(&entry.response.status)
        .bind(payload_json)
        .bind(entry.fetched_at.to_rfc3339())
        .execute(&self.pool)
        .await?;

        Ok(())
    }
}
