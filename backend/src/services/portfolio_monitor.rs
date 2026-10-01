use std::{
    collections::{BTreeSet, HashMap},
    sync::Arc,
    time::Duration,
};

use apca::api::v2::calendar::OpenClose;
use chrono::{DateTime, NaiveDate, TimeDelta, Utc};
use serde_json::{Value, json};
use sqlx::SqlitePool;
use tokio::sync::{Mutex, Notify};

use crate::{
    application::services::portfolio_service::PortfolioService,
    domain::portfolio::PortfolioSummaryResponse,
    services::{
        alpaca_market_data::{AlpacaMarketDataService, AlpacaQuote, AlpacaQuoteStatus},
        monitor_calendar::{UsSession, quote_quality, us_session},
        monitor_symbols::underlying_symbol,
        structured_products_service::StructuredProductsService,
    },
};

#[derive(Clone)]
pub struct PortfolioMonitor {
    pool: SqlitePool,
    portfolio: PortfolioService,
    products: StructuredProductsService,
    alpaca: AlpacaMarketDataService,
    wake: Arc<Notify>,
    status: Arc<Mutex<Value>>,
    enabled: bool,
    interval: u64,
    retention_days: i64,
}

impl PortfolioMonitor {
    pub fn new(
        pool: SqlitePool,
        portfolio: PortfolioService,
        products: StructuredProductsService,
        alpaca: AlpacaMarketDataService,
    ) -> Self {
        let enabled = std::env::var("PORTFOLIO_MONITOR_ENABLED").map_or(true, |v| {
            !matches!(v.to_lowercase().as_str(), "false" | "0" | "no")
        });
        let interval = std::env::var("PORTFOLIO_MONITOR_INTERVAL_SECONDS")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(300)
            .clamp(60, 3600);
        // At least seven days keeps the 168-hour history endpoint complete.
        let retention_days = std::env::var("PORTFOLIO_MONITOR_RETENTION_DAYS")
            .ok()
            .and_then(|v| v.parse::<i64>().ok())
            .unwrap_or(30)
            .clamp(7, 3650);
        Self {
            pool,
            portfolio,
            products,
            alpaca,
            wake: Arc::new(Notify::new()),
            status: Arc::new(Mutex::new(json!({"running":false}))),
            enabled,
            interval,
            retention_days,
        }
    }

    pub fn request_refresh(&self) {
        if self.enabled {
            self.wake.notify_one();
        }
    }

    pub async fn status(&self) -> anyhow::Result<Value> {
        let payload: Option<String> = sqlx::query_scalar(
            "SELECT payload_json FROM portfolio_monitor_snapshots WHERE snapshot_key = 'latest'",
        )
        .fetch_optional(&self.pool)
        .await?;
        let snapshot = payload
            .map(|s| serde_json::from_str::<Value>(&s))
            .transpose()?
            .map(|mut value| {
                if let Some(object) = value.as_object_mut() {
                    object.remove("inputs");
                }
                value
            });
        Ok(
            json!({"enabled":self.enabled,"intervalSeconds":self.interval,"retentionDays":self.retention_days,"runtime":self.status.lock().await.clone(),
            "snapshot":snapshot,
            "structuredProducts":self.products.status_payload()}),
        )
    }

    pub async fn history(&self) -> anyhow::Result<Value> {
        let rows: Vec<(String, String)> = sqlx::query_as("SELECT snapshot_key, captured_at FROM portfolio_monitor_snapshots WHERE snapshot_key != 'latest' ORDER BY captured_at DESC LIMIT 168").fetch_all(&self.pool).await?;
        Ok(json!(
            rows.into_iter()
                .map(|(key, captured_at)| json!({"key":key,"capturedAt":captured_at}))
                .collect::<Vec<_>>()
        ))
    }

    pub async fn snapshot(&self, key: &str) -> anyhow::Result<Option<Value>> {
        let payload: Option<String> = sqlx::query_scalar(
            "SELECT payload_json FROM portfolio_monitor_snapshots WHERE snapshot_key = ?",
        )
        .bind(key)
        .fetch_optional(&self.pool)
        .await?;
        payload
            .map(|s| serde_json::from_str(&s).map_err(Into::into))
            .transpose()
    }

