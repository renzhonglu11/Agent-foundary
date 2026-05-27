use std::{
    env,
    path::{Path, PathBuf},
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

use axum::extract::Multipart;
use serde::Serialize;

use crate::{
    application::services::{
        portfolio_service::PortfolioService, transaction_importer::validate_csv,
    },
    services::structured_products_service::{RefreshMode, StructuredProductsService},
};

const ALLOWED_EXTENSIONS: &[&str] = &["csv", "pdf"];
const CANONICAL_CSV_PATH: &str = "data/portfolio-transactions.csv";
const CANONICAL_PDF_PATH: &str = "data/asset-overview.pdf";

#[derive(Clone)]
pub struct UploadDataService {
    portfolio_service: PortfolioService,
    structured_products_service: StructuredProductsService,
}

impl UploadDataService {
    pub fn new(
        portfolio_service: PortfolioService,
        structured_products_service: StructuredProductsService,
    ) -> Self {
        Self {
            portfolio_service,
            structured_products_service,
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
                match prepare_uploaded_pdf(&self.portfolio_service, &filename, &content) {
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

        let mut csv_path = None;
        let mut pdf_path = None;
        let mut saved = Vec::new();

        for item in &prepared {
            match &item.kind {
                PreparedUploadKind::Csv(csv) => {
                    let target = canonical_csv_path();
                    write_upload_target(&target, &item.content)?;
                    csv_path = Some(target.clone());
                    saved.push(item.saved_upload(vec![target], Some(csv.imported_rows), None));
                }
                PreparedUploadKind::Pdf(pdf) => {
                    let Some(pdf_text_path) = self.portfolio_service.pdf_text_path() else {
                        anyhow::bail!("PDF_TEXT_PATH is not configured");
                    };
                    let target = canonical_pdf_path();
                    write_upload_target(&target, &item.content)?;
                    if let Some(parent) = pdf_text_path.parent() {
                        std::fs::create_dir_all(parent)?;
                    }
                    std::fs::write(&pdf_text_path, &pdf.extracted_text)?;
                    pdf_path = Some(target.clone());
                    saved.push(item.saved_upload(
                        vec![target],
                        None,
                        Some(pdf.extracted_text.len()),
                    ));
                }
            }
        }

        let update_result = self
            .portfolio_service
            .apply_data_update(csv_path.as_deref(), pdf_path)
            .await;
        cleanup_prepared_uploads(&prepared);
        let (_, summary) = update_result?;
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

fn canonical_csv_path() -> PathBuf {
    PathBuf::from(CANONICAL_CSV_PATH)
}

fn canonical_pdf_path() -> PathBuf {
    PathBuf::from(CANONICAL_PDF_PATH)
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

fn prepare_uploaded_pdf(
    service: &PortfolioService,
    filename: &str,
    content: &[u8],
) -> anyhow::Result<PreparedPdfUpload> {
    if service.pdf_text_path().is_none() {
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
