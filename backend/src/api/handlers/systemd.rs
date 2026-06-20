use axum::{Json, extract::State, response::IntoResponse};
use std::sync::Arc;

use crate::app_state::AppState;

pub async fn systemd_units(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    Json(state.systemd_status_service.status().await)
}
