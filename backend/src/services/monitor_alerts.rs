//! Persistent application-only alerts. Acknowledgement is not recovery.
use chrono::{DateTime, TimeDelta, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{SqliteConnection, SqlitePool};

use super::monitor_risk::{MODEL_VERSION, RiskSettings, expiry_days, number, timestamp};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsRecord {
    pub revision: i64,
    pub settings: RiskSettings,
}

pub async fn settings(pool: &SqlitePool) -> anyhow::Result<SettingsRecord> {
    let row: Option<(i64, String)> = sqlx::query_as(
        "SELECT revision,settings_json FROM portfolio_monitor_settings WHERE singleton=1",
    )
    .fetch_optional(pool)
    .await?;
    match row {
        Some((revision, raw)) => Ok(SettingsRecord {
            revision,
            settings: serde_json::from_str(&raw)?,
        }),
        None => Ok(SettingsRecord {
            revision: 0,
            settings: RiskSettings::default(),
        }),
    }
}

pub async fn save_settings(pool: &SqlitePool, record: &SettingsRecord) -> anyhow::Result<bool> {
    if record.revision == 0 {
        return Ok(sqlx::query("INSERT INTO portfolio_monitor_settings(singleton,revision,updated_at,settings_json) VALUES(1,1,?,?) ON CONFLICT(singleton) DO NOTHING")
            .bind(Utc::now().to_rfc3339()).bind(serde_json::to_string(&record.settings)?).execute(pool).await?.rows_affected()==1);
    }
    if record.revision > 0 {
        return Ok(sqlx::query("UPDATE portfolio_monitor_settings SET revision=revision+1,updated_at=?,settings_json=? WHERE singleton=1 AND revision=?")
            .bind(Utc::now().to_rfc3339()).bind(serde_json::to_string(&record.settings)?).bind(record.revision).execute(pool).await?.rows_affected() == 1);
    }
    Ok(false)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlertState {
    pub key: String,
    pub rule: String,
    pub subject: String,
    pub title: String,
    pub category: String,
    pub status: String,
    pub revision: i64,
    pub first_triggered_at: Option<DateTime<Utc>>,
    pub last_triggered_at: Option<DateTime<Utc>>,
    pub acknowledged_at: Option<DateTime<Utc>>,
    pub resolved_at: Option<DateTime<Utc>>,
    pub invalidated_at: Option<DateTime<Utc>>,
    pub last_evaluated_at: Option<DateTime<Utc>>,
    pub hits: u32,
    pub clears: u32,
    pub value: Option<f64>,
    pub threshold: f64,
    pub reason: String,
    pub evidence_key: Option<String>,
    /// The value covers only the modeled holdings; some positions are left out.
    #[serde(default)]
    pub partial: bool,
    /// Holdings that were in the model when the alert fired.
    #[serde(default)]
    pub modeled_at_trigger: Option<Vec<String>>,
}

/// Which holdings a portfolio-wide value was computed from.
struct ModelScope {
    modeled: Vec<String>,
    excluded: Vec<String>,
}

struct Candidate {
    rule: &'static str,
    subject: String,
    title: String,
    value: Option<f64>,
    threshold: f64,
    low: bool,
    data: bool,
    scope: Option<ModelScope>,
}

/// Standing limits of the data sources, present on most positions every cycle:
/// the valuation and Greeks carry no market time, an underlying has no mapped
/// quote, or the product is not quoted in EUR. They lower confidence and model
/// coverage, which have their own displays and rule, but they are not faults
/// that appear and clear, so they do not raise the data-quality alert.
const KNOWN_DATA_LIMITATIONS: [&str; 4] = [
    "valuation_market_time_unknown",
    "greeks_market_time_unknown",
    "underlying_unmapped",
    "product_currency_unsupported",
];

fn ids(rows: &Value) -> Vec<String> {
    rows.as_array()
        .into_iter()
        .flatten()
        .filter_map(|row| row["id"].as_str().map(str::to_owned))
        .collect()
}

fn candidates(payload: &Value, config: &RiskSettings) -> Vec<Candidate> {
    let risk = &payload["risk"];
    let rows: Vec<_> = payload["positions"]
        .as_array()
        .into_iter()
        .flatten()
        .collect();
    let issues = rows
        .iter()
        .filter(|row| {
            row["issues"].as_array().is_some_and(|issues| {
                issues.iter().any(|issue| {
                    issue
                        .as_str()
                        .is_none_or(|code| !KNOWN_DATA_LIMITATIONS.contains(&code))
                })
            })
        })
        .count();
    let mut cs = vec![Candidate {
        rule: "data_quality",
        subject: "portfolio".into(),
        title: "持仓数据出现缺失、过期或时间错位".into(),
        value: Some(issues as f64),
        threshold: 1.0,
        low: false,
        data: true,
        scope: None,
    }];
    if let Some(threshold) = config.min_model_coverage_pct {
        cs.push(Candidate {
            rule: "coverage",
            subject: "portfolio".into(),
            title: "模型覆盖率低于设置值".into(),
            value: number(&risk["coveragePct"]),
            threshold,
            low: true,
            data: true,
            scope: None,
        });
    }
    if let Some(threshold) = config.max_loss_eur {
        // Funds, bonds and products without terms are never modeled, so waiting
        // for a complete model would mean this limit never fires. The modeled
        // holdings alone can exceed it; the alert says that it covers only them,
        // and `advance` refuses a recovery caused by a holding leaving the model.
        let scope = ModelScope {
            modeled: ids(&risk["models"]),
            excluded: ids(&risk["excluded"]),
        };
        cs.push(Candidate {
            rule: "stress_loss",
            subject: "portfolio".into(),
            title: if scope.excluded.is_empty() {
                "最差情景损失超限（EUR）"
            } else {
                "已建模持仓的最差情景损失超限（EUR）"
            }
            .into(),
            value: number(&risk["worstPnl"]).map(|v| (-v).max(0.0)),
            threshold,
            low: false,
            data: false,
            scope: Some(scope),
        });
    }
    if let Some(threshold) = config.max_concentration_pct {
        for group in risk["concentrations"].as_array().into_iter().flatten() {
            cs.push(Candidate {
                rule: "concentration",
                subject: group["group"].as_str().unwrap_or("unknown").into(),
                title: "标的持仓市值集中度超限".into(),
                value: number(&group["pct"]),
                threshold,
                low: false,
                data: false,
                scope: None,
            });
        }
    }
    for row in rows {
        let id = row["symbol"].as_str().unwrap_or("");
        let metric = risk["metrics"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|m| m["id"] == id)
            .unwrap_or(&Value::Null);
        for (rule, title, field, threshold, low) in [
            (
                "knockout_7d",
                "7 天内敲出模型概率超限",
                "knockout7dPct",
                config.max_knockout_7d_pct,
                false,
            ),
            (
                "decay_7d",
                "横盘 7 天模型损耗超限",
                "decay7dPct",
                config.max_decay_7d_pct,
                false,
            ),
            (
                "expiry",
                "到期窗口提醒",
                "daysToExpiry",
                config.expiry_warning_days,
                true,
            ),
        ] {
            if let Some(threshold) = threshold {
                let value = number(&metric[field]).or_else(|| {
                    if rule != "expiry" {
                        return None;
                    }
                    let item = payload["inputs"]["enrichment"]["items"]
                        .as_array()?
                        .iter()
                        .find(|i| i["isin"] == id)?;
                    expiry_days(item, timestamp(&payload["evaluatedAt"])?)
                });
                cs.push(Candidate {
                    rule,
                    subject: id.into(),
                    title: format!("{} · {}", row["name"].as_str().unwrap_or(id), title),
                    value,
                    threshold,
                    low,
                    data: false,
                    scope: None,
                });
            }
        }
    }
    cs
}

fn advance(state: &mut AlertState, c: &Candidate, now: DateTime<Utc>) -> Option<&'static str> {
    if state.last_evaluated_at.is_some_and(|last| now <= last) {
        return None;
    }
    let counted = state
        .last_evaluated_at
        .is_none_or(|last| now - last >= TimeDelta::seconds(45));
    if state
        .last_evaluated_at
        .is_some_and(|last| now - last > TimeDelta::minutes(3))
    {
        state.hits = 0;
        state.clears = 0;
    }
    state.last_evaluated_at = Some(now);
    state.value = c.value;
    state.title.clone_from(&c.title);
    state.partial = c
        .scope
        .as_ref()
        .is_some_and(|scope| !scope.excluded.is_empty());
    // A holding that was modeled when the alert fired and is now left out makes
    // the loss look smaller without any risk having gone away.
    let model_shrank = c.scope.as_ref().is_some_and(|scope| {
        state
            .modeled_at_trigger
            .iter()
            .flatten()
            .any(|id| scope.excluded.contains(id))
    });
    let active = matches!(state.status.as_str(), "active" | "acknowledged");
    let Some(value) = c.value else {
        state.hits = 0;
        state.clears = 0;
        if active || state.status == "pending" {
            state.status = "invalidated".into();
            state.invalidated_at = Some(now);
            state.reason = "inputs_unavailable".into();
            return Some("invalidated");
        }
        return None;
    };
    let breached = if c.rule == "coverage" {
        value < c.threshold
    } else if c.low {
        value <= c.threshold
    } else {
        value >= c.threshold
    };
    // 10% hysteresis; zero thresholds still require strict improvement.
    let clear = if c.low {
        // 100% coverage is attainable; a 110% recovery target is not.
        value
            >= (c.threshold + c.threshold.abs() * 0.1).min(if c.rule == "coverage" {
                100.0
            } else {
                f64::MAX
            })
            && !breached
    } else {
        value < c.threshold * 0.9
    };
    if breached {
        state.clears = 0;
        if counted {
            state.hits = state.hits.saturating_add(1);
        }
        if active {
            state.last_triggered_at = Some(now);
            state.reason = "threshold_breached".into();
            return None;
        }
        let immediate = c.data || (c.rule == "knockout_7d" && value >= 100.0);
        let cooling = !immediate
            && state
                .resolved_at
                .is_some_and(|time| now - time < TimeDelta::minutes(15));
        if state.hits >= if immediate { 1 } else { 2 } && !cooling {
            state.status = "active".into();
            state.first_triggered_at = Some(now);
            state.last_triggered_at = Some(now);
            state.acknowledged_at = None;
            state.resolved_at = None;
            state.invalidated_at = None;
            state.reason = "threshold_breached".into();
            state.modeled_at_trigger = c.scope.as_ref().map(|scope| scope.modeled.clone());
            return Some("triggered");
        }
        if state.status != "resolved" {
            state.status = "pending".into();
        }
    } else {
        state.hits = 0;
        if model_shrank {
            state.clears = 0;
            if active {
                state.reason = "recovery_blocked_model_shrank".into();
            }
        } else if clear && counted {
            state.clears = state.clears.saturating_add(1);
        } else if !clear {
            state.clears = 0;
        }
        if (active || (state.status == "invalidated" && state.first_triggered_at.is_some()))
            && state.clears >= 2
        {
            state.status = "resolved".into();
            state.resolved_at = Some(now);
            state.reason = "threshold_recovered".into();
            return Some("resolved");
        }
        if state.status == "pending" {
            state.status = "idle".into();
        }
    }
    None
}

async fn store_state(
    conn: &mut SqliteConnection,
    state: &AlertState,
    now: DateTime<Utc>,
) -> anyhow::Result<()> {
    sqlx::query("INSERT INTO portfolio_monitor_alerts(alert_key,updated_at,state_json) VALUES(?,?,?) ON CONFLICT(alert_key) DO UPDATE SET updated_at=excluded.updated_at,state_json=excluded.state_json")
        .bind(&state.key).bind(now.to_rfc3339()).bind(serde_json::to_string(state)?).execute(conn).await?;
    Ok(())
}

async fn event(
    conn: &mut SqliteConnection,
    state: &AlertState,
    kind: &str,
    now: DateTime<Utc>,
) -> anyhow::Result<()> {
    sqlx::query("INSERT INTO portfolio_monitor_alert_events(alert_key,happened_at,snapshot_key,event_json) VALUES(?,?,?,?)")
        .bind(&state.key).bind(now.to_rfc3339()).bind(&state.evidence_key)
        .bind(serde_json::to_string(&json!({"event":kind,"happenedAt":now,"modelVersion":MODEL_VERSION,"state":state}))?).execute(conn).await?;
    Ok(())
}

pub async fn evaluate(
    conn: &mut SqliteConnection,
    payload: &Value,
    config: &SettingsRecord,
) -> anyhow::Result<()> {
    let now = timestamp(&payload["evaluatedAt"])
        .ok_or_else(|| anyhow::anyhow!("snapshot lacks evaluation time"))?;
    let evidence = format!("event:{}", now.to_rfc3339());
    let raw: Vec<String> = sqlx::query_scalar("SELECT state_json FROM portfolio_monitor_alerts")
        .fetch_all(&mut *conn)
        .await?;
    let mut states: std::collections::BTreeMap<String, AlertState> = raw
        .into_iter()
        .map(|raw| serde_json::from_str::<AlertState>(&raw).map(|s| (s.key.clone(), s)))
        .collect::<Result<_, _>>()?;
    let mut wrote_evidence = false;
    for c in candidates(payload, &config.settings) {
        let key = format!("{}:{}:{}", config.revision, c.rule, c.subject);
        let mut state = states.remove(&key).unwrap_or(AlertState {
            key,
            rule: c.rule.into(),
            subject: c.subject.clone(),
            title: c.title.clone(),
            category: if c.data { "data" } else { "risk" }.into(),
            status: "idle".into(),
            revision: config.revision,
            first_triggered_at: None,
            last_triggered_at: None,
            acknowledged_at: None,
            resolved_at: None,
            invalidated_at: None,
            last_evaluated_at: None,
            hits: 0,
            clears: 0,
            value: None,
            threshold: c.threshold,
            reason: String::new(),
            evidence_key: None,
            partial: false,
            modeled_at_trigger: None,
        });
        if let Some(kind) = advance(&mut state, &c, now) {
            state.evidence_key = Some(evidence.clone());
            event(conn, &state, kind, now).await?;
            wrote_evidence = true;
        }
        store_state(conn, &state, now).await?;
    }
    for (_, mut state) in states {
        if matches!(state.status.as_str(), "active" | "acknowledged" | "pending") {
            let configured = state.revision == config.revision;
            state.status = if configured {
                "resolved"
            } else {
                "invalidated"
            }
            .into();
            state.reason = if configured {
                "position_closed"
            } else {
                "configuration_changed"
            }
            .into();
            if configured {
                state.resolved_at = Some(now);
            } else {
                state.invalidated_at = Some(now);
            }
            state.evidence_key = Some(evidence.clone());
            state.last_evaluated_at = Some(now);
            event(conn, &state, &state.status, now).await?;
            store_state(conn, &state, now).await?;
            wrote_evidence = true;
        }
    }
    if wrote_evidence {
        sqlx::query("INSERT INTO portfolio_monitor_snapshots(snapshot_key,captured_at,payload_json) VALUES(?,?,?) ON CONFLICT(snapshot_key) DO NOTHING")
            .bind(evidence).bind(now.to_rfc3339()).bind(serde_json::to_string(payload)?).execute(conn).await?;
    }
    Ok(())
}

pub async fn list(pool: &SqlitePool) -> anyhow::Result<Value> {
    let rows: Vec<String> = sqlx::query_scalar(
        "SELECT state_json FROM portfolio_monitor_alerts ORDER BY updated_at DESC",
    )
    .fetch_all(pool)
    .await?;
    let states = rows
        .into_iter()
        .map(|s| serde_json::from_str::<AlertState>(&s))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(json!(
        states
            .into_iter()
            .filter(|s| s.first_triggered_at.is_some() || s.status == "pending")
            .collect::<Vec<_>>()
    ))
}

pub async fn events(pool: &SqlitePool, key: &str) -> anyhow::Result<Value> {
    let rows: Vec<String> = sqlx::query_scalar("SELECT event_json FROM portfolio_monitor_alert_events WHERE alert_key=? ORDER BY id DESC LIMIT 100").bind(key).fetch_all(pool).await?;
    Ok(json!(
        rows.into_iter()
            .map(|s| serde_json::from_str::<Value>(&s))
            .collect::<Result<Vec<_>, _>>()?
    ))
}

pub async fn acknowledge(pool: &SqlitePool, key: &str) -> anyhow::Result<bool> {
    let mut tx = pool.begin().await?;
    let raw: Option<String> =
        sqlx::query_scalar("SELECT state_json FROM portfolio_monitor_alerts WHERE alert_key=?")
            .bind(key)
            .fetch_optional(&mut *tx)
            .await?;
    let Some(raw) = raw else { return Ok(false) };
    let mut state: AlertState = serde_json::from_str(&raw)?;
    if state.status == "acknowledged" {
        return Ok(true);
    }
    if state.status != "active" {
        return Ok(false);
    }
    let now = Utc::now();
    state.status = "acknowledged".into();
    state.acknowledged_at = Some(now);
    event(&mut tx, &state, "acknowledged", now).await?;
    store_state(&mut tx, &state, now).await?;
    tx.commit().await?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::infrastructure::db::migrations::run_migrations;

    async fn pool() -> anyhow::Result<SqlitePool> {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await?;
        run_migrations(&pool).await?;
        Ok(pool)
    }
    fn payload(at: DateTime<Utc>, loss: Option<f64>) -> Value {
        json!({"evaluatedAt":at,"positions":[],"risk":{"worstPnl":loss.map(|v|-v),"excluded":[],"coveragePct":100}})
    }
    async fn cycle(
        pool: &SqlitePool,
        at: DateTime<Utc>,
        loss: Option<f64>,
        config: &SettingsRecord,
    ) -> anyhow::Result<()> {
        let mut tx = pool.begin().await?;
        evaluate(&mut tx, &payload(at, loss), config).await?;
        tx.commit().await?;
        Ok(())
    }
    async fn state(pool: &SqlitePool) -> anyhow::Result<AlertState> {
        let raw:String=sqlx::query_scalar("SELECT state_json FROM portfolio_monitor_alerts WHERE alert_key='0:stress_loss:portfolio'").fetch_one(pool).await?;
        Ok(serde_json::from_str(&raw)?)
    }
    #[tokio::test]
    async fn settings_survive_reopen_and_stale_updates_cannot_overwrite() -> anyhow::Result<()> {
        let dir = tempfile::tempdir()?;
        let url = format!(
            "sqlite://{}?mode=rwc",
            dir.path().join("settings.db").display()
        );
        let pool = SqlitePool::connect(&url).await?;
        run_migrations(&pool).await?;
        let mut config = settings(&pool).await?;
        config.settings.max_loss_eur = Some(500.0);
        assert!(save_settings(&pool, &config).await?);
        assert!(!save_settings(&pool, &config).await?);
        pool.close().await;
        let pool = SqlitePool::connect(&url).await?;
        config = settings(&pool).await?;
        assert_eq!(config.revision, 1);
        assert_eq!(config.settings.max_loss_eur, Some(500.0));
        config.settings.max_loss_eur = Some(250.0);
        assert!(save_settings(&pool, &config).await?);
        assert_eq!(settings(&pool).await?.revision, 2);
        Ok(())
    }
    #[tokio::test]
    async fn alert_debounce_acknowledgement_hysteresis_cooldown_and_invalidation()
    -> anyhow::Result<()> {
        let pool = pool().await?;
        let t: DateTime<Utc> = "2026-11-10T12:00:00Z".parse()?;
        let config = SettingsRecord {
            revision: 0,
            settings: RiskSettings {
                max_loss_eur: Some(100.0),
                ..Default::default()
            },
        };
        cycle(&pool, t, Some(120.0), &config).await?;
        assert_eq!(state(&pool).await?.status, "pending");
        cycle(&pool, t, Some(120.0), &config).await?;
        assert_eq!(state(&pool).await?.hits, 1);
        cycle(&pool, t + TimeDelta::minutes(1), Some(120.0), &config).await?;
        assert_eq!(state(&pool).await?.status, "active");
        assert!(acknowledge(&pool, "0:stress_loss:portfolio").await?);
        cycle(&pool, t + TimeDelta::minutes(2), Some(110.0), &config).await?;
        assert_eq!(state(&pool).await?.status, "acknowledged");
        cycle(&pool, t + TimeDelta::minutes(3), Some(95.0), &config).await?;
        assert_eq!(state(&pool).await?.status, "acknowledged");
        cycle(&pool, t + TimeDelta::minutes(4), Some(80.0), &config).await?;
        cycle(&pool, t + TimeDelta::minutes(5), Some(80.0), &config).await?;
        assert_eq!(state(&pool).await?.status, "resolved");
        cycle(&pool, t + TimeDelta::minutes(6), Some(120.0), &config).await?;
        cycle(&pool, t + TimeDelta::minutes(7), Some(120.0), &config).await?;
        assert_eq!(state(&pool).await?.status, "resolved");
        cycle(&pool, t + TimeDelta::minutes(21), Some(120.0), &config).await?;
        assert_eq!(state(&pool).await?.status, "resolved"); // A long gap resets consecutive observations.
        cycle(&pool, t + TimeDelta::minutes(22), Some(120.0), &config).await?;
        assert_eq!(state(&pool).await?.status, "active");
        assert!(state(&pool).await?.acknowledged_at.is_none());
        cycle(&pool, t + TimeDelta::minutes(23), None, &config).await?;
        assert_eq!(state(&pool).await?.status, "invalidated");
        let events = events(&pool, "0:stress_loss:portfolio").await?;
        assert_eq!(events.as_array().map(Vec::len), Some(5));
        let key = events[0]["state"]["evidenceKey"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("missing evidence"))?;
        let raw: String = sqlx::query_scalar(
            "SELECT payload_json FROM portfolio_monitor_snapshots WHERE snapshot_key=?",
        )
        .bind(key)
        .fetch_one(&pool)
        .await?;
        assert!(serde_json::from_str::<Value>(&raw)?["risk"]["worstPnl"].is_null());
        Ok(())
    }
    #[tokio::test]
    async fn config_changes_invalidate_and_data_issues_trigger_immediately() -> anyhow::Result<()> {
        let pool = pool().await?;
        let t: DateTime<Utc> = "2026-11-10T12:00:00Z".parse()?;
        let mut tx = pool.begin().await?;
        let config = SettingsRecord {
            revision: 0,
            settings: RiskSettings::default(),
        };
        evaluate(
            &mut tx,
            &json!({"evaluatedAt":t,"positions":[{"symbol":"X","issues":["underlying_missing"]}]}),
            &config,
        )
        .await?;
        tx.commit().await?;
        assert_eq!(list(&pool).await?[0]["status"], "active");
        let config = SettingsRecord {
            revision: 1,
            ..config
        };
        cycle(&pool, t + TimeDelta::minutes(1), None, &config).await?;
        let list = list(&pool).await?;
        assert!(
            list.as_array()
                .into_iter()
                .flatten()
                .any(|s| s["reason"] == "configuration_changed")
        );
        Ok(())
    }
    fn partial_payload(at: DateTime<Utc>, loss: f64, modeled: &[&str], excluded: &[&str]) -> Value {
        let rows = |ids: &[&str]| ids.iter().map(|id| json!({"id":id})).collect::<Vec<_>>();
        let mut p = payload(at, Some(loss));
        p["risk"]["models"] = json!(rows(modeled));
        p["risk"]["excluded"] = json!(rows(excluded));
        p
    }
    async fn run(pool: &SqlitePool, p: &Value, config: &SettingsRecord) -> anyhow::Result<()> {
        let mut tx = pool.begin().await?;
        evaluate(&mut tx, p, config).await?;
        tx.commit().await?;
        Ok(())
    }
    fn loss_limit(limit: f64) -> SettingsRecord {
        SettingsRecord {
            revision: 0,
            settings: RiskSettings {
                max_loss_eur: Some(limit),
                ..Default::default()
            },
        }
    }

    #[tokio::test]
    async fn modeled_holdings_alone_trigger_and_recover_the_loss_limit() -> anyhow::Result<()> {
        let pool = pool().await?;
        let t: DateTime<Utc> = "2026-11-10T12:00:00Z".parse()?;
        let config = loss_limit(100.0);
        // A fund is never modeled; the warrant alone loses more than the limit.
        for minute in [0, 1] {
            let p = partial_payload(
                t + TimeDelta::minutes(minute),
                120.0,
                &["WARRANT"],
                &["FUND"],
            );
            run(&pool, &p, &config).await?;
        }
        let fired = state(&pool).await?;
        assert_eq!(fired.status, "active");
        assert!(fired.partial);
        assert_eq!(fired.title, "已建模持仓的最差情景损失超限（EUR）");
        assert_eq!(fired.modeled_at_trigger, Some(vec!["WARRANT".to_owned()]));

        // The warrant is trimmed and a second fund is bought: still partial, the
        // same holdings are modeled, and the loss is back inside the buffer.
        for minute in [2, 3] {
            let p = partial_payload(
                t + TimeDelta::minutes(minute),
                50.0,
                &["WARRANT"],
                &["FUND", "FUND2"],
            );
            run(&pool, &p, &config).await?;
        }
        let recovered = state(&pool).await?;
        assert_eq!(recovered.status, "resolved");
        assert!(recovered.partial);
        Ok(())
    }

    #[tokio::test]
    async fn a_holding_leaving_the_model_cannot_resolve_a_loss_alert() -> anyhow::Result<()> {
        let pool = pool().await?;
        let t: DateTime<Utc> = "2026-11-10T12:00:00Z".parse()?;
        let config = loss_limit(100.0);
        for minute in [0, 1] {
            let p = partial_payload(t + TimeDelta::minutes(minute), 120.0, &["A", "B"], &[]);
            run(&pool, &p, &config).await?;
        }
        assert_eq!(state(&pool).await?.status, "active");

        // B loses its quote and drops out, so the modeled loss falls to zero.
        for minute in [2, 3, 4] {
            let p = partial_payload(t + TimeDelta::minutes(minute), 0.0, &["A"], &["B"]);
            run(&pool, &p, &config).await?;
        }
        let blocked = state(&pool).await?;
        assert_eq!(blocked.status, "active");
        assert_eq!(blocked.reason, "recovery_blocked_model_shrank");
        assert_eq!(blocked.clears, 0);

        // Selling B is a real change: it is neither modeled nor left out.
        for minute in [5, 6] {
            let p = partial_payload(t + TimeDelta::minutes(minute), 0.0, &["A"], &[]);
            run(&pool, &p, &config).await?;
        }
        assert_eq!(state(&pool).await?.status, "resolved");

        // With nothing modeled at all the value is unknown, not zero.
        cycle(&pool, t + TimeDelta::minutes(30), Some(120.0), &config).await?;
        cycle(&pool, t + TimeDelta::minutes(31), Some(120.0), &config).await?;
        assert_eq!(state(&pool).await?.status, "active");
        cycle(&pool, t + TimeDelta::minutes(32), None, &config).await?;
        assert_eq!(state(&pool).await?.status, "invalidated");
        Ok(())
    }

    #[tokio::test]
    async fn standing_data_limitations_do_not_raise_the_data_quality_alert() -> anyhow::Result<()> {
        let pool = pool().await?;
        let t: DateTime<Utc> = "2026-11-10T12:00:00Z".parse()?;
        let config = SettingsRecord {
            revision: 0,
            settings: RiskSettings::default(),
        };
        let snapshot = |minute: i64, extra: &[&str]| {
            let mut issues = vec![
                "valuation_market_time_unknown",
                "greeks_market_time_unknown",
            ];
            issues.extend_from_slice(extra);
            json!({"evaluatedAt":t+TimeDelta::minutes(minute),"positions":[
                {"symbol":"X","issues":issues},
                {"symbol":"Y","issues":["underlying_unmapped","product_currency_unsupported"]},
                {"symbol":"Z","issues":[]},
            ]})
        };
        run(&pool, &snapshot(0, &[]), &config).await?;
        assert_eq!(list(&pool).await?.as_array().map(Vec::len), Some(0));

        // A stale capture on top of the standing limits is a fault.
        run(&pool, &snapshot(1, &["product_capture_stale"]), &config).await?;
        let alerts = list(&pool).await?;
        assert_eq!(alerts[0]["status"], "active");
        assert_eq!(alerts[0]["value"], 1.0);

        // It clears again once the fault is gone, although the limits remain.
        run(&pool, &snapshot(2, &[]), &config).await?;
        run(&pool, &snapshot(3, &[]), &config).await?;
        assert_eq!(list(&pool).await?[0]["status"], "resolved");
        Ok(())
    }

    #[tokio::test]
    async fn full_coverage_recovers_even_when_the_minimum_is_one_hundred_percent()
    -> anyhow::Result<()> {
        let pool = pool().await?;
        let t: DateTime<Utc> = "2026-11-10T12:00:00Z".parse()?;
        let config = SettingsRecord {
            revision: 0,
            settings: RiskSettings {
                min_model_coverage_pct: Some(100.0),
                ..Default::default()
            },
        };
        for (minute, coverage) in [(0, 40), (1, 100), (2, 100)] {
            let mut p = payload(t + TimeDelta::minutes(minute), None);
            p["risk"]["coveragePct"] = json!(coverage);
            let mut tx = pool.begin().await?;
            evaluate(&mut tx, &p, &config).await?;
            tx.commit().await?;
        }
        let alerts = list(&pool).await?;
        assert!(
            alerts
                .as_array()
                .into_iter()
                .flatten()
                .any(|a| a["rule"] == "coverage" && a["status"] == "resolved")
        );
        Ok(())
    }

    #[tokio::test]
    async fn expiry_alert_does_not_disappear_when_an_expired_product_cannot_be_priced()
    -> anyhow::Result<()> {
        let pool = pool().await?;
        let t: DateTime<Utc> = "2026-11-10T12:00:00Z".parse()?;
        let config = SettingsRecord {
            revision: 0,
            settings: RiskSettings {
                expiry_warning_days: Some(7.0),
                ..Default::default()
            },
        };
        for minute in [0, 1] {
            let p = json!({"evaluatedAt":t+TimeDelta::minutes(minute),"positions":[{"symbol":"X"}],"risk":{"models":[],"metrics":[],"excluded":[{"id":"X"}]},"inputs":{"enrichment":{"items":[{"isin":"X","expiry":"2026-11-09"}]}}});
            let mut tx = pool.begin().await?;
            evaluate(&mut tx, &p, &config).await?;
            tx.commit().await?;
        }
        let alerts = list(&pool).await?;
        assert!(
            alerts
                .as_array()
                .into_iter()
                .flatten()
                .any(|a| a["rule"] == "expiry" && a["status"] == "active" && a["value"] == 0.0)
        );
        Ok(())
    }
}
