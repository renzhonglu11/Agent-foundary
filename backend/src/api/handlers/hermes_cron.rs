use std::sync::Arc;

use axum::{Json, extract::State};

use crate::{app_state::AppState, services::hermes_cron_status::HermesCronStatusResponse};

pub async fn hermes_cron_status(
    State(state): State<Arc<AppState>>,
) -> Json<HermesCronStatusResponse> {
    Json(state.hermes_cron_status_service.status())
}
