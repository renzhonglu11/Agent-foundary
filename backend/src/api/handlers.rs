use std::{
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use axum::{
    Json,
    extract::{Multipart, State},
    http::StatusCode,
};
use serde::Serialize;

use crate::{api::error::ApiError, services::portfolio_service::PortfolioService};

const ALLOWED_EXTENSIONS: &[&str] = &["csv", "pdf"];

pub async fn portfolio_summary(
    State(service): State<PortfolioService>,
) -> Result<Json<crate::domain::portfolio::PortfolioSummaryResponse>, ApiError> {
    Ok(Json(service.summary().await?))
}

pub async fn health() -> Json<serde_json::Value> {
    Json(serde_json::json!({ "ok": true }))
}

pub async fn upload_data(
    State(service): State<PortfolioService>,
    mut multipart: Multipart,
) -> Result<(StatusCode, Json<UploadDataResponse>), ApiError> {
    let mut saved = Vec::new();
    let mut rejected = Vec::new();
    let mut saw_file = false;

    while let Some(field) = multipart.next_field().await? {
        let Some(original_filename) = field.file_name().map(str::to_owned) else {
            continue;
        };
        saw_file = true;

        let filename = sanitize_filename(&original_filename);
        let extension = Path::new(&filename)
            .extension()
            .and_then(|value| value.to_str())
            .map(str::to_ascii_lowercase);

        if !extension
            .as_deref()
            .is_some_and(|value| ALLOWED_EXTENSIONS.contains(&value))
        {
            rejected.push(RejectedUpload {
                filename,
                reason: "Only .csv and .pdf files are allowed",
            });
            continue;
        }

        let content = field.bytes().await?;
        let targets = upload_targets(&filename);

        let imported_rows = if extension.as_deref() == Some("csv") {
            match import_uploaded_csv(&service, &filename, &content).await {
                Ok(rows) => Some(rows),
                Err(_) => {
                    rejected.push(RejectedUpload {
                        filename,
                        reason: "CSV columns or rows do not match the expected transaction format",
                    });
                    continue;
                }
            }
        } else {
            None
        };

        for target in &targets {
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::write(target, &content)?;
        }

        saved.push(SavedUpload {
            filename,
            size: content.len(),
            paths: targets
                .iter()
                .map(|target| target.to_string_lossy().into_owned())
                .collect(),
            imported_rows,
        });
    }

    if !saw_file {
        return Ok((
            StatusCode::BAD_REQUEST,
            Json(UploadDataResponse {
                ok: false,
                saved,
                rejected,
                error: Some("No files uploaded"),
            }),
        ));
    }

    let status = if saved.is_empty() {
        StatusCode::BAD_REQUEST
    } else {
        StatusCode::OK
    };

    Ok((
        status,
        Json(UploadDataResponse {
            ok: !saved.is_empty(),
            saved,
            rejected,
            error: None,
        }),
    ))
}

fn sanitize_filename(name: &str) -> String {
    let base = name
        .rsplit(['/', '\\'])
        .next()
        .filter(|value| !value.is_empty())
        .unwrap_or("upload.dat");
    base.chars()
        .map(|value| {
            if value.is_ascii_alphanumeric()
                || value.is_ascii_whitespace()
                || matches!(value, '.' | '_' | '(' | ')' | '-')
            {
                value
            } else {
                '_'
            }
        })
        .take(180)
        .collect()
}

fn upload_targets(filename: &str) -> Vec<PathBuf> {
    vec![PathBuf::from("data").join(filename)]
}

async fn import_uploaded_csv(
    service: &PortfolioService,
    filename: &str,
    content: &[u8],
) -> anyhow::Result<usize> {
    let temp_path = temporary_csv_path(filename);
    if let Some(parent) = temp_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&temp_path, content)?;

    let result = service.import_csv(&temp_path).await;
    let _ = std::fs::remove_file(&temp_path);
    result
}

fn temporary_csv_path(filename: &str) -> PathBuf {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();

    PathBuf::from("data").join(format!(
        ".upload-{}-{}-{filename}",
        std::process::id(),
        timestamp
    ))
}

#[derive(Debug, Serialize)]
pub struct UploadDataResponse {
    ok: bool,
    saved: Vec<SavedUpload>,
    rejected: Vec<RejectedUpload>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<&'static str>,
}

#[derive(Debug, Serialize)]
struct SavedUpload {
    filename: String,
    size: usize,
    paths: Vec<String>,
    #[serde(rename = "importedRows", skip_serializing_if = "Option::is_none")]
    imported_rows: Option<usize>,
}

#[derive(Debug, Serialize)]
struct RejectedUpload {
    filename: String,
    reason: &'static str,
}
