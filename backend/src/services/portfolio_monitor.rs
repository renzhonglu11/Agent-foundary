use std::{
    collections::{BTreeSet, HashMap},
    hash::{DefaultHasher, Hash, Hasher},
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
        monitor_alerts::{self, SettingsRecord},
        monitor_calendar::{UsSession, quote_quality, us_session},
        monitor_history, monitor_risk,
        monitor_symbols::underlying_symbol,
        structured_products_service::StructuredProductsService,
    },
};

/// Longest time an unchanged portfolio goes without a new stored snapshot.
/// Until then only the clock has moved, which shifts expiries and decay slowly.
const UNCHANGED_RECALC_MINUTES: i64 = 15;

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
    history_retention_days: i64,
    write_gate: Arc<Mutex<()>>,
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
            history_retention_days: std::env::var("PORTFOLIO_MONITOR_HISTORY_RETENTION_DAYS")
                .ok()
                .and_then(|v| v.parse::<i64>().ok())
                .unwrap_or(730)
                .clamp(100, 3650),
            write_gate: Arc::new(Mutex::new(())),
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
            "structuredProducts":self.products.status_payload(),
            "historyRetentionDays":self.history_retention_days,
            "unchangedRecalcMinutes":UNCHANGED_RECALC_MINUTES,
            "configuration":monitor_alerts::settings(&self.pool).await?,
            "alerts":monitor_alerts::list(&self.pool).await?}),
        )
    }

    pub async fn history(&self) -> anyhow::Result<Value> {
        let rows: Vec<(String, String)> = sqlx::query_as("SELECT snapshot_key, captured_at FROM portfolio_monitor_snapshots WHERE snapshot_key LIKE 'hour:%' ORDER BY captured_at DESC LIMIT 168").fetch_all(&self.pool).await?;
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

    pub async fn save_settings(&self, record: &SettingsRecord) -> anyhow::Result<bool> {
        let _guard = self.write_gate.lock().await;
        let saved = monitor_alerts::save_settings(&self.pool, record).await?;
        if saved {
            self.request_refresh();
        }
        Ok(saved)
    }

    pub async fn acknowledge(&self, key: &str) -> anyhow::Result<bool> {
        let _guard = self.write_gate.lock().await;
        monitor_alerts::acknowledge(&self.pool, key).await
    }

    pub async fn alert_events(&self, key: &str) -> anyhow::Result<Value> {
        monitor_alerts::events(&self.pool, key).await
    }

    pub async fn daily_history(&self) -> anyhow::Result<Value> {
        monitor_history::history(&self.pool).await
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
            let mut next_history = Utc::now();
            // Inputs and time of the last stored snapshot. Empty while an alert
            // still waits for a confirming observation, so the next cycle runs in full.
            let mut settled: Option<(u64, DateTime<Utc>)> = None;
            let mut last_checked: Option<DateTime<Utc>> = None;
            loop {
                let now = Utc::now();
                *service.status.lock().await =
                    json!({"running":true,"lastStartedAt":now,"lastCheckedAt":last_checked});
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
                    let mut daily_stats=Vec::new();
                    let mut history_warnings=Vec::new();
                    let refresh_history=now>=next_history;
                    for chunk in symbols.chunks(30) {
                        match tokio::time::timeout(Duration::from_secs(45),service.alpaca.daily_bar_stats(&chunk.join(","),!refresh_history)).await {
                            Ok(response)=>{daily_stats.extend(response.stats);history_warnings.extend(response.warnings);},
                            Err(_)=>history_warnings.push("后台日线更新超时，相关历史指标暂缺".into()),
                        }
                    }
                    if refresh_history {next_history=Utc::now()+TimeDelta::minutes(15);}
                    let mut payload = evaluate(&summary, &enrichment, &quotes, &session, Utc::now());
                    payload["inputs"]["dailyStats"]=json!(daily_stats);
                    payload["historyWarnings"]=json!(history_warnings);
                    let product_market_open = service.products.market_open().await;
                    payload["productMarketOpen"] = json!(product_market_open);
                    if let Some(rows) = payload["positions"].as_array_mut() {
                        for row in rows {
                            let fetched = row["fetchedAt"].as_str().and_then(|s| DateTime::parse_from_rfc3339(s).ok());
                            let issue = fetched.and_then(|time| {
                                if time.with_timezone(&Utc) > now + TimeDelta::minutes(2) { Some("product_capture_future") }
                                else if product_market_open && matches!(row["valuationSource"].as_str(), Some("boerse_frankfurt" | "onvista")) && now - time.with_timezone(&Utc) > TimeDelta::minutes(120) { Some("product_capture_stale") }
                                else { None }
                            });
                            if let Some(issue) = issue { if let Some(issues) = row["issues"].as_array_mut() { issues.push(json!(issue)); } }
                        }
                    }
                    payload["provider"] = last_provider.clone();
                    payload["nextQuoteAttemptAt"] = json!(next_quotes);
                    payload["structuredProducts"] = service.products.status_payload();
                    let _guard=service.write_gate.lock().await;
                    let configuration=monitor_alerts::settings(&service.pool).await?;
                    let fingerprint=input_fingerprint(&payload,&configuration)?;
                    if settled.is_some_and(|(stored,at)| stored==fingerprint && now-at<TimeDelta::minutes(UNCHANGED_RECALC_MINUTES)) {
                        return Ok(false);
                    }
                    let evaluated_at=monitor_risk::timestamp(&payload["evaluatedAt"]).unwrap_or_else(Utc::now);
                    payload["risk"]=monitor_risk::evaluate(&payload,&configuration.settings,evaluated_at);
                    payload["configuration"]=json!(configuration);
                    payload["historyRetentionDays"]=json!(service.history_retention_days);
                    let awaiting=persist_snapshot(&service.pool, &payload, service.retention_days).await?;
                    settled=(!awaiting).then_some((fingerprint,now));
                    Ok::<_, anyhow::Error>(true)
                }.await;
                *service.status.lock().await = match result {
                    Ok(stored) => {
                        last_checked = Some(Utc::now());
                        json!({"running":false,"lastFinishedAt":last_checked,"lastCheckedAt":last_checked,
                            "lastCycle":if stored { "stored" } else { "unchanged" },"lastError":null})
                    }
                    Err(error) => {
                        tracing::warn!(%error, "portfolio monitor cycle failed");
                        json!({"running":false,"lastFinishedAt":Utc::now(),"lastCheckedAt":last_checked,"lastError":error.to_string()})
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

/// Everything a snapshot is calculated from except the clock. Position rows
/// carry the data-quality verdicts, so a quote going stale counts as a change.
fn input_fingerprint(payload: &Value, configuration: &SettingsRecord) -> anyhow::Result<u64> {
    let mut hasher = DefaultHasher::new();
    for part in [
        &payload["positions"],
        &payload["inputs"]["enrichment"]["items"],
        &payload["inputs"]["dailyStats"],
        &payload["holdingsMarketValue"],
        &payload["usSession"],
        &payload["productMarketOpen"],
        &payload["provider"],
        &payload["historyWarnings"],
    ] {
        serde_json::to_vec(part)?.hash(&mut hasher);
    }
    serde_json::to_vec(configuration)?.hash(&mut hasher);
    // The daily snapshot becomes due by time alone, 15 minutes after the close.
    monitor_history::daily_key(payload).hash(&mut hasher);
    Ok(hasher.finish())
}

/// Stores the snapshot and returns whether an alert still waits for a
/// confirming observation.
async fn persist_snapshot(
    pool: &SqlitePool,
    payload: &Value,
    retention_days: i64,
) -> anyhow::Result<bool> {
    let mut payload = payload.clone();
    let mut tx = pool.begin().await?;
    let mut awaiting = false;
    if payload["risk"].is_object() {
        let configuration: SettingsRecord =
            serde_json::from_value(payload["configuration"].clone())?;
        monitor_alerts::evaluate(&mut tx, &payload, &configuration).await?;
        let counts: Vec<(String,i64)>=sqlx::query_as("SELECT json_extract(state_json,'$.status'),COUNT(*) FROM portfolio_monitor_alerts WHERE json_extract(state_json,'$.status') IN ('active','acknowledged','invalidated','resolved','pending') GROUP BY json_extract(state_json,'$.status')").fetch_all(&mut *tx).await?;
        payload["alertSummary"] = json!(
            counts
                .into_iter()
                .collect::<std::collections::BTreeMap<_, _>>()
        );
        monitor_history::persist_day(&mut tx, &payload).await?;
        let now = monitor_risk::timestamp(&payload["evaluatedAt"])
            .ok_or_else(|| anyhow::anyhow!("invalid evaluation time"))?;
        monitor_history::prune(
            &mut tx,
            now,
            payload["historyRetentionDays"].as_i64().unwrap_or(730),
        )
        .await?;
        awaiting = monitor_alerts::awaiting_confirmation(&mut tx, now).await?;
    }
    let time = payload["evaluatedAt"].as_str().unwrap_or("");
    let hour = format!("hour:{}", &time[..time.len().min(13)]);
    let content = serde_json::to_string(&payload)?;
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
    Ok(awaiting)
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
            && matches!(
                item["quote_source"].as_str(),
                Some("boerse_frankfurt" | "onvista")
            )
            && item["quote_currency"] != "EUR"
        {
            issues.push("product_currency_unsupported".into());
        }
        rows.push(json!({"symbol":p.symbol,"name":p.display_name,"quantity":p.quantity,"marketValue":p.market_value,
            "assetClass":p.asset_class,"instrument":p.instrument,
            "price":p.last_price,"currency":p.valuation_currency,"valuationSource":p.valuation_source,
            "marketAsOf":p.price_as_of,"fetchedAt":p.price_fetched_at,"underlyingSymbol":symbol,
            "underlyingQuality":quality,"underlyingQuote":quote,"enrichmentTier":item["enrichment_tier"],
            "greeksSource":item["greeks_source"],"greeksMarketAsOf":Value::Null,"issues":issues}));
    }
    json!({"schemaVersion":2,"evaluatedAt":now,"basis":"holdings_market_value","currency":"EUR",
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

    #[test]
    fn fingerprint_ignores_the_clock_but_not_inputs_or_due_work() -> anyhow::Result<()> {
        let mut summary = calculate_portfolio(&[], CalculatorInput::default());
        summary.positions = vec![Position {
            symbol: "NVDA".into(),
            quantity: 1.0,
            last_price: 100.0,
            market_value: 100.0,
            ..Default::default()
        }];
        let session = UsSession {
            state: "closed",
            last_close: Some("2026-09-04T20:00:00Z".parse()?),
            open: None,
            next_open: Some("2026-09-08T13:30:00Z".parse()?),
            source: "alpaca_calendar",
        };
        let config = SettingsRecord {
            revision: 0,
            settings: monitor_risk::RiskSettings::default(),
        };
        let observe =
            |quote: &AlpacaQuote, session: &UsSession, time: &str| -> anyhow::Result<u64> {
                let mut payload = evaluate(
                    &summary,
                    &Value::Null,
                    std::slice::from_ref(quote),
                    session,
                    time.parse()?,
                );
                payload["productMarketOpen"] = json!(false);
                input_fingerprint(&payload, &config)
            };
        let snapshot = |quote: &AlpacaQuote, time: &str| observe(quote, &session, time);
        let mut quote = test_quote()?;
        let base = snapshot(&quote, "2026-09-05T10:00:00Z")?;
        // A minute later nothing but the clock has moved.
        assert_eq!(snapshot(&quote, "2026-09-05T10:01:00Z")?, base);
        // Inside the window for the daily snapshot, which is due by time alone.
        assert_ne!(snapshot(&quote, "2026-09-04T20:20:00Z")?, base);
        // During trading the same quote turns stale after ten minutes.
        let open = UsSession {
            state: "open",
            open: Some("2026-09-08T13:30:00Z".parse()?),
            ..session.clone()
        };
        quote.price_as_of = "2026-09-08T15:00:00Z".into();
        let fresh = observe(&quote, &open, "2026-09-08T15:05:00Z")?;
        assert_eq!(observe(&quote, &open, "2026-09-08T15:06:00Z")?, fresh);
        assert_ne!(observe(&quote, &open, "2026-09-08T15:20:00Z")?, fresh);
        quote.price = 101.0;
        assert_ne!(observe(&quote, &open, "2026-09-08T15:05:00Z")?, fresh);
        let mut payload = evaluate(
            &summary,
            &Value::Null,
            &[],
            &session,
            "2026-09-05T10:00:00Z".parse()?,
        );
        payload["productMarketOpen"] = json!(false);
        let changed = SettingsRecord {
            revision: 1,
            ..config.clone()
        };
        assert_ne!(
            input_fingerprint(&payload, &changed)?,
            input_fingerprint(&payload, &config)?
        );
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

    #[tokio::test]
    async fn background_cycle_persists_risk_alert_evidence_and_daily_state_across_restart()
    -> anyhow::Result<()> {
        use crate::infrastructure::db::migrations::run_migrations;
        let dir = tempfile::tempdir()?;
        let url = format!(
            "sqlite://{}?mode=rwc",
            dir.path().join("cycle.db").display()
        );
        let pool = SqlitePool::connect(&url).await?;
        run_migrations(&pool).await?;
        let cases: Value = serde_json::from_str(include_str!(
            "../../tests/fixtures/monitor-risk-parity.json"
        ))?;
        let config = SettingsRecord {
            revision: 0,
            settings: monitor_risk::RiskSettings {
                max_loss_eur: Some(1.0),
                ..Default::default()
            },
        };
        let mut awaiting = Vec::new();
        for minute in [15, 16] {
            let time = format!("2026-11-10T21:{minute}:00Z");
            let mut payload = json!({"evaluatedAt":time,"usSession":{"state":"closed","lastClose":"2026-11-10T21:00:00Z"},"productMarketOpen":false,
                "configuration":config,"positions":[cases[0]["row"]],"grossHoldingsValue":200,"inputs":{"enrichment":{"items":[cases[0]["item"]]}}});
            payload["risk"] = monitor_risk::evaluate(&payload, &config.settings, time.parse()?);
            awaiting.push(persist_snapshot(&pool, &payload, 30).await?);
        }
        // The first breach is pending and needs the next cycle; the second confirms it.
        assert_eq!(awaiting, [true, false]);
        assert!(monitor_alerts::acknowledge(&pool, "0:stress_loss:portfolio").await?);
        pool.close().await;
        let pool = SqlitePool::connect(&url).await?;
        let alerts = monitor_alerts::list(&pool).await?;
        assert!(
            alerts
                .as_array()
                .into_iter()
                .flatten()
                .any(|a| a["rule"] == "stress_loss" && a["status"] == "acknowledged")
        );
        let events = monitor_alerts::events(&pool, "0:stress_loss:portfolio").await?;
        assert_eq!(events.as_array().map(Vec::len), Some(2));
        let key = events[0]["state"]["evidenceKey"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("missing evidence"))?;
        let raw: String = sqlx::query_scalar(
            "SELECT payload_json FROM portfolio_monitor_snapshots WHERE snapshot_key=?",
        )
        .bind(key)
        .fetch_one(&pool)
        .await?;
        let evidence: Value = serde_json::from_str(&raw)?;
        assert_eq!(
            evidence["risk"]["modelVersion"],
            monitor_risk::MODEL_VERSION
        );
        assert!(evidence["inputs"]["enrichment"].is_object());
        let history = monitor_history::history(&pool).await?;
        assert_eq!(history["days"].as_array().map(Vec::len), Some(1));
        assert_eq!(history["days"][0]["capturedAt"], "2026-11-10T21:15:00Z");
        // An invalid frozen model rolls back both the latest update and its alert changes.
        let mut broken = evidence;
        broken["evaluatedAt"] = json!("2026-11-11T21:15:00Z");
        broken["usSession"]["lastClose"] = json!("2026-11-11T21:00:00Z");
        broken["risk"]["models"] = json!("invalid");
        assert!(persist_snapshot(&pool, &broken, 30).await.is_err());
        let last: String = sqlx::query_scalar(
            "SELECT captured_at FROM portfolio_monitor_snapshots WHERE snapshot_key='latest'",
        )
        .fetch_one(&pool)
        .await?;
        assert_eq!(last, "2026-11-10T21:16:00Z");
        Ok(())
    }
}
