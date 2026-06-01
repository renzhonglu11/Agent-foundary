use std::sync::Arc;

use axum::{Json, extract::State};
use serde_json::Value;

use crate::{
    api::error::ApiError, app_state::AppState, services::structured_products_service::RefreshMode,
};

pub async fn structured_products_enrichment(State(state): State<Arc<AppState>>) -> Json<Value> {
    Json(state.structured_products_service.read_payload().await)
}

pub async fn structured_products_enrichment_status(
    State(state): State<Arc<AppState>>,
) -> Json<Value> {
    Json(state.structured_products_service.status_payload())
}

pub async fn refresh_structured_products_enrichment(
    State(state): State<Arc<AppState>>,
) -> Result<Json<Value>, ApiError> {
    let summary = state.portfolio_service.summary().await?;
    state.structured_products_service.spawn_refresh(
        summary,
        "user_requested_live_enrichment",
        RefreshMode::Live,
    );

    Ok(Json(serde_json::json!({
        "ok": true,
        "status": "started",
        "mode": "live"
    })))
}
