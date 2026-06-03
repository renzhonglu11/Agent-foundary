use std::{
    env,
    path::{Path, PathBuf},
    process::Command,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use axum::extract::Multipart;
use chrono::Utc;
use serde::Serialize;

use crate::{
    application::{
        ports::upload_archive_repository::{UploadArchiveRepository, UploadedFileRecord},
        services::{portfolio_service::PortfolioService, transaction_importer::validate_csv},
    },
    services::structured_products_service::{RefreshMode, StructuredProductsService},
};

const ALLOWED_EXTENSIONS: &[&str] = &["csv", "pdf"];
const UPLOAD_ARCHIVE_DIR: &str = "data/uploads";

#[derive(Clone)]
pub struct UploadDataService {
    portfolio_service: PortfolioService,
    structured_products_service: StructuredProductsService,
    upload_archive_repository: Arc<dyn UploadArchiveRepository>,
}

impl UploadDataService {
    pub fn new(
        portfolio_service: PortfolioService,
        structured_products_service: StructuredProductsService,
        upload_archive_repository: Arc<dyn UploadArchiveRepository>,
    ) -> Self {
        Self {
            portfolio_service,
            structured_products_service,
            upload_archive_repository,
        }
    }

    pub async fn upload(&self, mut multipart: Multipart) -> anyhow::Result<UploadDataResponse> {
        let mut prepared = Vec::new();
        let mut rejected = Vec::new();
        let mut saw_file = false;
        let mut saw_csv = false;
        let mut saw_pdf = false;

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

            if extension.as_deref() == Some("csv") && saw_csv {
                rejected.push(RejectedUpload {
                    filename,
                    reason: "Only one CSV file can be uploaded per atomic data update".to_owned(),
                });
                continue;
            }
            if extension.as_deref() == Some("pdf") && saw_pdf {
                rejected.push(RejectedUpload {
                    filename,
                    reason: "Only one PDF file can be uploaded per atomic data update".to_owned(),
                });
                continue;
            }

            let content = field.bytes().await?.to_vec();

            let kind = if extension.as_deref() == Some("csv") {
                match prepare_uploaded_csv(&filename, &content) {
                    Ok(prepared_csv) => {
                        saw_csv = true;
                        PreparedUploadKind::Csv(prepared_csv)
                    }
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
                match prepare_uploaded_pdf(&filename, &content) {
                    Ok(prepared_pdf) => {
                        saw_pdf = true;
                        PreparedUploadKind::Pdf(prepared_pdf)
                    }
                    Err(error) => {
                        rejected.push(RejectedUpload {
                            filename,
                            reason: format!("PDF text extraction failed: {error}"),
                        });
                        continue;
                    }
                }
            };

            prepared.push(PreparedUpload {
                filename,
                content,
                kind,
            });
        }

        if !saw_file {
            return Ok(UploadDataResponse {
                ok: false,
                saved: Vec::new(),
                rejected,
                error: Some("No files uploaded"),
            });
        }

        if !rejected.is_empty() {
            cleanup_prepared_uploads(&prepared);
            return Ok(UploadDataResponse {
                ok: false,
                saved: Vec::new(),
                rejected,
                error: Some("No data was updated because one or more files failed validation"),
            });
        }

        let archive = UploadArchive::new();
        std::fs::create_dir_all(&archive.dir)?;

        let mut csv_path = None;
        let mut saved = Vec::new();
        let mut archived_records = Vec::new();

        for item in &prepared {
            match &item.kind {
                PreparedUploadKind::Csv(csv) => {
                    let archived_csv_path = archive.path_for(&item.filename, "csv");
                    write_upload_target(&archived_csv_path, &item.content)?;
                    csv_path = Some(archived_csv_path.clone());
                    saved.push(item.saved_upload(
                        vec![archived_csv_path.clone()],
                        Some(csv.imported_rows),
                        None,
                    ));
                    archived_records.push(ArchivedUploadRecord {
                        filename: item.filename.clone(),
                        kind: "csv".to_owned(),
                        stored_path: archived_csv_path,
                        size_bytes: item.content.len(),
                        imported_rows: Some(csv.imported_rows),
                        extracted_text_path: None,
                        extracted_text: None,
                    });
                }
                PreparedUploadKind::Pdf(pdf) => {
                    let archived_pdf_path = archive.path_for(&item.filename, "pdf");
                    write_upload_target(&archived_pdf_path, &item.content)?;

                    saved.push(item.saved_upload(
                        vec![archived_pdf_path.clone()],
                        None,
                        Some(pdf.extracted_text.len()),
                    ));
                    archived_records.push(ArchivedUploadRecord {
                        filename: item.filename.clone(),
                        kind: "pdf".to_owned(),
                        stored_path: archived_pdf_path,
                        size_bytes: item.content.len(),
                        imported_rows: None,
                        extracted_text_path: None,
                        extracted_text: Some(pdf.extracted_text.clone()),
                    });
                }
            }
        }

        let update_result = self
            .portfolio_service
            .apply_data_update(csv_path.as_deref())
            .await;
        cleanup_prepared_uploads(&prepared);
        let _ = update_result?;
        self.record_archive(&archive, &archived_records).await?;
        let summary = self.portfolio_service.refresh_summary_cache().await?;
        self.structured_products_service.spawn_refresh(
            summary,
            "upload_data_success",
            RefreshMode::FallbackOnly,
        );

        Ok(UploadDataResponse {
            ok: true,
            saved,
            rejected,
            error: None,
        })
    }

    async fn record_archive(
        &self,
        archive: &UploadArchive,
        records: &[ArchivedUploadRecord],
    ) -> anyhow::Result<()> {
        self.upload_archive_repository
            .create_batch(&archive.batch_id, &archive.created_at)
            .await?;

        for (index, record) in records.iter().enumerate() {
            self.upload_archive_repository
                .insert_file(&UploadedFileRecord {
                    file_id: format!("{}-{:02}-{}", archive.batch_id, index + 1, record.kind),
                    batch_id: archive.batch_id.clone(),
                    kind: record.kind.clone(),
                    original_filename: record.filename.clone(),
                    stored_path: record.stored_path.display().to_string(),
                    size_bytes: record.size_bytes as i64,
                    imported_rows: record.imported_rows.map(|rows| rows as i64),
                    extracted_text_path: record
                        .extracted_text_path
                        .as_ref()
                        .map(|path| path.display().to_string()),
                    extracted_text: record.extracted_text.clone(),
                    created_at: archive.created_at.clone(),
                })
                .await?;
        }

        Ok(())
    }
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

fn write_upload_target(path: &Path, content: &[u8]) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, content)?;
    Ok(())
}

