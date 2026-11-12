//! Shared outbound HTTP protection. Success caches stay in their domain services.
//! All services and Python workers use the same SQLite budgets and JSON policy.
use std::{collections::HashMap, path::Path, sync::Arc, time::Duration};

use anyhow::Context;
use chrono::{DateTime, Utc};
use serde::{Deserialize, de::DeserializeOwned};
use serde_json::{Value, json};
use sqlx::{SqlitePool, sqlite::SqliteConnectOptions};

use super::provider_budget::Budget;
const BUDGET_SCHEMA: &str = include_str!(
    "../../python/src/agent_foundry_python/structured_products/migrations/0003_provider_budgets.sql"
);

const SCHEMA: &str = include_str!(
    "../../python/src/agent_foundry_python/structured_products/migrations/0002_provider_access.sql"
);

const POLICY: &str =
    include_str!("../../python/src/agent_foundry_python/structured_products/provider_policy.json");

#[derive(Deserialize)]
struct Backoff {
    initial_seconds: f64,
    max_seconds: f64,
}
#[derive(Deserialize)]
struct SourcePolicy {
    label: String,
    scope: String,
    interval_seconds: f64,
    budget: Budget,
}
#[derive(Deserialize)]
struct Policy {
    interval_seconds: f64,
    timeout_seconds: u64,
    missing_seconds: f64,
    refused: Backoff,
    limited: Backoff,
    unavailable: Backoff,
    sources: HashMap<String, SourcePolicy>,
    budget: Budget,
}

#[derive(Clone)]
pub struct ProviderAccess {
    pool: SqlitePool,
    interval_override: Option<f64>,
    policy: Arc<Policy>,
    client: reqwest::Client,
}

/// Deliberately carries no URL, response body or credentials.
#[derive(Debug, thiserror::Error)]
#[error("{source_name}: {reason} (HTTP {status})")]
pub struct ProviderRequestError {
    pub source_name: String,
    pub status: u16,
    reason: &'static str,
}

#[derive(Debug)]
pub struct ProviderCoolingDown(pub String);
impl std::fmt::Display for ProviderCoolingDown {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} 暂停访问，冷却结束后再尝试", self.0)
    }
}
impl std::error::Error for ProviderCoolingDown {}

