use std::sync::Arc;

use axum::{
    Json,
    extract::{Path, State},
};

use crate::{
    api::error::ApiError,
    app_state::AppState,
    services::pnl_snapshots::{CreatePnlSnapshotRequest, PnlSnapshot, PnlSnapshotsResponse},
};

pub async fn list_pnl_snapshots(
    State(state): State<Arc<AppState>>,
) -> Result<Json<PnlSnapshotsResponse>, ApiError> {
    let snapshots = state.pnl_snapshot_service.list_snapshots().await?;
    Ok(Json(PnlSnapshotsResponse { snapshots }))
}

pub async fn create_pnl_snapshot(
    State(state): State<Arc<AppState>>,
    Json(request): Json<CreatePnlSnapshotRequest>,
) -> Result<Json<PnlSnapshot>, ApiError> {
    let snapshot = state.pnl_snapshot_service.create_snapshot(request).await?;
    Ok(Json(snapshot))
}

pub async fn delete_pnl_snapshot(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    state.pnl_snapshot_service.delete_snapshot(&id).await?;
    Ok(Json(serde_json::json!({ "ok": true })))
}
