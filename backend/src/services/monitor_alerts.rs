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
}

struct Candidate {
    rule: &'static str,
    subject: String,
    title: String,
    value: Option<f64>,
    threshold: f64,
    low: bool,
    data: bool,
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
        .filter(|row| row["issues"].as_array().is_some_and(|v| !v.is_empty()))
        .count();
    let mut cs = vec![Candidate {
        rule: "data_quality",
        subject: "portfolio".into(),
        title: "持仓数据存在缺失、过期或时间未知".into(),
        value: Some(issues as f64),
        threshold: 1.0,
        low: false,
        data: true,
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
        });
    }
    if let Some(threshold) = config.max_loss_eur {
        // An incomplete model cannot establish a portfolio-wide pass or recovery.
        let complete = risk["excluded"].as_array().is_some_and(Vec::is_empty);
        cs.push(Candidate {
            rule: "stress_loss",
            subject: "portfolio".into(),
            title: "最差情景损失超限（EUR）".into(),
            value: if complete {
                number(&risk["worstPnl"]).map(|v| (-v).max(0.0))
            } else {
                None
            },
            threshold,
            low: false,
            data: false,
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
            return Some("triggered");
        }
        if state.status != "resolved" {
            state.status = "pending".into();
        }
    } else {
        state.hits = 0;
        if clear && counted {
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

/// Whether an alert evaluated at `now` still needs another observation soon:
/// a second breach, a second recovery, or the end of a cooldown. The
/// confirmation counters restart after three minutes without an evaluation.
pub async fn awaiting_confirmation(
    conn: &mut SqliteConnection,
    now: DateTime<Utc>,
) -> anyhow::Result<bool> {
    Ok(sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM portfolio_monitor_alerts WHERE updated_at = ? AND (
            json_extract(state_json,'$.status') = 'pending'
            OR (json_extract(state_json,'$.status') = 'resolved' AND json_extract(state_json,'$.hits') > 0)
            OR (json_extract(state_json,'$.status') IN ('active','acknowledged','invalidated') AND json_extract(state_json,'$.clears') = 1)))",
    )
    .bind(now.to_rfc3339())
    .fetch_one(conn)
    .await?)
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
    async fn unfinished_confirmations_ask_for_the_next_cycle() -> anyhow::Result<()> {
        let pool = pool().await?;
        let t: DateTime<Utc> = "2026-11-10T12:00:00Z".parse()?;
        let config = SettingsRecord {
            revision: 0,
            settings: RiskSettings {
                max_loss_eur: Some(100.0),
                ..Default::default()
            },
        };
        // Minute, loss, and whether the alert is left waiting for another observation.
        for (minute, loss, expected) in [
            (0, 120.0, true),   // first breach, pending
            (1, 120.0, false),  // confirmed, active
            (2, 80.0, true),    // first recovery
            (3, 80.0, false),   // resolved
            (4, 120.0, true),   // breached again inside the cooldown
            (5, 120.0, true),   // still cooling
            (20, 120.0, true),  // the long gap restarted the count
            (21, 120.0, false), // active again
        ] {
            let at = t + TimeDelta::minutes(minute);
            let mut tx = pool.begin().await?;
            evaluate(&mut tx, &payload(at, Some(loss)), &config).await?;
            let awaiting = awaiting_confirmation(&mut tx, at).await?;
            tx.commit().await?;
            assert_eq!(awaiting, expected, "minute {minute}");
        }
        assert_eq!(state(&pool).await?.status, "active");
        Ok(())
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
    #[tokio::test]
    async fn partial_model_never_resolves_a_portfolio_loss_alert() -> anyhow::Result<()> {
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
        cycle(&pool, t + TimeDelta::minutes(1), Some(120.0), &config).await?;
        let mut p = payload(t + TimeDelta::minutes(2), Some(0.0));
        p["risk"]["excluded"] = json!([{"id":"unknown"}]);
        let mut tx = pool.begin().await?;
        evaluate(&mut tx, &p, &config).await?;
        tx.commit().await?;
        assert_eq!(state(&pool).await?.status, "invalidated");
        cycle(&pool, t + TimeDelta::minutes(3), Some(0.0), &config).await?;
        cycle(&pool, t + TimeDelta::minutes(4), Some(0.0), &config).await?;
        assert_eq!(state(&pool).await?.status, "resolved");
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
