use std::sync::Arc;

use axum::{
    Json,
    extract::{Multipart, State},
    http::StatusCode,
};

use crate::{
    api::error::ApiError, app_state::AppState,
    application::services::upload_data_service::UploadDataResponse,
};

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
