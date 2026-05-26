use chrono::{DateTime, Utc};
use sqlx::{Row, SqlitePool};

use crate::application::ports::fx_rate_cache::{FxRateCache, FxRateCacheEntry};

#[derive(Debug, Clone)]
pub struct SqliteFxRateCache {
    pool: SqlitePool,
}

impl SqliteFxRateCache {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }
}

#[async_trait::async_trait]
impl FxRateCache for SqliteFxRateCache {
    async fn get_rate(
        &self,
        base_currency: &str,
        quote_currency: &str,
    ) -> anyhow::Result<Option<FxRateCacheEntry>> {
        let Some(row) = sqlx::query(
            r#"
            SELECT base_currency, quote_currency, rate, source, fetched_at
            FROM fx_rates
            WHERE base_currency = ?1 AND quote_currency = ?2
            "#,
        )
        .bind(base_currency)
        .bind(quote_currency)
        .fetch_optional(&self.pool)
        .await?
        else {
            return Ok(None);
        };

        let fetched_at = DateTime::parse_from_rfc3339(&row.try_get::<String, _>("fetched_at")?)?
            .with_timezone(&Utc);

        Ok(Some(FxRateCacheEntry {
            base_currency: row.try_get("base_currency")?,
            quote_currency: row.try_get("quote_currency")?,
            rate: row.try_get("rate")?,
            source: row.try_get("source")?,
            fetched_at,
        }))
    }

    async fn store_rate(&self, rate: &FxRateCacheEntry) -> anyhow::Result<()> {
        sqlx::query(
            r#"
            INSERT INTO fx_rates (base_currency, quote_currency, rate, source, fetched_at)
            VALUES (?1, ?2, ?3, ?4, ?5)
            ON CONFLICT(base_currency, quote_currency) DO UPDATE SET
                rate = excluded.rate,
                source = excluded.source,
                fetched_at = excluded.fetched_at
            "#,
        )
        .bind(&rate.base_currency)
        .bind(&rate.quote_currency)
        .bind(rate.rate)
        .bind(&rate.source)
        .bind(rate.fetched_at.to_rfc3339())
        .execute(&self.pool)
        .await?;

        Ok(())
    }
}
