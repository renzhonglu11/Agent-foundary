use crate::{api::error::ApiError, app_state::AppState};
use axum::{
    Json,
    extract::{Path, State},
};
use serde_json::Value;
use std::sync::Arc;

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
