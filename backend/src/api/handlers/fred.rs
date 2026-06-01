use std::sync::Arc;

use axum::{Json, extract::State};

use crate::{app_state::AppState, services::fred::FredMacroDataResponse};

pub async fn fred_macro_data(State(state): State<Arc<AppState>>) -> Json<FredMacroDataResponse> {
    Json(state.fred_service.get_macro_data().await)
}