#[derive(Debug, thiserror::Error)]
#[error("{source_name}: request budget exhausted; retry after {retry_at}")]
pub struct ProviderBudgetExhausted {
    pub source_name: String,
    pub retry_at: String,
}

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
        Self::build(pool, None).await
    }

    pub async fn from_pool(pool: SqlitePool, interval: f64) -> anyhow::Result<Self> {
        anyhow::ensure!(
            interval.is_finite() && interval >= 0.0,
            "invalid request interval"
        );
        Self::build(pool, Some(interval)).await
    }

    async fn build(pool: SqlitePool, interval_override: Option<f64>) -> anyhow::Result<Self> {
        let policy: Policy = serde_json::from_str(POLICY)?;
        anyhow::ensure!(
            policy.budget.valid() && policy.sources.values().all(|p| p.budget.valid()),
            "invalid provider budget"
        );
        sqlx::raw_sql(SCHEMA).execute(&pool).await?;
        sqlx::raw_sql(BUDGET_SCHEMA).execute(&pool).await?;
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(policy.timeout_seconds))
            .connect_timeout(Duration::from_secs(10))
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .user_agent("Agent-Foundry/market-data")
            .build()?;
        Ok(Self {
            pool,
            interval_override,
            policy: Arc::new(policy),
            client,
        })
    }

    /// All network I/O goes through this boundary. Resource is a stable, public
    /// cache key (e.g. a series ID), never an authenticated URL or API key.
    /// No immediate retry or redirect: both would bypass the shared budget.
    pub async fn json<T: DeserializeOwned>(
        &self,
        source: &str,
        resource: &str,
        request: impl FnOnce(&reqwest::Client) -> reqwest::RequestBuilder,
    ) -> anyhow::Result<T> {
        self.acquire(source, resource).await?;
        let response = match request(&self.client).send().await {
            Ok(response) => response,
            Err(_) => {
                self.record(source, resource, 0, None).await?;
                return Err(ProviderRequestError {
                    source_name: source.into(),
                    status: 0,
                    reason: "connection or timeout failure",
                }
                .into());
            }
        };
        let status = response.status();
        let retry = response
            .headers()
            .get("Retry-After")
            .and_then(|h| h.to_str().ok())
            .map(str::to_owned);
        if !status.is_success() {
            // Redirects are an unavailable endpoint, not permission to visit a
            // second host outside this budget (or forward credentials there).
            self.record(
                source,
                resource,
                if status.is_redirection() {
                    0
                } else {
                    status.as_u16()
                },
                retry.as_deref(),
            )
            .await?;
            return Err(ProviderRequestError {
                source_name: source.into(),
                status: status.as_u16(),
                reason: "request rejected",
            }
            .into());
        }
        let payload = match response.json().await {
            Ok(payload) => payload,
            Err(_) => {
                self.record(source, resource, 0, retry.as_deref()).await?;
                return Err(ProviderRequestError {
                    source_name: source.into(),
                    status: 0,
                    reason: "invalid or incomplete JSON response",
                }
                .into());
            }
        };
        self.record(source, resource, status.as_u16(), retry.as_deref())
            .await?;
        Ok(payload)
    }

    fn budget(&self, source: &str) -> &Budget {
        self.policy
            .sources
            .get(source)
            .map(|p| &p.budget)
            .unwrap_or(&self.policy.budget)
    }

    pub async fn acquire(&self, source: &str, resource: &str) -> anyhow::Result<()> {
        self.acquire_priority(source, resource, false).await
    }

    // Tier 1 workers and background clients reserve from the same sliding windows.
    async fn acquire_priority(
        &self,
        source: &str,
        resource: &str,
        tier1: bool,
    ) -> anyhow::Result<()> {
        loop {
            let now = now_seconds();
            // The lock covers both budget accounting and the spacing reservation.
            // It is released before sleeping or doing network I/O.
            let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
            sqlx::query("INSERT OR IGNORE INTO provider_access(source) VALUES (?)")
                .bind(source)
                .execute(&mut *tx)
                .await?;
            let (next, blocked): (f64, f64) = sqlx::query_as(
                "SELECT next_request_at, blocked_until FROM provider_access WHERE source=?",
            )
            .bind(source)
            .fetch_one(&mut *tx)
            .await?;
            if blocked > now {
                tx.commit().await?;
                return Err(ProviderCoolingDown(source.to_owned()).into());
            }
            let missing: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM provider_missing_products WHERE source=? AND resource=? AND retry_at>?)")
                .bind(source).bind(resource).bind(now).fetch_one(&mut *tx).await?;
            if missing {
                tx.commit().await?;
                return Err(ProviderRequestError {
                    source_name: source.into(),
                    status: 404,
                    reason: "cached missing resource",
                }
                .into());
            }
            let events: Vec<(f64, String)> = sqlx::query_as(
                "SELECT requested_at,priority FROM provider_request_events WHERE source=? AND requested_at>? ORDER BY requested_at")
                .bind(source).bind(now - 86400.0).fetch_all(&mut *tx).await?;
            let usage = self.budget(source).usage(&events, now);
            if usage.blocked(tier1) {
                tx.commit().await?;
                return Err(ProviderBudgetExhausted {
                    source_name: source.into(),
                    retry_at: iso_time(usage.retry_at(tier1)).unwrap_or_default(),
                }
                .into());
            }
            if next > now {
                tx.commit().await?;
                tokio::time::sleep(Duration::from_secs_f64((next - now).max(0.01))).await;
                continue;
            }
            let interval = self.interval_override.unwrap_or_else(|| {
                self.policy
                    .sources
                    .get(source)
                    .map_or(self.policy.interval_seconds, |p| p.interval_seconds)
            });
            sqlx::query("UPDATE provider_access SET next_request_at=? WHERE source=?")
                .bind(now + interval)
                .bind(source)
                .execute(&mut *tx)
                .await?;
            sqlx::query(
                "INSERT INTO provider_request_events(source,requested_at,priority) VALUES (?,?,?)",
            )
            .bind(source)
            .bind(now)
            .bind(if tier1 { "tier1" } else { "background" })
            .execute(&mut *tx)
            .await?;
            sqlx::query("DELETE FROM provider_request_events WHERE requested_at<=?")
                .bind(now - 86400.0)
                .execute(&mut *tx)
                .await?;
            tx.commit().await?;
            return Ok(());
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
            let backoff = match status {
                401 | 403 => &self.policy.refused,
                429 => &self.policy.limited,
                _ => &self.policy.unavailable,
            };
            let (base, cap) = (backoff.initial_seconds, backoff.max_seconds);
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
                    .bind(source).bind(resource).bind(now + self.policy.missing_seconds).execute(&self.pool).await?;
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
        let mut providers = Vec::with_capacity(rows.len());
        for (source, until, status, checked) in rows {
            let events: Vec<(f64, String)> = sqlx::query_as(
                "SELECT requested_at,priority FROM provider_request_events WHERE source=? AND requested_at>? ORDER BY requested_at")
                .bind(&source).bind(now - 86400.0).fetch_all(&self.pool).await?;
            providers.push(json!({
                "label": self.policy.sources.get(&source).map(|p| p.label.as_str()).unwrap_or(&source),
                "scope": self.policy.sources.get(&source).map(|p| p.scope.as_str()).unwrap_or("other"),
                "source": source, "coolingDown": until > now, "retryAt": iso_time(until),
                "lastStatus": status, "lastCheckedAt": iso_time(checked),
                "budget": self.budget(&source).usage(&events, now).payload(),
            }));
        }
        Ok(json!(providers))
    }
}