    pub fn start(&self) {
        if !self.enabled {
            return;
        }
        let service = self.clone();
        tokio::spawn(async move {
            let mut calendar: Option<(NaiveDate, Vec<OpenClose>)> = None;
            let mut calendar_retry = Utc::now();
            let mut next_quotes = Utc::now();
            let mut previous_symbols = Vec::new();
            let mut last_close_fetched: Option<DateTime<Utc>> = None;
            let mut last_provider: Value = json!({"status":"not_requested"});
            loop {
                let now = Utc::now();
                *service.status.lock().await = json!({"running":true,"lastStartedAt":now});
                let result = async {
                    if calendar.as_ref().is_none_or(|(date, _)| *date != now.date_naive()) && now >= calendar_retry {
                        calendar_retry = now + TimeDelta::minutes(15);
                        match service.alpaca.market_calendar(now.date_naive() - TimeDelta::days(14), now.date_naive() + TimeDelta::days(14)).await {
                            Ok(days) if !days.is_empty() => calendar = Some((now.date_naive(), days)),
                            Ok(_) => calendar = None,
                            Err(error) => { tracing::warn!(%error, "portfolio monitor calendar unavailable"); }
                        }
                    }
                    // Do not trust a calendar indefinitely after repeated failures.
                    let days = calendar.as_ref().filter(|(date, _)| now.date_naive() - *date < TimeDelta::days(2)).map(|(_, days)| days.as_slice());
                    let session = us_session(now, days);
                    let summary = service.portfolio.summary().await?;
                    let enrichment = service.products.read_persisted_payload().await;
                    let items = enrichment_items(&enrichment);
                    let symbols: Vec<_> = summary.positions.iter().filter_map(|p| underlying_symbol(p, items.get(p.symbol.as_str()).copied().unwrap_or(&Value::Null))).collect::<BTreeSet<_>>().into_iter().collect();
                    let changed = symbols != previous_symbols;
                    let closing = session.last_close.is_some_and(|close| Some(close) != last_close_fetched);
                    let should_fetch = now >= next_quotes && (session.state != "closed" || closing || changed);
                    if should_fetch {
                        let mut responses = Vec::new();
                        let mut failed = false;
                        for chunk in symbols.chunks(service.alpaca.batch_size()) {
                            let response = service.alpaca.latest_quotes(&chunk.join(",")).await;
                            failed |= !matches!(response.status, AlpacaQuoteStatus::Ok | AlpacaQuoteStatus::EmptyRequest);
                            responses.push(json!({"status":response.status,"warnings":response.warnings,"generatedAt":response.generated_at}));
                        }
                        last_provider = json!({"checkedAt":Utc::now(),"batches":responses,"failed":failed});
                        // Backoff also applies to unknown-calendar refreshes and manual requests.
                        next_quotes = Utc::now() + TimeDelta::seconds(if failed { service.interval.max(900) } else { service.interval } as i64);
                        if !failed { last_close_fetched = session.last_close; previous_symbols = symbols.clone(); }
                    }
                    let mut quotes = Vec::new();
                    for chunk in symbols.chunks(service.alpaca.batch_size()) {
                        quotes.extend(service.alpaca.persisted_quotes(&chunk.join(",")).await.quotes);
                    }
                    let mut payload = evaluate(&summary, &enrichment, &quotes, &session, Utc::now());
                    let product_market_open = service.products.market_open().await;
                    payload["productMarketOpen"] = json!(product_market_open);
                    if let Some(rows) = payload["positions"].as_array_mut() {
                        for row in rows {
                            let fetched = row["fetchedAt"].as_str().and_then(|s| DateTime::parse_from_rfc3339(s).ok());
                            let issue = fetched.and_then(|time| {
                                if time.with_timezone(&Utc) > now + TimeDelta::minutes(2) { Some("product_capture_future") }
                                else if product_market_open && row["valuationSource"] == "boerse_frankfurt" && now - time.with_timezone(&Utc) > TimeDelta::minutes(120) { Some("product_capture_stale") }
                                else { None }
                            });
                            if let Some(issue) = issue { if let Some(issues) = row["issues"].as_array_mut() { issues.push(json!(issue)); } }
                        }
                    }
                    payload["provider"] = last_provider.clone();
                    payload["nextQuoteAttemptAt"] = json!(next_quotes);
                    payload["structuredProducts"] = service.products.status_payload();
                    persist_snapshot(&service.pool, &payload, service.retention_days).await?;
                    Ok::<_, anyhow::Error>(())
                }.await;
                *service.status.lock().await = match result {
                    Ok(()) => json!({"running":false,"lastFinishedAt":Utc::now(),"lastError":null}),
                    Err(error) => {
                        tracing::warn!(%error, "portfolio monitor cycle failed");
                        json!({"running":false,"lastFinishedAt":Utc::now(),"lastError":error.to_string()})
                    }
                };
                tokio::select! {
                    _ = tokio::time::sleep(Duration::from_secs(60)) => {},
                    _ = service.wake.notified() => {},
                }
            }
        });
    }
}