fn prepare_uploaded_csv(filename: &str, content: &[u8]) -> anyhow::Result<PreparedCsvUpload> {
    let temp_path = temporary_csv_path(filename);
    if let Some(parent) = temp_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&temp_path, content)?;

    match validate_csv(&temp_path) {
        Ok(imported_rows) => Ok(PreparedCsvUpload {
            temp_path,
            imported_rows,
        }),
        Err(error) => {
            let _ = std::fs::remove_file(&temp_path);
            Err(error)
        }
    }
}

fn prepare_uploaded_pdf(filename: &str, content: &[u8]) -> anyhow::Result<PreparedPdfUpload> {
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

        Ok(PreparedPdfUpload {
            extracted_text: text,
        })
    });

    let _ = std::fs::remove_file(&temp_pdf_path);
    let _ = std::fs::remove_file(&temp_text_path);

    result
}

fn run_pdf_text_extractor(pdf_path: &Path, text_path: &Path) -> anyhow::Result<()> {
    let script_path = pdf_text_extractor_script()?;
    let python = env::var("PDF_EXTRACT_PYTHON").unwrap_or_else(|_| "python3".to_owned());
    let output = Command::new(python)
        .arg(script_path)
        .arg(pdf_path)
        .arg(text_path)
        .output()
        .map_err(|error| {
            anyhow::anyhow!(
                "failed to run PDF text extractor. Install dependencies with `uv sync --directory backend/python`, or set PDF_EXTRACT_PYTHON to a Python with PyMuPDF installed: {error}"
            )
        })?;

    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("No module named 'pymupdf'") || stderr.contains("No module named 'fitz'")
        {
            anyhow::bail!(
                "PDF text extraction failed because PyMuPDF is not installed. Run `uv sync --directory backend/python` or set PDF_EXTRACT_PYTHON to a Python with PyMuPDF installed."
            );
        }

        anyhow::bail!("PDF text extraction failed: {stderr}");
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
        PathBuf::from("backend/python/scripts/extractPdfText.py"),
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

#[derive(Debug, Clone)]
struct UploadArchive {
    batch_id: String,
    created_at: String,
    dir: PathBuf,
}

impl UploadArchive {
    fn new() -> Self {
        let now = Utc::now();
        let timestamp = now.format("%Y%m%dT%H%M%SZ").to_string();
        let batch_id = format!("upload-{timestamp}-{}", std::process::id());
        Self {
            dir: PathBuf::from(UPLOAD_ARCHIVE_DIR).join(&batch_id),
            batch_id,
            created_at: now.to_rfc3339(),
        }
    }

    fn path_for(&self, filename: &str, extension: &str) -> PathBuf {
        let stem = Path::new(filename)
            .file_stem()
            .and_then(|value| value.to_str())
            .map(sanitize_filename)
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "upload".to_owned());
        self.dir
            .join(format!("{}-{stem}.{extension}", self.batch_id))
    }
}

#[derive(Debug, Clone)]
struct ArchivedUploadRecord {
    filename: String,
    kind: String,
    stored_path: PathBuf,
    size_bytes: usize,
    imported_rows: Option<usize>,
    extracted_text_path: Option<PathBuf>,
    extracted_text: Option<String>,
}

struct PreparedUpload {
    filename: String,
    content: Vec<u8>,
    kind: PreparedUploadKind,
}

enum PreparedUploadKind {
    Csv(PreparedCsvUpload),
    Pdf(PreparedPdfUpload),
}

struct PreparedCsvUpload {
    temp_path: PathBuf,
    imported_rows: usize,
}

struct PreparedPdfUpload {
    extracted_text: String,
}

impl PreparedUpload {
    fn saved_upload(
        &self,
        paths: Vec<PathBuf>,
        imported_rows: Option<usize>,
        extracted_pdf_text: Option<usize>,
    ) -> SavedUpload {
        SavedUpload {
            filename: self.filename.clone(),
            size: self.content.len(),
            paths: paths
                .iter()
                .map(|target| target.to_string_lossy().into_owned())
                .collect(),
            imported_rows,
            extracted_pdf_text,
        }
    }
}

fn cleanup_prepared_uploads(prepared: &[PreparedUpload]) {
    for item in prepared {
        if let PreparedUploadKind::Csv(csv) = &item.kind {
            let _ = std::fs::remove_file(&csv.temp_path);
        }
    }
}

#[derive(Debug, Serialize)]
pub struct UploadDataResponse {
    pub ok: bool,
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