fn now_seconds() -> f64 {
    Utc::now().timestamp_millis() as f64 / 1000.0
}
pub(super) fn iso_time(seconds: f64) -> Option<String> {
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
    use crate::services::provider_test_support::MockHttp;

    #[tokio::test]
    async fn http_refusals_stop_other_clients_without_exposing_credentials() -> anyhow::Result<()> {
        for status in [401, 403, 429, 503] {
            let server = MockHttp::start(status, "{\"error\":\"no\"}", Some("172800")).await?;
            let access = access().await?;
            let result: anyhow::Result<Value> = access
                .json("vendor", "series:public", |c| {
                    c.get(&server.url)
                        .query(&[("api_key", "private-test-token")])
                })
                .await;
            let error = result.err().context("must fail")?;
            assert!(!format!("{error:#}").contains("private-test-token"));
            let restarted = ProviderAccess::from_pool(access.pool.clone(), 0.0).await?;
            let other: anyhow::Result<Value> = restarted
                .json("vendor", "another-endpoint", |c| c.get(&server.url))
                .await;
            assert!(other.is_err());
            assert_eq!(server.hits(), 1);
            let state = restarted.status().await?;
            let until =
                DateTime::parse_from_rfc3339(state[0]["retryAt"].as_str().context("retry")?)?;
            assert!(until.timestamp() as f64 >= now_seconds() + 172790.0);
        }
        Ok(())
    }

    #[tokio::test]
    async fn invalid_json_timeouts_and_redirects_pause_network_access() -> anyhow::Result<()> {
        for (status, body, path) in [(200, "not JSON", ""), (200, "{}", "/slow"), (302, "{}", "")] {
            let server = MockHttp::start(status, body, None).await?;
            let access = access().await?;
            let url = format!("{}{path}", server.url);
            let first: anyhow::Result<Value> = access
                .json("vendor", "one", |c| {
                    c.get(&url).timeout(Duration::from_millis(30))
                })
                .await;
            assert!(first.is_err());
            let second: anyhow::Result<Value> = access.json("vendor", "two", |c| c.get(&url)).await;
            assert!(second.is_err());
            assert_eq!(server.hits(), 1);
            assert_eq!(access.status().await?[0]["coolingDown"], true);
        }
        Ok(())
    }

    #[tokio::test]
    async fn missing_resource_and_other_sources_are_isolated() -> anyhow::Result<()> {
        let server = MockHttp::start(404, "{}", None).await?;
        let access = access().await?;
        let first: anyhow::Result<Value> = access
            .json("vendor", "missing", |c| c.get(&server.url))
            .await;
        assert!(first.is_err());
        server
            .status
            .store(200, std::sync::atomic::Ordering::SeqCst);
        let missing: anyhow::Result<Value> = access
            .json("vendor", "missing", |c| c.get(&server.url))
            .await;
        assert_eq!(
            missing
                .err()
                .context("cached missing")?
                .downcast_ref::<ProviderRequestError>()
                .map(|e| e.status),
            Some(404)
        );
        let _: Value = access
            .json("vendor", "exists", |c| c.get(&server.url))
            .await?;
        access.record("vendor", "exists", 403, None).await?;
        let _: Value = access
            .json("other-vendor", "exists", |c| c.get(&server.url))
            .await?;
        assert_eq!(server.hits(), 3);
        Ok(())
    }

    #[tokio::test]
    async fn cooldown_survives_reopening_the_database_file() -> anyhow::Result<()> {
        let temp = tempfile::tempdir()?;
        let db = temp.path().join("access.sqlite3");
        let first = ProviderAccess::open(&db).await?;
        first.acquire("api.onvista.de", "product").await?;
        first.record("api.onvista.de", "product", 429, None).await?;
        first.pool.close().await;
        let second = ProviderAccess::open(&db).await?;
        assert!(second.acquire("api.onvista.de", "search").await.is_err());
        assert_eq!(second.status().await?[0]["scope"], "products");
        Ok(())
    }

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
            interval_override: Some(0.03),
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

    async fn small_budget() -> anyhow::Result<ProviderAccess> {
        let mut access = access().await?;
        let mut policy: Policy = serde_json::from_str(POLICY)?;
        policy.budget = Budget {
            hour: 4,
            day: 5,
            tier1_reserved_hour: 2,
            tier1_reserved_day: 2,
        };
        access.policy = Arc::new(policy);
        Ok(access)
    }

    #[tokio::test]
    async fn budgets_survive_clients_and_preserve_tier1_capacity() -> anyhow::Result<()> {
        let first = small_budget().await?;
        first.acquire("test", "one").await?;
        first.acquire("test", "two").await?;
        let mut restarted = ProviderAccess::from_pool(first.pool.clone(), 0.0).await?;
        restarted.policy = first.policy.clone();
        let error = restarted
            .acquire("test", "background")
            .await
            .err()
            .context("must deny background")?;
        assert!(error.downcast_ref::<ProviderBudgetExhausted>().is_some());
        let state = restarted.status().await?;
        assert_eq!(state[0]["coolingDown"], false);
        assert_eq!(state[0]["budget"]["limited"], false);
        assert_eq!(state[0]["budget"]["backgroundLimited"], true);
        restarted.acquire_priority("test", "tier1-a", true).await?;
        restarted.acquire_priority("test", "tier1-b", true).await?;
        assert!(
            restarted
                .acquire_priority("test", "tier1-c", true)
                .await
                .is_err()
        );
        // Rolling hour expiry does not erase the daily budget.
        sqlx::query("UPDATE provider_request_events SET requested_at=requested_at-3601")
            .execute(&first.pool)
            .await?;
        restarted.acquire("test", "last-day-slot").await?;
        restarted.record("test", "last-day-slot", 200, None).await?;
        assert!(
            restarted
                .acquire_priority("test", "daily-denied", true)
                .await
                .is_err()
        );
        let state = restarted.status().await?;
        assert_eq!(state[0]["budget"]["day"]["used"], 5);
        assert_eq!(state[0]["lastStatus"], 200);
        assert_eq!(state[0]["budget"]["limited"], true);
        sqlx::query("UPDATE provider_request_events SET requested_at=requested_at-86401")
            .execute(&first.pool)
            .await?;
        restarted.acquire_priority("test", "new-day", true).await?;
        assert_eq!(restarted.status().await?[0]["budget"]["day"]["used"], 1);
        Ok(())
    }

    #[tokio::test]
    async fn concurrent_callers_cannot_overspend_and_denied_http_never_sends() -> anyhow::Result<()>
    {
        let access = small_budget().await?;
        let mut tasks = tokio::task::JoinSet::new();
        for _ in 0..12 {
            let client = access.clone();
            tasks.spawn(async move { client.acquire("test", "same").await.is_ok() });
        }
        let mut admitted = 0;
        while let Some(result) = tasks.join_next().await {
            admitted += usize::from(result?);
        }
        assert_eq!(admitted, 2);
        // A failing network endpoint would produce a transport error if reached.
        let error = access
            .json::<Value>("test", "denied", |client| {
                client.get("http://127.0.0.1:1/unreachable")
            })
            .await
            .err()
            .context("must deny before network")?;
        assert!(error.downcast_ref::<ProviderBudgetExhausted>().is_some());
        assert_eq!(access.status().await?[0]["budget"]["hour"]["used"], 2);
        assert_eq!(access.status().await?[0]["lastStatus"], Value::Null);
        Ok(())
    }

    #[tokio::test]
    async fn reservations_from_external_workers_count_towards_the_same_limits() -> anyhow::Result<()>
    {
        let access = small_budget().await?;
        // Matches the Python SourceGuard insert and shared migration exactly.
        for _ in 0..2 {
            sqlx::query(
                "INSERT INTO provider_request_events(source,requested_at,priority) VALUES (?,?,?)",
            )
            .bind("test")
            .bind(now_seconds())
            .bind("background")
            .execute(&access.pool)
            .await?;
        }
        assert!(access.acquire("test", "rust-background").await.is_err());
        access.acquire_priority("test", "tier1", true).await?;
        assert_eq!(access.status().await?[0]["budget"]["hour"]["used"], 3);
        access.acquire("independent-source", "allowed").await?;
        Ok(())
    }
}
