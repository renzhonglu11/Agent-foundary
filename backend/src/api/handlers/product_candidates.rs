use std::sync::Arc;

use axum::{
    Json,
    extract::{Path, Query, State},
    http::StatusCode,
};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::{
    api::error::ApiError,
    app_state::AppState,
    services::product_candidates::{CandidateSearch, valid_isin},
};

type CandidateError = (StatusCode, Json<Value>);

fn bad_request(message: &str) -> CandidateError {
    (StatusCode::BAD_REQUEST, Json(json!({"error":message})))
}

pub async fn search_product_candidates(
    State(state): State<Arc<AppState>>,
    Query(query): Query<CandidateSearch>,
) -> Result<Json<Value>, CandidateError> {
    query.validate().map_err(bad_request)?;
    state.product_candidates.search(&query).await.map(Json).map_err(|error| {
        tracing::warn!(%error, "product candidate search failed");
        (StatusCode::BAD_GATEWAY, Json(json!({"error":"产品搜索暂不可用，或原持仓不是数据源可识别的普通权证；请重试或按标的名称搜索。"})))
    })
}

pub async fn product_watchlist(
    State(state): State<Arc<AppState>>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(state.product_candidates.watchlist().await?))
}

#[derive(Deserialize)]
pub struct SaveCandidate {
    isin: String,
}

pub async fn save_product_watchlist(
    State(state): State<Arc<AppState>>,
    Json(input): Json<SaveCandidate>,
) -> Result<Json<Value>, CandidateError> {
    let isin = input.isin.trim().to_uppercase();
    if !valid_isin(&isin) {
        return Err(bad_request("请输入有效的 12 位 ISIN（含校验位）"));
    }
    state.product_candidates.save(&isin).await.map(|p| Json(json!(p))).map_err(|error| {
        tracing::warn!(%error, "saving product candidate failed");
        (StatusCode::BAD_GATEWAY, Json(json!({"error":"未能更新观察产品：请确认 ISIN 属于普通权证、观察列表未达到 100 只上限，或稍后重试。已有记录保留。"})))
    })
}

pub async fn remove_product_watchlist(
    State(state): State<Arc<AppState>>,
    Path(isin): Path<String>,
) -> Result<Json<Value>, ApiError> {
    state.product_candidates.remove(&isin).await?;
    Ok(Json(json!({"removed":isin})))
}
