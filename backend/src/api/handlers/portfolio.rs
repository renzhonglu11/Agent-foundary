use std::sync::Arc;

use axum::{Json, extract::State};

use crate::{api::error::ApiError, app_state::AppState};

pub async fn portfolio_summary(
    State(state): State<Arc<AppState>>,
) -> Result<Json<crate::domain::portfolio::PortfolioSummaryResponse>, ApiError> {
    Ok(Json(state.portfolio_service.summary().await?))
}
