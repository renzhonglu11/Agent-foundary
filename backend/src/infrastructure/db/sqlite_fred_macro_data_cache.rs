use anyhow::Context;
use chrono::{DateTime, Utc};
use sqlx::{Row, SqlitePool};

use crate::application::ports::fred_macro_data_cache::{
    FredMacroDataCache, FredMacroDataCacheEntry,
};
use crate::services::fred::{FredMacroDataResponse, FredObservation, FredSeriesData};

const FRED_CACHE_KEY: &str = "macro_data";

#[derive(Debug, Clone)]
pub struct SqliteFredMacroDataCache {
    pool: SqlitePool,
}

impl SqliteFredMacroDataCache {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    async fn get_latest_from_timeseries(&self) -> anyhow::Result<Option<FredMacroDataCacheEntry>> {
        let Some(row) = sqlx::query(
            r#"
            SELECT provider, status, generated_at, fetched_at, cache_ttl_seconds, warnings_json
            FROM fred_macro_cache_runs
            WHERE cache_key = ?1
            "#,
        )
        .bind(FRED_CACHE_KEY)
        .fetch_optional(&self.pool)
        .await?
        else {
            return Ok(None);
        };

        let fetched_at = DateTime::parse_from_rfc3339(&row.try_get::<String, _>("fetched_at")?)?
            .with_timezone(&Utc);
        let cache_ttl_seconds = u64::try_from(row.try_get::<i64, _>("cache_ttl_seconds")?)
            .context("FRED cache TTL must be non-negative")?;
        let warnings_json: String = row.try_get("warnings_json")?;
        let warnings: Vec<String> =
            serde_json::from_str(&warnings_json).context("failed to parse FRED warnings JSON")?;

        let series_rows = sqlx::query(
            r#"
            SELECT series_id, title, units, frequency
            FROM fred_series
            WHERE cache_key = ?1
            ORDER BY sort_order ASC, series_id ASC
            "#,
        )
        .bind(FRED_CACHE_KEY)
        .fetch_all(&self.pool)
        .await?;

        let mut series = Vec::with_capacity(series_rows.len());
        for series_row in series_rows {
            let series_id: String = series_row.try_get("series_id")?;
            let observation_rows = sqlx::query(
                r#"
                SELECT observation_date, value
                FROM fred_observations
                WHERE cache_key = ?1 AND series_id = ?2
                ORDER BY observation_date ASC
                "#,
            )
            .bind(FRED_CACHE_KEY)
            .bind(&series_id)
            .fetch_all(&self.pool)
            .await?;

            let observations = observation_rows
                .into_iter()
                .map(|observation_row| {
                    Ok(FredObservation {
                        date: observation_row.try_get("observation_date")?,
                        value: observation_row.try_get("value")?,
                    })
                })
                .collect::<Result<Vec<_>, sqlx::Error>>()?;

            series.push(FredSeriesData {
                id: series_id,
                title: series_row.try_get("title")?,
                units: series_row.try_get("units")?,
                frequency: series_row.try_get("frequency")?,
                observations,
            });
        }

        Ok(Some(FredMacroDataCacheEntry {
            response: FredMacroDataResponse {
                generated_at: row.try_get("generated_at")?,
                provider: row.try_get("provider")?,
                status: row.try_get("status")?,
                cache_ttl_seconds,
                series,
                warnings,
            },
            fetched_at,
        }))
    }

    async fn get_latest_from_snapshot(&self) -> anyhow::Result<Option<FredMacroDataCacheEntry>> {
        let Some(row) = sqlx::query(
            r#"
            SELECT payload_json, fetched_at
            FROM fred_macro_data_cache
            WHERE cache_key = ?1
            "#,
        )
        .bind(FRED_CACHE_KEY)
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
}

#[async_trait::async_trait]
impl FredMacroDataCache for SqliteFredMacroDataCache {
    async fn get_latest(&self) -> anyhow::Result<Option<FredMacroDataCacheEntry>> {
        if let Some(entry) = self.get_latest_from_timeseries().await? {
            return Ok(Some(entry));
        }

        self.get_latest_from_snapshot().await
    }

