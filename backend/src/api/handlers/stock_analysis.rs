use std::sync::Arc;

use axum::{
    Json,
    extract::{Query, State},
};
use serde::Deserialize;

use crate::{app_state::AppState, services::alpaca_market_data::AlpacaQuotesResponse};

#[derive(Debug, Deserialize)]
pub struct AlpacaQuotesQuery {
    pub symbols: Option<String>,
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
