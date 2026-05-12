use std::{
    collections::HashMap,
    env, fs,
    path::{Path, PathBuf},
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

use axum::{
    Json,
    extract::{Multipart, State},
    http::StatusCode,
};
use serde::Serialize;
use serde_json::Value;

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

pub async fn hermes_cron_status() -> Json<HermesCronStatusResponse> {
    Json(build_hermes_cron_status())
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
                reason: "Only .csv and .pdf files are allowed".to_owned(),
            });
            continue;
        }

        let content = field.bytes().await?;
        let targets = upload_targets(&filename);

        let imported_rows = if extension.as_deref() == Some("csv") {
            match import_uploaded_csv(&service, &filename, &content).await {
                Ok(rows) => Some(rows),
                Err(error) => {
                    rejected.push(RejectedUpload {
                        filename,
                        reason: format!(
                            "CSV columns or rows do not match the expected transaction format: {error}"
                        ),
                    });
                    continue;
                }
            }
        } else {
            None
        };

        let extracted_pdf_text = if extension.as_deref() == Some("pdf") {
            match extract_uploaded_pdf(&service, &targets[0], &filename, &content).await {
                Ok(chars) => Some(chars),
                Err(error) => {
                    rejected.push(RejectedUpload {
                        filename,
                        reason: format!("PDF text extraction failed: {error}"),
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
            extracted_pdf_text,
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

async fn extract_uploaded_pdf(
    service: &PortfolioService,
    target_pdf_path: &Path,
    filename: &str,
    content: &[u8],
) -> anyhow::Result<usize> {
    let Some(pdf_text_path) = service.pdf_text_path() else {
        anyhow::bail!("PDF_TEXT_PATH is not configured");
    };

    let temp_pdf_path = temporary_upload_path(filename, "pdf");
    let temp_text_path = temporary_upload_path(filename, "txt");
    if let Some(parent) = temp_pdf_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&temp_pdf_path, content)?;

    let result = run_pdf_text_extractor(&temp_pdf_path, &temp_text_path).and_then(|()| {
        let text = std::fs::read_to_string(&temp_text_path)?;
        if text.trim().is_empty() {
            anyhow::bail!("PDF text extraction produced empty output");
        }

        if let Some(parent) = pdf_text_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&pdf_text_path, &text)?;
        Ok(text.len())
    });

    let _ = std::fs::remove_file(&temp_pdf_path);
    let _ = std::fs::remove_file(&temp_text_path);

    let chars = result?;
    service
        .refresh_after_pdf_update(target_pdf_path.to_path_buf())
        .await?;

    Ok(chars)
}

fn run_pdf_text_extractor(pdf_path: &Path, text_path: &Path) -> anyhow::Result<()> {
    let script_path = pdf_text_extractor_script()?;
    let python = env::var("PDF_EXTRACT_PYTHON").unwrap_or_else(|_| "python3".to_owned());
    let output = Command::new(python)
        .arg(script_path)
        .arg(pdf_path)
        .arg(text_path)
        .output()?;

    if output.status.success() {
        Ok(())
    } else {
        anyhow::bail!(
            "PDF text extraction failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
}

fn pdf_text_extractor_script() -> anyhow::Result<PathBuf> {
    if let Ok(path) = env::var("PDF_TEXT_EXTRACTOR_SCRIPT") {
        let path = PathBuf::from(path);
        if path.exists() {
            return Ok(path);
        }
    }

    for candidate in [
        PathBuf::from("backend/scripts/extractPdfText.py"),
        PathBuf::from("scripts/extractPdfText.py"),
    ] {
        if candidate.exists() {
            return Ok(candidate);
        }
    }

    anyhow::bail!("PDF text extractor script not found");
}

fn temporary_csv_path(filename: &str) -> PathBuf {
    temporary_upload_path(filename, "csv")
}

fn temporary_upload_path(filename: &str, extension: &str) -> PathBuf {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();

    PathBuf::from("data").join(format!(
        ".upload-{}-{}-{filename}.{extension}",
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
    #[serde(rename = "extractedPdfText", skip_serializing_if = "Option::is_none")]
    extracted_pdf_text: Option<usize>,
}

#[derive(Debug, Serialize)]
struct RejectedUpload {
    filename: String,
    reason: String,
}

fn build_hermes_cron_status() -> HermesCronStatusResponse {
    let path = hermes_cron_jobs_path();
    let mut jobs = Vec::new();
    let mut updated_at = None;
    let mut read_error = None;

    match fs::read_to_string(&path) {
        Ok(content) => match serde_json::from_str::<Value>(&content) {
            Ok(raw) => {
                updated_at = raw
                    .get("updated_at")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                jobs = raw
                    .get("jobs")
                    .and_then(Value::as_array)
                    .map(|items| items.iter().map(summarize_hermes_job).collect())
                    .unwrap_or_default();
            }
            Err(error) => read_error = Some(error.to_string()),
        },
        Err(error) => {
            read_error = Some(format!(
                "Cron jobs file not found: {} ({error})",
                path.display()
            ))
        }
    }

    jobs.sort_by(|a, b| {
        b.enabled.cmp(&a.enabled).then_with(|| {
            a.next_run_at
                .as_deref()
                .unwrap_or("9999")
                .cmp(b.next_run_at.as_deref().unwrap_or("9999"))
        })
    });

    let summary = HermesCronSummary {
        total: jobs.len(),
        active: jobs
            .iter()
            .filter(|job| job.enabled && job.state != "paused")
            .count(),
        paused: jobs
            .iter()
            .filter(|job| !job.enabled || job.state == "paused")
            .count(),
        ok: jobs
            .iter()
            .filter(|job| {
                matches!(
                    job.status_group.as_str(),
                    "scheduled" | "pending" | "completed"
                )
            })
            .count(),
        error: jobs
            .iter()
            .filter(|job| matches!(job.status_group.as_str(), "failed" | "delivery_failed"))
            .count(),
        with_delivery_error: jobs
            .iter()
            .filter(|job| job.last_delivery_error.is_some())
            .count(),
    };

    HermesCronStatusResponse {
        generated_at: chrono::Utc::now().to_rfc3339(),
        source: HermesCronSource {
            path: path.display().to_string(),
            updated_at,
            read_error,
        },
        summary,
        jobs,
    }
}

fn hermes_cron_jobs_path() -> PathBuf {
    if let Ok(path) = env::var("HERMES_CRON_JOBS_PATH") {
        return PathBuf::from(path);
    }

    env::var("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."))
        .join(".hermes/cron/jobs.json")
}

fn summarize_hermes_job(job: &Value) -> HermesCronJob {
    let repeat = normalize_hermes_repeat(job.get("repeat"));
    let enabled = bool_field(job, "enabled");
    let state = string_field(job, "state").unwrap_or_else(|| {
        if enabled {
            "scheduled".to_owned()
        } else {
            "paused".to_owned()
        }
    });
    let last_status = string_field(job, "last_status");
    let status = hermes_ui_status(enabled, &state, last_status.as_deref(), job);
    let schedule = string_field(job, "schedule_display")
        .or_else(|| nested_string_field(job, "schedule", "display"))
        .or_else(|| nested_string_field(job, "schedule", "expr"))
        .unwrap_or_else(|| "—".to_owned());
    let schedule_label = describe_cron_schedule(
        nested_string_field(job, "schedule", "expr")
            .or_else(|| string_field(job, "schedule_display"))
            .or_else(|| nested_string_field(job, "schedule", "display"))
            .or_else(|| string_field(job, "schedule"))
            .as_deref(),
    );
    let deliver = string_field(job, "deliver").unwrap_or_else(|| "local".to_owned());

    HermesCronJob {
        id: string_field(job, "id").unwrap_or_default(),
        name: string_field(job, "name")
            .or_else(|| string_field(job, "id"))
            .unwrap_or_default(),
        schedule,
        schedule_label,
        repeat: repeat.label,
        completed_runs: repeat.completed,
        enabled,
        state,
        status_group: status.group,
        status_label: status.label,
        last_status,
        last_error: string_field(job, "last_error"),
        last_delivery_error: string_field(job, "last_delivery_error"),
        created_at: string_field(job, "created_at"),
        next_run_at: string_field(job, "next_run_at"),
        last_run_at: string_field(job, "last_run_at"),
        paused_at: string_field(job, "paused_at"),
        paused_reason: string_field(job, "paused_reason"),
        deliver_label: format_deliver_target(&deliver),
        deliver,
        provider: string_field(job, "provider"),
        model: string_field(job, "model"),
        skills: skills_field(job),
        script: string_field(job, "script"),
        origin: origin_field(job),
    }
}

fn string_field(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn nested_string_field(value: &Value, object_key: &str, key: &str) -> Option<String> {
    value
        .get(object_key)
        .and_then(|object| object.get(key))
        .and_then(Value::as_str)
        .map(str::to_owned)
}

fn bool_field(value: &Value, key: &str) -> bool {
    value.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn skills_field(job: &Value) -> Vec<String> {
    if let Some(skills) = job.get("skills").and_then(Value::as_array) {
        return skills
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect();
    }

    string_field(job, "skill").into_iter().collect()
}

fn origin_field(job: &Value) -> Option<HermesCronOrigin> {
    let origin = job.get("origin")?;
    Some(HermesCronOrigin {
        platform: string_field(origin, "platform"),
        chat_id: string_field(origin, "chat_id"),
        chat_name: string_field(origin, "chat_name"),
        thread_id: string_field(origin, "thread_id"),
    })
}

fn normalize_hermes_repeat(repeat: Option<&Value>) -> HermesCronRepeat {
    let Some(repeat) = repeat else {
        return HermesCronRepeat {
            label: "—".to_owned(),
            completed: 0,
        };
    };

    if let Some(value) = repeat.as_str() {
        return HermesCronRepeat {
            label: value.to_owned(),
            completed: 0,
        };
    }

    let completed = repeat
        .get("completed")
        .and_then(Value::as_u64)
        .unwrap_or_default() as usize;
    let label = match repeat.get("times").and_then(Value::as_u64) {
        Some(times) => format!("{completed}/{times}"),
        None => "∞".to_owned(),
    };

    HermesCronRepeat { label, completed }
}

fn hermes_ui_status(
    enabled: bool,
    state: &str,
    last_status: Option<&str>,
    job: &Value,
) -> HermesCronUiStatus {
    let last_status_failed = matches!(last_status, Some("error" | "failed"));
    let last_error = job.get("last_error").and_then(Value::as_str).is_some();
    let delivery_error = job
        .get("last_delivery_error")
        .and_then(Value::as_str)
        .is_some();

    if !enabled || state == "paused" {
        return HermesCronUiStatus::new("paused", "Paused");
    }
    if state == "completed" {
        return HermesCronUiStatus::new("completed", "Completed");
    }
    if state == "error" || last_error || last_status_failed {
        return HermesCronUiStatus::new("failed", "Failed");
    }
    if delivery_error {
        return HermesCronUiStatus::new("delivery_failed", "Delivery Failed");
    }
    if state == "scheduled" {
        if job.get("last_run_at").and_then(Value::as_str).is_some() {
            return HermesCronUiStatus::new("scheduled", "Scheduled");
        }
        return HermesCronUiStatus::new("pending", "Pending");
    }

    HermesCronUiStatus::new(state, &state.replace('_', " "))
}

fn describe_cron_schedule(expression: Option<&str>) -> String {
    let Some(expression) = expression.filter(|value| !value.trim().is_empty()) else {
        return "—".to_owned();
    };
    let parts = expression.split_whitespace().collect::<Vec<_>>();
    if parts.len() != 5
        || !parts[0].chars().all(|c| c.is_ascii_digit())
        || !parts[1].chars().all(|c| c.is_ascii_digit())
        || parts[3] != "*"
    {
        return expression.to_owned();
    }

    let local_time = format!(
        "{:02}:{:02} Berlin",
        parts[1].parse::<u8>().unwrap_or(0),
        parts[0].parse::<u8>().unwrap_or(0)
    );
    let day_part =
        describe_day_of_month(parts[2]).unwrap_or_else(|| describe_day_of_week(parts[4]));
    format!("{day_part} {local_time}")
}

fn describe_day_of_month(value: &str) -> Option<String> {
    if value.is_empty() || value == "*" {
        None
    } else {
        Some(format!(
            "每月 {} 日",
            value.split(',').collect::<Vec<_>>().join("、")
        ))
    }
}

fn describe_day_of_week(value: &str) -> String {
    if value.is_empty() || value == "*" {
        return "每天".to_owned();
    }
    if value == "1-5" {
        return "工作日".to_owned();
    }
    if value == "0,6" || value == "6,0" {
        return "周末".to_owned();
    }
    if let Some((start, end)) = value.split_once('-') {
        return format!("{}至{}", day_name(start), day_name(end));
    }

    value
        .split(',')
        .map(day_name)
        .collect::<Vec<_>>()
        .join("、")
}

fn day_name(value: &str) -> &'static str {
    match value {
        "0" | "7" => "周日",
        "1" => "周一",
        "2" => "周二",
        "3" => "周三",
        "4" => "周四",
        "5" => "周五",
        "6" => "周六",
        _ => "未知",
    }
}

fn format_deliver_target(deliver: &str) -> String {
    if deliver == "origin" {
        return "当前会话".to_owned();
    }
    if deliver == "local" {
        return "本地保存".to_owned();
    }
    if deliver == "discord" {
        return "Discord Home".to_owned();
    }
    if deliver.starts_with("discord:#") {
        return deliver.to_owned();
    }
    if !deliver.starts_with("discord:") {
        return deliver.to_owned();
    }

    let channel_names = HashMap::from([
        ("1492875309299662951", "#📈｜美股"),
        ("1493029413481222198", "#⚙️｜运维"),
        ("1494090512414543952", "#📌｜panel"),
    ]);
    let parts = deliver.split(':').collect::<Vec<_>>();
    let Some(channel_id) = parts.get(1) else {
        return "discord:未知频道".to_owned();
    };
    let Some(channel_name) = channel_names.get(channel_id) else {
        return "discord:未知频道".to_owned();
    };

    if parts.get(2).is_some() {
        format!("discord:{channel_name} / thread")
    } else {
        format!("discord:{channel_name}")
    }
}

struct HermesCronRepeat {
    label: String,
    completed: usize,
}

struct HermesCronUiStatus {
    group: String,
    label: String,
}

impl HermesCronUiStatus {
    fn new(group: &str, label: &str) -> Self {
        Self {
            group: group.to_owned(),
            label: label.to_owned(),
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HermesCronStatusResponse {
    generated_at: String,
    source: HermesCronSource,
    summary: HermesCronSummary,
    jobs: Vec<HermesCronJob>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HermesCronSource {
    path: String,
    updated_at: Option<String>,
    read_error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HermesCronSummary {
    total: usize,
    active: usize,
    paused: usize,
    ok: usize,
    error: usize,
    with_delivery_error: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HermesCronJob {
    id: String,
    name: String,
    schedule: String,
    schedule_label: String,
    repeat: String,
    completed_runs: usize,
    enabled: bool,
    state: String,
    status_group: String,
    status_label: String,
    last_status: Option<String>,
    last_error: Option<String>,
    last_delivery_error: Option<String>,
    created_at: Option<String>,
    next_run_at: Option<String>,
    last_run_at: Option<String>,
    paused_at: Option<String>,
    paused_reason: Option<String>,
    deliver: String,
    deliver_label: String,
    provider: Option<String>,
    model: Option<String>,
    skills: Vec<String>,
    script: Option<String>,
    origin: Option<HermesCronOrigin>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HermesCronOrigin {
    platform: Option<String>,
    chat_id: Option<String>,
    chat_name: Option<String>,
    thread_id: Option<String>,
}
