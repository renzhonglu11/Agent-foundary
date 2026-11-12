//! Immutable post-close observations and forward-only model checks.
use chrono::{DateTime, TimeDelta, Utc};
use serde_json::{Value, json};
use sqlx::{SqliteConnection, SqlitePool};

use super::monitor_risk::{MODEL_VERSION, ModelPosition, number, project, timestamp};

pub fn daily_key(payload: &Value) -> Option<String> {
    if payload["usSession"]["state"] != "closed" || payload["productMarketOpen"] != false {
        return None;
    }
    let now = timestamp(&payload["evaluatedAt"])?;
    let close = timestamp(&payload["usSession"]["lastClose"])?;
    let age = now - close;
    // First observed cycle after both markets have closed. Never invent a day
    // missed during downtime, nor turn a weekend into a new observation.
    if age < TimeDelta::minutes(15) || age > TimeDelta::hours(8) {
        return None;
    }
    Some(format!("day:{}", close.format("%Y-%m-%d")))
}

pub fn freeze_forecasts(payload: &mut Value) -> anyhow::Result<()> {
    let days = payload["risk"]["settings"]["horizonDays"]
        .as_u64()
        .unwrap_or(7)
        .max(1) as f64;
    let models: Vec<ModelPosition> = serde_json::from_value(payload["risk"]["models"].clone())?;
    payload["forecasts"] = json!(
        models
            .iter()
            .map(|m| json!({"id":m.id,"horizonDays":days,
        "flatPrice":project(m,0.0,days,0.0,0.0,&[]),"assumption":"underlying_iv_fx_unchanged"}))
            .collect::<Vec<_>>()
    );
    Ok(())
}

/// Reasons that weaken a comparison without voiding it. The product quote has
/// no market time, the path between the two closes was not observed, or the
/// volatility came from the provider without a timestamp.
const SOFT_REASONS: [&str; 3] = [
    "market_time_unknown",
    "intraday_path_unobserved",
    "greeks_time_unknown",
];

/// Without a market time the capture time stands in, but only for a provider
/// quote captured around the US close the snapshot belongs to. A price from an
/// uploaded statement has no such anchor.
fn captured_near_close(snapshot: &Value, row: &Value) -> Option<DateTime<Utc>> {
    let close = timestamp(&snapshot["usSession"]["lastClose"])?;
    let window = (close - TimeDelta::hours(2))..=(close + TimeDelta::minutes(90));
    let captured = timestamp(&row["fetchedAt"])?;
    let underlying = timestamp(&row["underlyingQuote"]["priceAsOf"])?;
    (matches!(
        row["valuationSource"].as_str(),
        Some("boerse_frankfurt" | "onvista")
    ) && window.contains(&captured)
        && window.contains(&underlying))
    .then_some(captured)
}

fn error_summary(rows: &[Value], tier: &str) -> Value {
    let errors: Vec<f64> = rows
        .iter()
        .filter(|row| row[tier] == true)
        .filter_map(|row| number(&row["modelErrorPct"]))
        .collect();
    if errors.is_empty() {
        return json!({"count":0,"meanAbsoluteErrorPct":null,"meanErrorPct":null});
    }
    let count = errors.len() as f64;
    json!({"count":errors.len(),
        "meanAbsoluteErrorPct":errors.iter().map(|value| value.abs()).sum::<f64>() / count,
        "meanErrorPct":errors.iter().sum::<f64>() / count})
}

