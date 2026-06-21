use std::sync::Arc;

use axum::{
    Json,
    extract::{Query, State},
};
use serde::Deserialize;

use crate::{app_state::AppState, services::alpaca_market_data::AlpacaQuotesResponse};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlpacaQuotesQuery {
    pub symbols: Option<String>,
    pub cache_only: Option<bool>,
}

pub async fn stock_analysis_alpaca_quotes(
    State(state): State<Arc<AppState>>,
    Query(query): Query<AlpacaQuotesQuery>,
) -> Json<AlpacaQuotesResponse> {
    let symbols = query.symbols.as_deref().unwrap_or("");
    if query.cache_only.unwrap_or(false) {
        return Json(
            state
                .alpaca_market_data_service
                .persisted_quotes(symbols)
                .await,
        );
    }

    Json(
        state
            .alpaca_market_data_service
            .latest_quotes(symbols)
            .await,
    )
}