async fn persist_snapshot(
    pool: &SqlitePool,
    payload: &Value,
    retention_days: i64,
) -> anyhow::Result<()> {
    let time = payload["evaluatedAt"].as_str().unwrap_or("");
    let hour = format!("hour:{}", &time[..time.len().min(13)]);
    let content = serde_json::to_string(payload)?;
    let mut tx = pool.begin().await?;
    for key in ["latest", hour.as_str()] {
        sqlx::query("INSERT INTO portfolio_monitor_snapshots(snapshot_key,captured_at,payload_json) VALUES(?,?,?) ON CONFLICT(snapshot_key) DO UPDATE SET captured_at=excluded.captured_at,payload_json=excluded.payload_json")
                .bind(key).bind(time).bind(&content).execute(&mut *tx).await?;
    }
    // Hourly keys sort chronologically, so retention is a key-range delete that never touches 'latest'.
    if let Ok(evaluated_at) = DateTime::parse_from_rfc3339(time) {
        let cutoff = evaluated_at.with_timezone(&Utc) - TimeDelta::days(retention_days);
        sqlx::query("DELETE FROM portfolio_monitor_snapshots WHERE snapshot_key >= 'hour:' AND snapshot_key < ?")
            .bind(format!("hour:{}", cutoff.format("%Y-%m-%dT%H")))
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(())
}

fn enrichment_items(payload: &Value) -> HashMap<&str, &Value> {
    payload["items"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|item| item["isin"].as_str().map(|isin| (isin, item)))
        .collect()
}

pub fn evaluate(
    summary: &PortfolioSummaryResponse,
    enrichment: &Value,
    quotes: &[AlpacaQuote],
    session: &UsSession,
    now: DateTime<Utc>,
) -> Value {
    let items = enrichment_items(enrichment);
    let quotes_by_symbol: HashMap<_, _> = quotes.iter().map(|q| (q.symbol.as_str(), q)).collect();
    let mut rows = Vec::new();
    let mut mapped_value = 0.0;
    let mut usable_value = 0.0;
    let mut gross_value = 0.0;
    for p in &summary.positions {
        let item = items
            .get(p.symbol.as_str())
            .copied()
            .unwrap_or(&Value::Null);
        let symbol = underlying_symbol(p, item);
        let quote = symbol
            .as_deref()
            .and_then(|s| quotes_by_symbol.get(s).copied());
        let quality = if symbol.is_none() {
            "unmapped"
        } else if quote.is_none() {
            "missing"
        } else if quote.is_some_and(|q| !q.price.is_finite() || q.price <= 0.0) {
            "invalid_quote"
        } else {
            quote_quality(quote.map(|q| q.price_as_of.as_str()), now, session)
        };
        let value = p.market_value.abs();
        gross_value += value;
        if symbol.is_some() {
            mapped_value += value;
        }
        if matches!(quality, "fresh" | "closed_last_session") {
            usable_value += value;
        }
        let mut issues = Vec::new();
        if !matches!(quality, "fresh" | "closed_last_session") {
            issues.push(format!("underlying_{quality}"));
        }
        if p.price_as_of.is_none() {
            issues.push("valuation_market_time_unknown".into());
        }
        if p.last_price <= 0.0 || !p.market_value.is_finite() {
            issues.push("valuation_missing_or_invalid".into());
        }
        if let Some(quote) = quote {
            if quote.fx_rate_source != "frankfurter" {
                issues.push("fx_reference_fallback".into());
            }
            if p.price_fetched_at
                .as_deref()
                .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
                .zip(DateTime::parse_from_rfc3339(&quote.price_as_of).ok())
                .is_some_and(|(product, underlying)| (product - underlying).num_hours().abs() > 24)
            {
                issues.push("product_underlying_time_gap_over_24h".into());
            }
        }
        if item["product_type"].is_string() {
            issues.push("greeks_market_time_unknown".into());
        }
        if item["quote_price"].as_f64().is_some_and(|v| v > 0.0)
            && item["quote_source"] == "boerse_frankfurt"
            && item["quote_currency"] != "EUR"
        {
            issues.push("product_currency_unsupported".into());
        }
        rows.push(json!({"symbol":p.symbol,"name":p.display_name,"quantity":p.quantity,"marketValue":p.market_value,
            "price":p.last_price,"currency":p.valuation_currency,"valuationSource":p.valuation_source,
            "marketAsOf":p.price_as_of,"fetchedAt":p.price_fetched_at,"underlyingSymbol":symbol,
            "underlyingQuality":quality,"underlyingQuote":quote,"enrichmentTier":item["enrichment_tier"],
            "greeksSource":item["greeks_source"],"greeksMarketAsOf":Value::Null,"issues":issues}));
    }
    json!({"schemaVersion":1,"evaluatedAt":now,"basis":"holdings_market_value","currency":"EUR",
        "cashBalance":Value::Null,"liabilities":Value::Null,"accountNav":Value::Null,
        "holdingsMarketValue":summary.summary.total_market_value,"grossHoldingsValue":gross_value,
        "positionCount":rows.len(),"mappedUnderlyingValue":mapped_value,"usableUnderlyingValue":usable_value,
        "usableUnderlyingCoveragePct":if gross_value > 0.0 { usable_value / gross_value * 100.0 } else { 0.0 },
        "uncoveredUnderlyingValue":gross_value - usable_value,"usSession":session,"positions":rows,
        "directPriceStress":([-20.0,-50.0,-100.0].map(|move_pct| json!({"productMovePct":move_pct,"pnl":summary.summary.total_market_value * move_pct / 100.0}))),
        "inputs":{"portfolio":summary,"enrichment":enrichment,"quotes":quotes},
        "limitations":["现金与负债未核实，分母为持仓市值；不是完整账户 NAV", "标的行情覆盖率不等于衍生品模型覆盖率", "产品抓取时间不代表市场报价时间；Greeks 时间未知", "标的代码映射可能是 ADR/跨市场代理，须核对产品条款", "直接报价压力不是标的冲击，也不是现金流调整后的收益或回撤"]})
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        application::services::portfolio_calculator::{CalculatorInput, calculate_portfolio},
        domain::portfolio::Position,
    };

    fn test_quote() -> anyhow::Result<AlpacaQuote> {
        // A newly fetched quote may still describe the previous trading session.
        Ok(AlpacaQuote {
            symbol: "NVDA".into(),
            price: 100.0,
            currency: "EUR".into(),
            bid_price: 99.0,
            ask_price: 101.0,
            raw_price: 110.0,
            raw_bid_price: 109.0,
            raw_ask_price: 111.0,
            raw_currency: "USD".into(),
            usd_eur_rate: 0.91,
            fx_rate_source: "frankfurter".into(),
            bid_size: 1,
            ask_size: 1,
            price_source: "alpaca_iex".into(),
            price_as_of: "2026-09-04T20:00:00Z".into(),
            fetched_at: "2026-09-07T00:00:00Z".into(),
            cached: true,
        })
    }

    #[test]
    fn all_holdings_remain_in_denominator_and_unknown_cash_is_not_zero() -> anyhow::Result<()> {
        let mut summary = calculate_portfolio(&[], CalculatorInput::default());
        summary.positions = vec![
            Position {
                symbol: "NVDA".into(),
                quantity: 1.0,
                last_price: 100.0,
                market_value: 100.0,
                valuation_source: "transaction_fallback".into(),
                ..Default::default()
            },
            Position {
                symbol: "DE000UNKNOWN".into(),
                quantity: 1.0,
                last_price: 300.0,
                market_value: 300.0,
                ..Default::default()
            },
        ];
        summary.summary.total_market_value = 400.0;
        let now = "2026-09-07T16:00:00Z".parse()?;
        let session = UsSession {
            state: "closed",
            last_close: Some("2026-09-04T20:00:00Z".parse()?),
            open: None,
            next_open: Some("2026-09-08T13:30:00Z".parse()?),
            source: "alpaca_calendar",
        };
        let mut quote = test_quote()?;
        let payload = evaluate(&summary, &Value::Null, &[quote.clone()], &session, now);
        assert_eq!(payload["positionCount"], 2);
        assert_eq!(payload["usableUnderlyingCoveragePct"], 25.0);
        assert_eq!(payload["uncoveredUnderlyingValue"], 300.0);
        assert_eq!(payload["directPriceStress"][2]["pnl"], -400.0);
        assert!(payload["cashBalance"].is_null());
        assert!(payload["accountNav"].is_null());
        assert!(payload["positions"][0]["marketAsOf"].is_null());
        quote.price_as_of = "2026-08-25T20:00:00Z".into();
        let payload = evaluate(&summary, &Value::Null, &[quote], &session, now);
        assert_eq!(payload["usableUnderlyingCoveragePct"], 0.0);
        assert_eq!(payload["positions"][0]["underlyingQuality"], "stale");
        Ok(())
    }

    #[tokio::test]
    async fn snapshots_survive_reopen_and_keep_last_observation_per_hour() -> anyhow::Result<()> {
        let dir = tempfile::tempdir()?;
        let url = format!(
            "sqlite://{}?mode=rwc",
            dir.path().join("monitor.db").display()
        );
        let pool = SqlitePool::connect(&url).await?;
        sqlx::raw_sql(include_str!(
            "../../migrations/20260907010000_create_portfolio_monitor_snapshots.sql"
        ))
        .execute(&pool)
        .await?;
        for (time, value) in [
            ("2026-09-07T20:01:00Z", 1),
            ("2026-09-07T20:59:00Z", 2),
            ("2026-09-07T21:01:00Z", 3),
        ] {
            persist_snapshot(
                &pool,
                &json!({"evaluatedAt":time,"inputs":{"value":value}}),
                30,
            )
            .await?;
        }
        pool.close().await;
        let pool = SqlitePool::connect(&url).await?;
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM portfolio_monitor_snapshots")
            .fetch_one(&pool)
            .await?;
        assert_eq!(count, 3); // latest + two hours
        let content: String = sqlx::query_scalar("SELECT payload_json FROM portfolio_monitor_snapshots WHERE snapshot_key='hour:2026-09-07T20'").fetch_one(&pool).await?;
        assert_eq!(
            serde_json::from_str::<Value>(&content)?["inputs"]["value"],
            2
        );
        pool.close().await;
        Ok(())
    }

    #[tokio::test]
    async fn snapshots_older_than_retention_are_pruned() -> anyhow::Result<()> {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await?;
        sqlx::raw_sql(include_str!(
            "../../migrations/20260907010000_create_portfolio_monitor_snapshots.sql"
        ))
        .execute(&pool)
        .await?;
        for time in [
            "2026-09-01T09:30:00Z",
            "2026-09-01T10:30:00Z",
            "2026-09-01T11:30:00Z",
            "2026-09-08T10:30:00Z",
        ] {
            persist_snapshot(&pool, &json!({"evaluatedAt":time}), 7).await?;
        }
        let keys: Vec<String> = sqlx::query_scalar(
            "SELECT snapshot_key FROM portfolio_monitor_snapshots ORDER BY snapshot_key",
        )
        .fetch_all(&pool)
        .await?;
        assert_eq!(
            keys,
            [
                "hour:2026-09-01T10",
                "hour:2026-09-01T11",
                "hour:2026-09-08T10",
                "latest"
            ]
        );
        Ok(())
    }
}