pub fn compare(
    origin_key: &str,
    origin: &Value,
    target_key: &str,
    target: &Value,
) -> anyhow::Result<Value> {
    let before = timestamp(&origin["evaluatedAt"])
        .ok_or_else(|| anyhow::anyhow!("origin timestamp missing"))?;
    let after = timestamp(&target["evaluatedAt"])
        .ok_or_else(|| anyhow::anyhow!("target timestamp missing"))?;
    anyhow::ensure!(after > before, "calibration must move forwards");
    let elapsed = (after - before).num_seconds() as f64 / 86400.0;
    if origin["risk"]["modelVersion"] != MODEL_VERSION {
        return Ok(
            json!({"originKey":origin_key,"targetKey":target_key,"reason":"model_version_changed","eligibleCount":0,"rows":[]}),
        );
    }
    let models: Vec<ModelPosition> = serde_json::from_value(origin["risk"]["models"].clone())?;
    let mut rows = Vec::new();
    for m in models {
        let old_row = origin["positions"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|p| p["symbol"] == m.id)
            .unwrap_or(&Value::Null);
        let row = target["positions"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|p| p["symbol"] == m.id)
            .unwrap_or(&Value::Null);
        let next_model = target["risk"]["models"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|p| p["id"] == m.id)
            .cloned()
            .map(serde_json::from_value::<ModelPosition>)
            .transpose()?;
        let forecast = origin["forecasts"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|p| p["id"] == m.id)
            .unwrap_or(&Value::Null);
        let actual = number(&row["price"]).filter(|v| *v > 0.0);
        // Every reason that applies, most serious first; the first one is shown.
        let mut reasons: Vec<&'static str> = Vec::new();
        if row.is_null() {
            reasons.push("position_closed_or_missing");
        } else if actual.is_none() || next_model.is_none() {
            reasons.push("inputs_unavailable");
        } else if m.dte.is_some_and(|days| days <= elapsed) {
            reasons.push("expired_without_settlement");
        }
        let mut conditional = None;
        let mut underlying_move = None;
        if let Some(ref next) = next_model {
            let move_pct = (next.raw_spot / m.raw_spot - 1.0) * 100.0;
            underlying_move = Some(move_pct);
            conditional = Some(project(
                &m,
                move_pct,
                elapsed,
                0.0,
                (next.fx / m.fx - 1.0) * 100.0,
                &[],
            ));
            let strike_changed = m.product_type == "optionsschein"
                && m.strike
                    .zip(next.strike)
                    .is_some_and(|(a, b)| (a / m.fx - b / next.fx).abs() > 1e-6);
            let terms = |p: &Value| {
                p["inputs"]["enrichment"]["items"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .find(|i| i["isin"] == m.id)
                    .map(|i| i["expiry"].clone())
            };
            if m.product_type != next.product_type
                || m.put != next.put
                || m.ratio != next.ratio
                || strike_changed
                || terms(origin) != terms(target)
            {
                reasons.push("contract_changed");
            }
        }
        match (
            timestamp(&old_row["marketAsOf"]),
            timestamp(&row["marketAsOf"]),
        ) {
            (Some(a), Some(b)) if b <= a => reasons.push("quote_not_advanced"),
            (Some(a), Some(b)) => {
                let old_spot = timestamp(&old_row["underlyingQuote"]["priceAsOf"]);
                let new_spot = timestamp(&row["underlyingQuote"]["priceAsOf"]);
                if a > before + TimeDelta::minutes(2) || b > after + TimeDelta::minutes(2) {
                    reasons.push("future_market_time");
                } else if old_spot.is_none_or(|t| (a - t).num_minutes().abs() > 120)
                    || new_spot.is_none_or(|t| (b - t).num_minutes().abs() > 120)
                {
                    reasons.push("quote_time_mismatch");
                }
            }
            _ => {
                reasons.push("market_time_unknown");
                // The capture times must themselves describe two different closes.
                let captures =
                    captured_near_close(origin, old_row).zip(captured_near_close(target, row));
                if captures.is_none_or(|(first, second)| second <= first) {
                    reasons.push("capture_time_unusable");
                }
            }
        }
        if matches!(
            m.product_type.as_str(),
            "factor_certificate" | "open_end_turbo" | "knock_out"
        ) {
            reasons.push("intraday_path_unobserved");
        }
        if m.method == "bs_iv" {
            reasons.push("greeks_time_unknown");
        }
        if m.usd
            && (old_row["underlyingQuote"]["fxRateSource"] != "frankfurter"
                || row["underlyingQuote"]["fxRateSource"] != "frankfurter")
        {
            reasons.push("fx_reference_fallback");
        }
        let error = conditional
            .zip(actual)
            .map(|(predicted, observed)| (predicted - observed) / m.price * 100.0);
        let eligible = reasons.is_empty() && error.is_some();
        // Usable as a rough reading: nothing voids the comparison, only its timing or path is uncertain.
        let indicative = !reasons.is_empty()
            && reasons.iter().all(|reason| SOFT_REASONS.contains(reason))
            && error.is_some();
        rows.push(json!({"id":m.id,"name":m.name,"productType":m.product_type,"originPrice":m.price,"actualPrice":actual,
            "forecastPrice":forecast["flatPrice"],"forecastHorizonDays":forecast["horizonDays"],"conditionalPrice":conditional,
            "actualChangePct":actual.map(|p|(p/m.price-1.0)*100.0),"forecastErrorPct":number(&forecast["flatPrice"]).zip(actual).map(|(p,a)|(p-a)/m.price*100.0),
            "modelErrorPct":error,"eligible":eligible,"indicative":indicative,"reason":reasons.first().copied().unwrap_or("comparable"),"reasons":reasons,"underlyingMovePct":underlying_move,
            "quantityChanged":number(&row["quantity"]).is_some_and(|q|(q-m.quantity).abs()>1e-8),
            "scenarioExceeded":underlying_move.zip(number(&origin["risk"]["settings"]["shockPct"])).map(|(v,s)|v.abs()>s*number(&origin["risk"]["groupScales"][&m.group]).unwrap_or(1.0))}));
    }
    let reliable = error_summary(&rows, "eligible");
    let indicative = error_summary(&rows, "indicative");
    let mut by_type: std::collections::BTreeMap<String, Vec<Value>> = Default::default();
    for row in rows.iter().filter(|row| row["indicative"] == true) {
        by_type
            .entry(row["productType"].as_str().unwrap_or("unknown").into())
            .or_default()
            .push(row.clone());
    }
    let indicative_by_type: std::collections::BTreeMap<_, _> = by_type
        .iter()
        .map(|(product_type, rows)| (product_type, error_summary(rows, "indicative")))
        .collect();
    let eligible_count = reliable["count"].as_u64().unwrap_or(0) as usize;
    Ok(
        json!({"originKey":origin_key,"targetKey":target_key,"originAt":before,"targetAt":after,"elapsedDays":elapsed,
        "modelVersion":origin["risk"]["modelVersion"],"eligibleCount":eligible_count,"excludedCount":rows.len()-eligible_count,
        "meanAbsoluteErrorPct":reliable["meanAbsoluteErrorPct"],"meanErrorPct":reliable["meanErrorPct"],
        "indicativeCount":indicative["count"],"indicativeMeanAbsoluteErrorPct":indicative["meanAbsoluteErrorPct"],
        "indicativeMeanErrorPct":indicative["meanErrorPct"],"indicativeByProductType":indicative_by_type,
        "indicativeBasis":"quote_or_path_timing_uncertain",
        "rows":rows,"basis":"price_change_per_unit_not_portfolio_return"}),
    )
}

pub async fn persist_day(conn: &mut SqliteConnection, payload: &Value) -> anyhow::Result<()> {
    let Some(key) = daily_key(payload) else {
        return Ok(());
    };
    let mut daily = payload.clone();
    freeze_forecasts(&mut daily)?;
    daily["snapshotKind"] = json!("first_post_close_observation");
    let inserted=sqlx::query("INSERT INTO portfolio_monitor_snapshots(snapshot_key,captured_at,payload_json) VALUES(?,?,?) ON CONFLICT(snapshot_key) DO NOTHING")
        .bind(&key).bind(payload["evaluatedAt"].as_str()).bind(serde_json::to_string(&daily)?).execute(&mut *conn).await?.rows_affected();
    if inserted == 0 {
        return Ok(());
    }
    let origins: Vec<(String,String)>=sqlx::query_as("SELECT snapshot_key,payload_json FROM portfolio_monitor_snapshots WHERE snapshot_key LIKE 'day:%' AND snapshot_key < ? AND snapshot_key NOT IN (SELECT origin_key FROM portfolio_monitor_calibrations) ORDER BY snapshot_key DESC LIMIT 100")
        .bind(&key).fetch_all(&mut *conn).await?;
    let today = timestamp(&payload["usSession"]["lastClose"])
        .ok_or_else(|| anyhow::anyhow!("daily close missing"))?
        .date_naive();
    for (origin_key, raw) in origins {
        let origin: Value = serde_json::from_str(&raw)?;
        let Some(close) = timestamp(&origin["usSession"]["lastClose"]) else {
            continue;
        };
        let horizon = origin["risk"]["settings"]["horizonDays"]
            .as_i64()
            .unwrap_or(7)
            .max(1);
        let gap = (today - close.date_naive()).num_days();
        if gap < horizon {
            continue;
        }
        let result = if gap > horizon + 7 {
            json!({"originKey":origin_key,"targetKey":key,"reason":"target_window_missed","eligibleCount":0,"rows":[]})
        } else {
            compare(&origin_key, &origin, &key, &daily)?
        };
        sqlx::query("INSERT INTO portfolio_monitor_calibrations(origin_key,target_key,calculated_at,payload_json) VALUES(?,?,?,?) ON CONFLICT DO NOTHING")
            .bind(origin_key).bind(&key).bind(payload["evaluatedAt"].as_str()).bind(serde_json::to_string(&result)?).execute(&mut *conn).await?;
    }
    Ok(())
}

pub async fn history(pool: &SqlitePool) -> anyhow::Result<Value> {
    // List summaries without deserializing 90 complete portfolio inputs.
    let rows: Vec<String>=sqlx::query_scalar("SELECT json_object('key',snapshot_key,'capturedAt',captured_at,'modelVersion',json_extract(payload_json,'$.risk.modelVersion'),'coveragePct',json_extract(payload_json,'$.risk.coveragePct'),'worstPnl',json_extract(payload_json,'$.risk.worstPnl'),'alertSummary',json_extract(payload_json,'$.alertSummary')) FROM portfolio_monitor_snapshots WHERE snapshot_key LIKE 'day:%' ORDER BY snapshot_key DESC LIMIT 90").fetch_all(pool).await?;
    let days = rows
        .into_iter()
        .map(|s| serde_json::from_str::<Value>(&s))
        .collect::<Result<Vec<_>, _>>()?;
    let raw: Vec<String>=sqlx::query_scalar("SELECT payload_json FROM portfolio_monitor_calibrations ORDER BY target_key DESC,origin_key DESC LIMIT 90").fetch_all(pool).await?;
    let calibrations = raw
        .into_iter()
        .map(|s| serde_json::from_str::<Value>(&s))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(json!({"days":days,"calibrations":calibrations}))
}

pub async fn prune(
    conn: &mut SqliteConnection,
    now: DateTime<Utc>,
    days: i64,
) -> anyhow::Result<()> {
    let cutoff = (now - TimeDelta::days(days)).to_rfc3339();
    sqlx::query("DELETE FROM portfolio_monitor_alerts WHERE updated_at < ? AND json_extract(state_json,'$.status') NOT IN ('active','acknowledged','pending')").bind(&cutoff).execute(&mut *conn).await?;
    sqlx::query("DELETE FROM portfolio_monitor_calibrations WHERE calculated_at < ?")
        .bind(&cutoff)
        .execute(&mut *conn)
        .await?;
    sqlx::query("DELETE FROM portfolio_monitor_alert_events WHERE happened_at < ? AND alert_key NOT IN (SELECT alert_key FROM portfolio_monitor_alerts WHERE json_extract(state_json,'$.status') IN ('active','acknowledged','pending'))")
        .bind(&cutoff).execute(&mut *conn).await?;
    sqlx::query("DELETE FROM portfolio_monitor_snapshots WHERE (snapshot_key LIKE 'day:%' OR snapshot_key LIKE 'event:%') AND captured_at < ? AND snapshot_key NOT IN (SELECT snapshot_key FROM portfolio_monitor_alert_events WHERE snapshot_key IS NOT NULL) AND snapshot_key NOT IN (SELECT json_extract(state_json,'$.evidenceKey') FROM portfolio_monitor_alerts WHERE json_extract(state_json,'$.evidenceKey') IS NOT NULL) AND snapshot_key NOT IN (SELECT origin_key FROM portfolio_monitor_calibrations UNION SELECT target_key FROM portfolio_monitor_calibrations)")
        .bind(cutoff).execute(&mut *conn).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        infrastructure::db::migrations::run_migrations,
        services::monitor_risk::{self, RiskSettings},
    };

    fn observation(day: &str, price: f64, spot: f64) -> anyhow::Result<Value> {
        let mut cases: Value = serde_json::from_str(include_str!(
            "../../tests/fixtures/monitor-risk-parity.json"
        ))?;
        cases[0]["item"]["iv"] = json!(1.0); // Quote calibration stays within the provider sanity bounds.
        let mut row = cases[0]["row"].clone();
        row["price"] = json!(price);
        row["marketValue"] = json!(price * 100.0);
        row["marketAsOf"] = json!(format!("{day}T21:00:00Z"));
        row["underlyingQuote"]["priceAsOf"] = row["marketAsOf"].clone();
        row["underlyingQuote"]["rawPrice"] = json!(spot);
        let now: DateTime<Utc> = format!("{day}T21:15:00Z").parse()?;
        let mut p = json!({"evaluatedAt":now,"usSession":{"state":"closed","lastClose":format!("{day}T21:00:00Z")},"productMarketOpen":false,
            "positions":[row],"grossHoldingsValue":price*100.0,"inputs":{"enrichment":{"items":[cases[0]["item"]]}}});
        p["risk"] = monitor_risk::evaluate(&p, &RiskSettings::default(), now);
        freeze_forecasts(&mut p)?;
        Ok(p)
    }
    async fn pool() -> anyhow::Result<SqlitePool> {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await?;
        run_migrations(&pool).await?;
        Ok(pool)
    }
    async fn save(pool: &SqlitePool, value: &Value) -> anyhow::Result<()> {
        let mut tx = pool.begin().await?;
        persist_day(&mut tx, value).await?;
        tx.commit().await?;
        Ok(())
    }
    #[test]
    fn daily_window_excludes_trading_hours_unknown_calendars_and_missed_days() -> anyhow::Result<()>
    {
        let mut p = observation("2026-11-10", 2.0, 100.0)?;
        assert_eq!(daily_key(&p).as_deref(), Some("day:2026-11-10"));
        p["productMarketOpen"] = json!(true);
        assert!(daily_key(&p).is_none());
        p["productMarketOpen"] = json!(false);
        p["evaluatedAt"] = json!("2026-11-10T21:14:59Z");
        assert!(daily_key(&p).is_none());
        p["evaluatedAt"] = json!("2026-11-11T00:10:00Z");
        assert_eq!(daily_key(&p).as_deref(), Some("day:2026-11-10"));
        p["evaluatedAt"] = json!("2026-11-11T12:00:00Z");
        assert!(daily_key(&p).is_none());
        p["usSession"]["state"] = json!("unknown");
        assert!(daily_key(&p).is_none());
        Ok(())
    }
    #[tokio::test]
    async fn daily_snapshots_are_immutable_and_calibration_waits_for_the_frozen_horizon()
    -> anyhow::Result<()> {
        let pool = pool().await?;
        let p = observation("2026-11-10", 2.0, 100.0)?;
        save(&pool, &p).await?;
        let mut replacement = p.clone();
        replacement["positions"][0]["price"] = json!(999.0);
        save(&pool, &replacement).await?;
        let raw:String=sqlx::query_scalar("SELECT payload_json FROM portfolio_monitor_snapshots WHERE snapshot_key='day:2026-11-10'").fetch_one(&pool).await?;
        assert_eq!(
            serde_json::from_str::<Value>(&raw)?["positions"][0]["price"],
            2.0
        );
        save(&pool, &observation("2026-11-11", 2.1, 101.0)?).await?;
        assert_eq!(history(&pool).await?["calibrations"], json!([]));
        save(&pool, &observation("2026-11-17", 2.5, 110.0)?).await?;
        let history = history(&pool).await?;
        assert_eq!(history["calibrations"].as_array().map(Vec::len), Some(1));
        assert_eq!(history["calibrations"][0]["originKey"], "day:2026-11-10");
        assert_eq!(history["calibrations"][0]["eligibleCount"], 1);
        Ok(())
    }
    #[test]
    fn comparison_uses_origin_parameters_and_excludes_unknown_times_and_closed_positions()
    -> anyhow::Result<()> {
        let before = observation("2026-11-10", 2.0, 100.0)?;
        let mut after = observation("2026-11-17", 2.5, 110.0)?;
        let first = compare("day:2026-11-10", &before, "day:2026-11-17", &after)?;
        after["risk"]["models"][0]["volatility"] = json!(2.5);
        after["positions"][0]["quantity"] = json!(50);
        let second = compare("day:2026-11-10", &before, "day:2026-11-17", &after)?;
        assert_eq!(
            first["rows"][0]["conditionalPrice"],
            second["rows"][0]["conditionalPrice"]
        );
        assert_eq!(second["rows"][0]["quantityChanged"], true);
        assert_eq!(second["rows"][0]["actualChangePct"], 25.0);
        after["positions"][0]["marketAsOf"] = Value::Null;
        let unknown = compare("a", &before, "b", &after)?;
        assert_eq!(unknown["eligibleCount"], 0);
        assert!(unknown["meanAbsoluteErrorPct"].is_null());
        assert_eq!(unknown["rows"][0]["reason"], "market_time_unknown");
        after["positions"] = json!([]);
        after["risk"]["models"] = json!([]);
        let closed = compare("a", &before, "b", &after)?;
        assert!(closed["rows"][0]["actualPrice"].is_null());
        assert_eq!(closed["rows"][0]["reason"], "position_closed_or_missing");
        Ok(())
    }
    #[test]
    fn unchanged_or_future_market_quotes_are_not_model_observations() -> anyhow::Result<()> {
        let before = observation("2026-11-10", 2.0, 100.0)?;
        let mut after = observation("2026-11-17", 2.5, 110.0)?;
        after["positions"][0]["marketAsOf"] = before["positions"][0]["marketAsOf"].clone();
        assert_eq!(
            compare("a", &before, "b", &after)?["rows"][0]["reason"],
            "quote_not_advanced"
        );
        after["positions"][0]["marketAsOf"] = json!("2026-11-18T21:00:00Z");
        assert_eq!(
            compare("a", &before, "b", &after)?["rows"][0]["reason"],
            "future_market_time"
        );
        Ok(())
    }

    #[test]
    fn old_model_versions_do_not_get_replayed_with_new_code() -> anyhow::Result<()> {
        let mut origin = observation("2026-11-10", 2.0, 100.0)?;
        origin["risk"]["modelVersion"] = json!("old-model");
        origin["risk"]["models"] = json!("different schema");
        let result = compare("a", &origin, "b", &observation("2026-11-17", 2.5, 110.0)?)?;
        assert_eq!(result["reason"], "model_version_changed");
        assert_eq!(result["eligibleCount"], 0);
        Ok(())
    }

    #[tokio::test]
    async fn retention_keeps_open_alert_evidence_but_prunes_unreferenced_old_days()
    -> anyhow::Result<()> {
        use crate::services::monitor_alerts::{self, SettingsRecord};
        let pool = pool().await?;
        let mut p = observation("2026-11-10", 2.0, 100.0)?;
        p["positions"][0]["issues"] = json!(["underlying_missing"]);
        save(&pool, &p).await?;
        let mut tx = pool.begin().await?;
        monitor_alerts::evaluate(
            &mut tx,
            &p,
            &SettingsRecord {
                revision: 0,
                settings: RiskSettings::default(),
            },
        )
        .await?;
        prune(&mut tx, "2029-11-10T21:15:00Z".parse()?, 730).await?;
        tx.commit().await?;
        let keys: Vec<String> =
            sqlx::query_scalar("SELECT snapshot_key FROM portfolio_monitor_snapshots")
                .fetch_all(&pool)
                .await?;
        assert_eq!(keys.len(), 1);
        assert!(keys[0].starts_with("event:"));
        assert_eq!(monitor_alerts::list(&pool).await?[0]["status"], "active");
        Ok(())
    }

    /// A snapshot as production records it: Frankfurt quote, capture time only.
    fn captured(day: &str, price: f64, spot: f64, capture: &str) -> anyhow::Result<Value> {
        let mut p = observation(day, price, spot)?;
        p["positions"][0]["marketAsOf"] = Value::Null;
        p["positions"][0]["valuationSource"] = json!("boerse_frankfurt");
        p["positions"][0]["fetchedAt"] = json!(format!("{day}T{capture}Z"));
        Ok(p)
    }

    #[test]
    fn quotes_without_market_time_give_indicative_samples_when_captured_near_the_close()
    -> anyhow::Result<()> {
        let before = captured("2026-11-10", 2.0, 100.0, "20:30:00")?;
        let after = captured("2026-11-17", 2.5, 110.0, "20:40:00")?;
        let result = compare("a", &before, "b", &after)?;
        let row = &result["rows"][0];
        assert_eq!(row["reason"], "market_time_unknown");
        assert_eq!(row["reasons"], json!(["market_time_unknown"]));
        assert_eq!(
            (&row["eligible"], &row["indicative"]),
            (&json!(false), &json!(true))
        );
        // Reliable figures stay empty; the indicative ones carry the same error.
        assert_eq!(result["eligibleCount"], 0);
        assert!(result["meanAbsoluteErrorPct"].is_null());
        assert_eq!(result["indicativeCount"], 1);
        let error = number(&row["modelErrorPct"]).ok_or_else(|| anyhow::anyhow!("no error"))?;
        assert_eq!(result["indicativeMeanErrorPct"], error);
        assert_eq!(result["indicativeMeanAbsoluteErrorPct"], error.abs());
        assert_eq!(
            result["indicativeByProductType"]["optionsschein"]["count"],
            1
        );

        // A statement upload has no capture anchor, and neither has a capture far from the close.
        let mut uploaded = after.clone();
        uploaded["positions"][0]["valuationSource"] = json!("pdf");
        let far = captured("2026-11-17", 2.5, 110.0, "14:00:00")?;
        for target in [&uploaded, &far] {
            let result = compare("a", &before, "b", target)?;
            assert_eq!(result["rows"][0]["indicative"], false);
            assert_eq!(
                result["rows"][0]["reasons"],
                json!(["market_time_unknown", "capture_time_unusable"])
            );
            assert_eq!(result["indicativeCount"], 0);
            assert!(result["indicativeMeanAbsoluteErrorPct"].is_null());
        }

        // A reason that voids the comparison is not softened by a good capture time.
        let mut changed = after.clone();
        changed["risk"]["models"][0]["ratio"] = json!(0.5);
        let result = compare("a", &before, "b", &changed)?;
        assert_eq!(result["rows"][0]["reason"], "contract_changed");
        assert_eq!(result["rows"][0]["indicative"], false);
        Ok(())
    }

    #[test]
    fn known_market_times_keep_reliable_samples_apart_from_indicative_ones() -> anyhow::Result<()> {
        let before = observation("2026-11-10", 2.0, 100.0)?;
        let after = observation("2026-11-17", 2.5, 110.0)?;
        let reliable = compare("a", &before, "b", &after)?;
        assert_eq!(
            (&reliable["eligibleCount"], &reliable["indicativeCount"]),
            (&json!(1), &json!(0))
        );
        assert_eq!(reliable["rows"][0]["reasons"], json!([]));
        assert_eq!(
            reliable["meanErrorPct"],
            reliable["rows"][0]["modelErrorPct"]
        );

        // Provider volatility without a timestamp is uncertain, not void.
        let mut provider = before.clone();
        provider["risk"]["models"][0]["method"] = json!("bs_iv");
        let result = compare("a", &provider, "b", &after)?;
        assert_eq!(result["rows"][0]["reason"], "greeks_time_unknown");
        assert_eq!(
            (&result["eligibleCount"], &result["indicativeCount"]),
            (&json!(0), &json!(1))
        );
        Ok(())
    }
}
