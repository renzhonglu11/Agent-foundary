use crate::services::monitor_alerts::SettingsRecord;
use crate::{api::error::ApiError, app_state::AppState};
use axum::http::StatusCode;
use axum::{
    Json,
    extract::{Path, State},
};
use serde_json::Value;
use std::sync::Arc;

type MonitorWriteResult = Result<Json<Value>, (StatusCode, Json<Value>)>;

fn write_error(error: anyhow::Error) -> (StatusCode, Json<Value>) {
    tracing::error!(%error,"monitor write failed");
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(serde_json::json!({"error":"监控状态保存失败"})),
    )
}

pub async fn portfolio_monitor_settings(
    State(state): State<Arc<AppState>>,
    Json(record): Json<SettingsRecord>,
) -> MonitorWriteResult {
    if let Err(error) = record.settings.validate() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error":error})),
        ));
    }
    if !state
        .portfolio_monitor
        .save_settings(&record)
        .await
        .map_err(write_error)?
    {
        return Err((
            StatusCode::CONFLICT,
            Json(serde_json::json!({"error":"设置已被更新，请重新加载后保存"})),
        ));
    }
    Ok(Json(
        serde_json::json!({"revision":record.revision+1,"settings":record.settings}),
    ))
}

pub async fn portfolio_monitor_acknowledge(
    State(state): State<Arc<AppState>>,
    Path(key): Path<String>,
) -> MonitorWriteResult {
    if !state
        .portfolio_monitor
        .acknowledge(&key)
        .await
        .map_err(write_error)?
    {
        return Err((
            StatusCode::CONFLICT,
            Json(serde_json::json!({"error":"该预警不存在或已不处于触发状态"})),
        ));
    }
    Ok(Json(serde_json::json!({"acknowledged":true})))
}

pub async fn portfolio_monitor_alert_events(
    State(state): State<Arc<AppState>>,
    Path(key): Path<String>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(state.portfolio_monitor.alert_events(&key).await?))
}

pub async fn portfolio_monitor_daily(
    State(state): State<Arc<AppState>>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(state.portfolio_monitor.daily_history().await?))
}

pub async fn portfolio_monitor_status(
    State(state): State<Arc<AppState>>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(state.portfolio_monitor.status().await?))
}

pub async fn portfolio_monitor_history(
    State(state): State<Arc<AppState>>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(state.portfolio_monitor.history().await?))
}

pub async fn portfolio_monitor_snapshot(
    State(state): State<Arc<AppState>>,
    Path(key): Path<String>,
) -> Result<Json<Option<Value>>, ApiError> {
    Ok(Json(state.portfolio_monitor.snapshot(&key).await?))
}