    async fn store(&self, entry: &FredMacroDataCacheEntry) -> anyhow::Result<()> {
        let payload_json = serde_json::to_string(&entry.response)?;
        let warnings_json = serde_json::to_string(&entry.response.warnings)?;
        let cache_ttl_seconds = i64::try_from(entry.response.cache_ttl_seconds)
            .context("FRED cache TTL exceeds SQLite integer range")?;
        let fetched_at = entry.fetched_at.to_rfc3339();

        let mut tx = self.pool.begin().await?;

        sqlx::query(
            r#"
            INSERT INTO fred_macro_data_cache (cache_key, status, payload_json, fetched_at)
            VALUES (?1, ?2, ?3, ?4)
            ON CONFLICT(cache_key) DO UPDATE SET
                status = excluded.status,
                payload_json = excluded.payload_json,
                fetched_at = excluded.fetched_at
            "#,
        )
        .bind(FRED_CACHE_KEY)
        .bind(&entry.response.status)
        .bind(payload_json)
        .bind(&fetched_at)
        .execute(&mut *tx)
        .await?;

        sqlx::query(
            r#"
            INSERT INTO fred_macro_cache_runs (
                cache_key, provider, status, generated_at, fetched_at, cache_ttl_seconds, warnings_json
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
            ON CONFLICT(cache_key) DO UPDATE SET
                provider = excluded.provider,
                status = excluded.status,
                generated_at = excluded.generated_at,
                fetched_at = excluded.fetched_at,
                cache_ttl_seconds = excluded.cache_ttl_seconds,
                warnings_json = excluded.warnings_json
            "#,
        )
        .bind(FRED_CACHE_KEY)
        .bind(&entry.response.provider)
        .bind(&entry.response.status)
        .bind(&entry.response.generated_at)
        .bind(&fetched_at)
        .bind(cache_ttl_seconds)
        .bind(warnings_json)
        .execute(&mut *tx)
        .await?;

        sqlx::query("DELETE FROM fred_observations WHERE cache_key = ?1")
            .bind(FRED_CACHE_KEY)
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM fred_series WHERE cache_key = ?1")
            .bind(FRED_CACHE_KEY)
            .execute(&mut *tx)
            .await?;

        for (sort_order, series) in entry.response.series.iter().enumerate() {
            let sort_order =
                i64::try_from(sort_order).context("FRED series sort order exceeds SQLite range")?;
            sqlx::query(
                r#"
                INSERT INTO fred_series (
                    cache_key, series_id, title, units, frequency, sort_order, updated_at
                )
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                "#,
            )
            .bind(FRED_CACHE_KEY)
            .bind(&series.id)
            .bind(&series.title)
            .bind(&series.units)
            .bind(&series.frequency)
            .bind(sort_order)
            .bind(&fetched_at)
            .execute(&mut *tx)
            .await?;

            for observation in &series.observations {
                sqlx::query(
                    r#"
                    INSERT INTO fred_observations (
                        cache_key, series_id, observation_date, value, fetched_at
                    )
                    VALUES (?1, ?2, ?3, ?4, ?5)
                    "#,
                )
                .bind(FRED_CACHE_KEY)
                .bind(&series.id)
                .bind(&observation.date)
                .bind(observation.value)
                .bind(&fetched_at)
                .execute(&mut *tx)
                .await?;
            }
        }

        tx.commit().await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use anyhow::Result;
    use chrono::{DateTime, Utc};
    use sqlx::{SqlitePool, sqlite::SqlitePoolOptions};

    use super::SqliteFredMacroDataCache;
    use crate::{
        application::ports::fred_macro_data_cache::{FredMacroDataCache, FredMacroDataCacheEntry},
        services::fred::{FredMacroDataResponse, FredObservation, FredSeriesData},
    };

    #[tokio::test]
    async fn store_writes_snapshot_and_timeseries_tables() -> Result<()> {
        let pool = test_pool().await?;
        create_test_schema(&pool).await?;
        let cache = SqliteFredMacroDataCache::new(pool.clone());
        let entry = test_entry()?;

        cache.store(&entry).await?;

        let series_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM fred_series")
            .fetch_one(&pool)
            .await?;
        let observation_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM fred_observations")
            .fetch_one(&pool)
            .await?;
        let cpi_value: f64 = sqlx::query_scalar(
            r#"
            SELECT value
            FROM fred_observations
            WHERE series_id = ?1 AND observation_date = ?2
            "#,
        )
        .bind("CPIAUCSL")
        .bind("2026-02-01")
        .fetch_one(&pool)
        .await?;
        let payload_length: i64 = sqlx::query_scalar(
            "SELECT length(payload_json) FROM fred_macro_data_cache WHERE cache_key = 'macro_data'",
        )
        .fetch_one(&pool)
        .await?;

        assert_eq!(series_count, 2);
        assert_eq!(observation_count, 3);
        assert_eq!(cpi_value, 312.2);
        assert!(payload_length > 0);

        Ok(())
    }

    #[tokio::test]
    async fn get_latest_prefers_timeseries_tables_over_legacy_snapshot() -> Result<()> {
        let pool = test_pool().await?;
        create_test_schema(&pool).await?;
        let cache = SqliteFredMacroDataCache::new(pool.clone());
        let entry = test_entry()?;

        cache.store(&entry).await?;
        sqlx::query(
            r#"
            UPDATE fred_macro_data_cache
            SET payload_json = ?1
            WHERE cache_key = 'macro_data'
            "#,
        )
        .bind(
            r#"{"generatedAt":"2000-01-01T00:00:00Z","provider":"legacy","status":"live","cacheTtlSeconds":1,"series":[],"warnings":[]}"#,
        )
        .execute(&pool)
        .await?;

        let latest = cache
            .get_latest()
            .await?
            .ok_or_else(|| anyhow::anyhow!("expected FRED cache entry"))?;

        assert_eq!(latest.response.provider, "fred");
        assert_eq!(latest.response.generated_at, "2026-06-16T19:02:35Z");
        assert_eq!(latest.response.series.len(), 2);
        assert_eq!(latest.response.series[0].id, "FEDFUNDS");
        assert_eq!(latest.response.series[1].observations[1].value, 312.2);

        Ok(())
    }

    async fn test_pool() -> Result<SqlitePool> {
        Ok(SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await?)
    }

    async fn create_test_schema(pool: &SqlitePool) -> Result<()> {
        sqlx::query(
            r#"
            CREATE TABLE fred_macro_data_cache (
                cache_key TEXT PRIMARY KEY,
                status TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                fetched_at TEXT NOT NULL
            )
            "#,
        )
        .execute(pool)
        .await?;
        sqlx::query(
            r#"
            CREATE TABLE fred_macro_cache_runs (
                cache_key TEXT PRIMARY KEY,
                provider TEXT NOT NULL,
                status TEXT NOT NULL,
                generated_at TEXT NOT NULL,
                fetched_at TEXT NOT NULL,
                cache_ttl_seconds INTEGER NOT NULL,
                warnings_json TEXT NOT NULL DEFAULT '[]'
            )
            "#,
        )
        .execute(pool)
        .await?;
        sqlx::query(
            r#"
            CREATE TABLE fred_series (
                cache_key TEXT NOT NULL,
                series_id TEXT NOT NULL,
                title TEXT NOT NULL,
                units TEXT NOT NULL,
                frequency TEXT NOT NULL,
                sort_order INTEGER NOT NULL,
                updated_at TEXT NOT NULL,
                PRIMARY KEY (cache_key, series_id)
            )
            "#,
        )
        .execute(pool)
        .await?;
        sqlx::query(
            r#"
            CREATE TABLE fred_observations (
                cache_key TEXT NOT NULL,
                series_id TEXT NOT NULL,
                observation_date TEXT NOT NULL,
                value REAL NOT NULL,
                fetched_at TEXT NOT NULL,
                PRIMARY KEY (cache_key, series_id, observation_date)
            )
            "#,
        )
        .execute(pool)
        .await?;

        Ok(())
    }

    fn test_entry() -> Result<FredMacroDataCacheEntry> {
        Ok(FredMacroDataCacheEntry {
            response: FredMacroDataResponse {
                generated_at: "2026-06-16T19:02:35Z".to_owned(),
                provider: "fred".to_owned(),
                status: "live".to_owned(),
                cache_ttl_seconds: 86_400,
                series: vec![
                    FredSeriesData {
                        id: "FEDFUNDS".to_owned(),
                        title: "Federal Funds Effective Rate".to_owned(),
                        units: "Percent".to_owned(),
                        frequency: "Monthly".to_owned(),
                        observations: vec![FredObservation {
                            date: "2026-01-01".to_owned(),
                            value: 4.33,
                        }],
                    },
                    FredSeriesData {
                        id: "CPIAUCSL".to_owned(),
                        title: "Consumer Price Index".to_owned(),
                        units: "Index".to_owned(),
                        frequency: "Monthly".to_owned(),
                        observations: vec![
                            FredObservation {
                                date: "2026-01-01".to_owned(),
                                value: 311.1,
                            },
                            FredObservation {
                                date: "2026-02-01".to_owned(),
                                value: 312.2,
                            },
                        ],
                    },
                ],
                warnings: vec!["sample warning".to_owned()],
            },
            fetched_at: DateTime::parse_from_rfc3339("2026-06-16T19:02:35Z")?.with_timezone(&Utc),
        })
    }
}
