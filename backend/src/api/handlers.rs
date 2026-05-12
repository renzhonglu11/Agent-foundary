use axum::{Json, extract::State};

use crate::{api::error::ApiError, services::portfolio_service::PortfolioService};

pub async fn portfolio_summary(
    State(service): State<PortfolioService>,
) -> Result<Json<crate::domain::portfolio::PortfolioSummaryResponse>, ApiError> {
    Ok(Json(service.summary().await?))
}

pub async fn health() -> Json<serde_json::Value> {
    Json(serde_json::json!({ "ok": true }))
}
