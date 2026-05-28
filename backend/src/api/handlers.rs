use std::sync::Arc;

use axum::{
    Json,
    extract::{Multipart, Query, State},
    http::StatusCode,
};
use serde::Deserialize;
use serde_json::Value;

use crate::{
    api::error::ApiError,
    app_state::AppState,
    application::services::upload_data_service::UploadDataResponse,
    services::{
        alpaca_market_data::AlpacaQuotesResponse, hermes_cron_status::HermesCronStatusResponse,
        structured_products_service::RefreshMode,
    },
};

#[derive(Debug, Deserialize)]
pub struct AlpacaQuotesQuery {
    pub symbols: Option<String>,
}

pub async fn portfolio_summary(
    State(state): State<Arc<AppState>>,
) -> Result<Json<crate::domain::portfolio::PortfolioSummaryResponse>, ApiError> {
    Ok(Json(state.portfolio_service.summary().await?))
}

pub async fn health() -> Json<serde_json::Value> {
    Json(serde_json::json!({ "ok": true }))
}

pub async fn hermes_cron_status(
    State(state): State<Arc<AppState>>,
) -> Json<HermesCronStatusResponse> {
    Json(state.hermes_cron_status_service.status())
}

pub async fn structured_products_enrichment(State(state): State<Arc<AppState>>) -> Json<Value> {
    Json(state.structured_products_service.read_payload().await)
}

pub async fn structured_products_enrichment_status(
    State(state): State<Arc<AppState>>,
) -> Json<Value> {
    Json(state.structured_products_service.status_payload())
}

pub async fn stock_analysis_alpaca_quotes(
    State(state): State<Arc<AppState>>,
    Query(query): Query<AlpacaQuotesQuery>,
) -> Json<AlpacaQuotesResponse> {
    Json(
        state
            .alpaca_market_data_service
            .latest_quotes(query.symbols.as_deref().unwrap_or(""))
            .await,
    )
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

pub async fn upload_data(
    State(state): State<Arc<AppState>>,
    multipart: Multipart,
) -> Result<(StatusCode, Json<UploadDataResponse>), ApiError> {
    let response = state.upload_data_service.upload(multipart).await?;
    let status = if response.ok {
        StatusCode::OK
    } else {
        StatusCode::BAD_REQUEST
    };

    Ok((status, Json(response)))
}

pub async fn fred_macro_data(
    State(state): State<Arc<AppState>>,
) -> Json<crate::services::fred::FredMacroDataResponse> {
    Json(state.fred_service.get_macro_data().await)
}

