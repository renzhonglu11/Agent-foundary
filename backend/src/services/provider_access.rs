//! Access budgets shared with the Python worker in its enrichment database.
use std::{path::Path, time::Duration};

use anyhow::{Context, bail};
use chrono::{DateTime, Utc};
use serde_json::{Value, json};
use sqlx::{SqlitePool, sqlite::SqliteConnectOptions};

const SCHEMA: &str = include_str!(
    "../../python/src/agent_foundry_python/structured_products/migrations/0002_provider_access.sql"
);

#[derive(Clone)]
pub struct ProviderAccess {
    pool: SqlitePool,
    interval: f64,
}

#[derive(Debug)]
pub struct ProviderCoolingDown(pub String);
impl std::fmt::Display for ProviderCoolingDown {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} 暂停访问，冷却结束后再尝试", self.0)
    }
}
impl std::error::Error for ProviderCoolingDown {}

impl ProviderAccess {
    pub async fn open(path: &Path) -> anyhow::Result<Self> {
        if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
            tokio::fs::create_dir_all(parent).await?;
        }
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(2)
            .connect_with(
                SqliteConnectOptions::new()
                    .filename(path)
                    .create_if_missing(true)
                    .busy_timeout(Duration::from_secs(5)),
            )
            .await?;
        Self::from_pool(pool, 2.0).await
    }

    pub async fn from_pool(pool: SqlitePool, interval: f64) -> anyhow::Result<Self> {
        sqlx::raw_sql(SCHEMA).execute(&pool).await?;
        Ok(Self { pool, interval })
    }

    pub async fn acquire(&self, source: &str, resource: &str) -> anyhow::Result<()> {
        sqlx::query("INSERT OR IGNORE INTO provider_access(source) VALUES (?)")
            .bind(source)
            .execute(&self.pool)
            .await?;
        loop {
            let now = now_seconds();
            // Atomic reservation: Python and Rust cannot reserve the same slot.
            let reserved: Option<String> = sqlx::query_scalar(
                "UPDATE provider_access SET next_request_at=? WHERE source=? AND next_request_at<=? AND blocked_until<=? AND NOT EXISTS (SELECT 1 FROM provider_missing_products WHERE source=? AND resource=? AND retry_at>?) RETURNING source",
            ).bind(now + self.interval).bind(source).bind(now).bind(now)
                .bind(source).bind(resource).bind(now).fetch_optional(&self.pool).await?;
            if reserved.is_some() {
                return Ok(());
            }
            let (next, blocked): (f64, f64) = sqlx::query_as(
                "SELECT next_request_at, blocked_until FROM provider_access WHERE source=?",
            )
            .bind(source)
            .fetch_one(&self.pool)
            .await?;
            if blocked > now {
                return Err(ProviderCoolingDown(source.to_owned()).into());
            }
            let missing: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM provider_missing_products WHERE source=? AND resource=? AND retry_at>?)",
            ).bind(source).bind(resource).bind(now).fetch_one(&self.pool).await?;
            if missing {
                bail!("数据源暂未收录此产品，24 小时内复用缺失结果");
            }
            tokio::time::sleep(Duration::from_secs_f64((next - now).max(0.01))).await;
        }
    }

    pub async fn record(
        &self,
        source: &str,
        resource: &str,
        status: u16,
        retry_after: Option<&str>,
    ) -> anyhow::Result<()> {
        let now = now_seconds();
        if matches!(status, 0 | 401 | 403 | 429 | 500..=599) {
            let (base, cap) = match status {
                401 | 403 => (86400.0, 604800.0),
                429 => (3600.0, 86400.0),
                _ => (300.0, 3600.0),
            };
            sqlx::query("UPDATE provider_access SET blocked_until=MAX(blocked_until, ? + MAX(MIN(? * (1 << MIN(failures, 7)), ?), ?)), failures=MIN(failures+1, 8), last_status=?, updated_at=? WHERE source=?")
                .bind(now).bind(base).bind(cap).bind(retry_after_seconds(retry_after, now))
                .bind(i64::from(status)).bind(now).bind(source).execute(&self.pool).await?;
            tracing::warn!(
                source,
                status,
                "data source paused; cooldown persisted across workers and restarts"
            );
        } else {
            sqlx::query("UPDATE provider_access SET failures=0, last_status=?, updated_at=? WHERE source=? AND blocked_until<=?")
                .bind(i64::from(status)).bind(now).bind(source).bind(now).execute(&self.pool).await?;
            if status == 404 {
                sqlx::query("INSERT OR REPLACE INTO provider_missing_products(source,resource,retry_at) VALUES (?,?,?)")
                    .bind(source).bind(resource).bind(now + 86400.0).execute(&self.pool).await?;
            }
        }
        sqlx::query("DELETE FROM provider_missing_products WHERE retry_at<=?")
            .bind(now)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn status(&self) -> anyhow::Result<Value> {
        let rows: Vec<(String, f64, Option<i64>, f64)> = sqlx::query_as(
            "SELECT source, blocked_until, last_status, updated_at FROM provider_access ORDER BY source",
        ).fetch_all(&self.pool).await.context("read provider access state")?;
        let now = now_seconds();
        Ok(json!(
            rows.into_iter()
                .map(|(source, until, status, checked)| json!({
                    "source": source, "coolingDown": until > now, "retryAt": iso_time(until),
                    "lastStatus": status, "lastCheckedAt": iso_time(checked),
                }))
                .collect::<Vec<_>>()
        ))
    }
}

fn now_seconds() -> f64 {
    Utc::now().timestamp_millis() as f64 / 1000.0
}
fn iso_time(seconds: f64) -> Option<String> {
    if seconds <= 0.0 {
        return None;
    }
    DateTime::from_timestamp_millis((seconds * 1000.0) as i64).map(|at| at.to_rfc3339())
}
fn retry_after_seconds(value: Option<&str>, now: f64) -> f64 {
    value
        .and_then(|v| {
            v.trim().parse::<u64>().ok().map(|n| n as f64).or_else(|| {
                DateTime::parse_from_rfc2822(v)
                    .ok()
                    .map(|at| (at.timestamp() as f64 - now).max(0.0))
            })
        })
        .unwrap_or(0.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn access() -> anyhow::Result<ProviderAccess> {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await?;
        ProviderAccess::from_pool(pool, 0.0).await
    }

    #[tokio::test]
    async fn cooldown_is_shared_between_clients_and_preserves_long_retry_after()
    -> anyhow::Result<()> {
        let first = access().await?;
        first.acquire("api.onvista.de", "one").await?;
        first
            .record("api.onvista.de", "one", 429, Some("172800"))
            .await?;
        let second = ProviderAccess::from_pool(first.pool.clone(), 0.0).await?;
        let error = second
            .acquire("api.onvista.de", "two")
            .await
            .err()
            .context("must be cooling down")?;
        assert!(error.downcast_ref::<ProviderCoolingDown>().is_some());
        // A success already in flight never resets the other worker's refusal.
        second.record("api.onvista.de", "old", 200, None).await?;
        let state = second.status().await?;
        assert_eq!(state[0]["lastStatus"], 429);
        let until =
            DateTime::parse_from_rfc3339(state[0]["retryAt"].as_str().context("retry time")?)?;
        assert!(until.timestamp() as f64 >= now_seconds() + 172790.0);
        second.acquire("api.boerse-frankfurt.de", "one").await?;
        // Expired cooldowns allow one new attempt; another refusal backs off.
        sqlx::query("UPDATE provider_access SET blocked_until=0 WHERE source='api.onvista.de'")
            .execute(&first.pool)
            .await?;
        second.acquire("api.onvista.de", "two").await?;
        second.record("api.onvista.de", "two", 429, None).await?;
        let (failures, until): (i64, f64) = sqlx::query_as(
            "SELECT failures,blocked_until FROM provider_access WHERE source='api.onvista.de'",
        )
        .fetch_one(&first.pool)
        .await?;
        assert_eq!(failures, 2);
        assert!(until > now_seconds() + 7190.0);
        Ok(())
    }

    #[tokio::test]
    async fn missing_product_does_not_pause_others_and_expires() -> anyhow::Result<()> {
        let first = access().await?;
        first.acquire("source", "missing").await?;
        first.record("source", "missing", 404, None).await?;
        let second = ProviderAccess::from_pool(first.pool.clone(), 0.0).await?;
        assert!(second.acquire("source", "missing").await.is_err());
        second.acquire("source", "known").await?;
        sqlx::query("UPDATE provider_missing_products SET retry_at=0")
            .execute(&first.pool)
            .await?;
        second.acquire("source", "missing").await?;
        Ok(())
    }

    #[tokio::test]
    async fn separate_clients_cannot_take_the_same_request_slot() -> anyhow::Result<()> {
        let first = access().await?;
        let first = ProviderAccess {
            interval: 0.03,
            ..first
        };
        let second = ProviderAccess::from_pool(first.pool.clone(), 0.03).await?;
        first.acquire("source", "one").await?;
        let before: f64 = sqlx::query_scalar("SELECT next_request_at FROM provider_access")
            .fetch_one(&first.pool)
            .await?;
        second.acquire("source", "two").await?;
        assert!(now_seconds() >= before);
        Ok(())
    }

    #[test]
    fn retry_after_understands_http_date_and_seconds() {
        assert_eq!(retry_after_seconds(Some("7200"), 0.0), 7200.0);
        assert_eq!(
            retry_after_seconds(Some("Thu, 01 Jan 1970 02:00:00 GMT"), 0.0),
            7200.0
        );
        assert_eq!(retry_after_seconds(Some("tomorrow"), 0.0), 0.0);
    }
}
