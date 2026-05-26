use std::{
    path::{Path, PathBuf},
    sync::{Arc, RwLock},
    time::{SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, anyhow};
use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::Command,
    sync::Mutex,
};
use tracing::{info, warn};

use crate::{config::StructuredProductsSettings, domain::portfolio::PortfolioSummaryResponse};

#[derive(Debug, Clone, Copy)]
pub enum RefreshMode {
    FallbackOnly,
    Live,
}

#[derive(Debug, Clone)]
pub struct StructuredProductsService {
    settings: StructuredProductsSettings,
    output_json_path: PathBuf,
    output_csv_path: PathBuf,
    output_db_path: PathBuf,
    uv_cache_path: PathBuf,
    refresh_lock: Arc<Mutex<()>>,
    status: Arc<RwLock<RefreshStatus>>,
}

#[derive(Debug, Clone, Default)]
struct RefreshStatus {
    running: bool,
    mode: Option<&'static str>,
    progress_current: usize,
    progress_total: usize,
    progress_percent: u8,
    progress_label: Option<String>,
    last_started_at: Option<String>,
    last_finished_at: Option<String>,
    last_error: Option<String>,
}

impl StructuredProductsService {
    pub fn new(settings: StructuredProductsSettings) -> anyhow::Result<Self> {
        Ok(Self {
            output_json_path: absolute_path(&settings.output_json_path)?,
            output_csv_path: absolute_path(&settings.output_csv_path)?,
            output_db_path: absolute_path(&settings.output_db_path)?,
            uv_cache_path: absolute_path(Path::new("data/uv-cache"))?,
            settings,
            refresh_lock: Arc::new(Mutex::new(())),
            status: Arc::new(RwLock::new(RefreshStatus::default())),
        })
    }

    pub fn refresh_if_missing(&self, summary: PortfolioSummaryResponse) {
        if self.output_json_path.exists() {
            return;
        }

        self.spawn_refresh(summary, "startup_missing_output", RefreshMode::FallbackOnly);
    }

    pub fn spawn_refresh(
        &self,
        summary: PortfolioSummaryResponse,
        reason: &'static str,
        mode: RefreshMode,
    ) {
        if !self.settings.enabled {
            return;
        }

        let service = self.clone();
        tokio::spawn(async move {
            if let Err(error) = service.refresh(summary, reason, mode).await {
                warn!(%error, reason, "structured products enrichment refresh failed");
            }
        });
    }

    pub async fn read_payload(&self) -> Value {
        match tokio::fs::read_to_string(&self.output_json_path).await {
            Ok(content) => match serde_json::from_str::<Value>(&content) {
                Ok(payload) => payload,
                Err(error) => self.empty_payload(Some(format!(
                    "Failed to parse {}: {error}",
                    self.output_json_path.display()
                ))),
            },
            Err(error) => self.empty_payload(Some(format!(
                "File not found or unreadable: {} ({error})",
                self.output_json_path.display()
            ))),
        }
    }

    pub fn status_payload(&self) -> Value {
        match self.status.read() {
            Ok(status) => json!({
                "running": status.running,
                "mode": status.mode,
                "progressCurrent": status.progress_current,
                "progressTotal": status.progress_total,
                "progressPercent": status.progress_percent,
                "progressLabel": status.progress_label,
                "lastStartedAt": status.last_started_at,
                "lastFinishedAt": status.last_finished_at,
                "lastError": status.last_error,
            }),
            Err(_) => json!({
                "running": false,
                "lastError": "structured products refresh status lock poisoned",
            }),
        }
    }

    async fn refresh(
        &self,
        summary: PortfolioSummaryResponse,
        reason: &'static str,
        mode: RefreshMode,
    ) -> anyhow::Result<()> {
        let Ok(_guard) = self.refresh_lock.try_lock() else {
            info!(
                reason,
                "structured products enrichment refresh already running"
            );
            return Ok(());
        };

        self.mark_started(mode);
        let result = async {
            let summary_path = self.write_temporary_summary(&summary).await?;
            let result = self.run_generator(&summary_path, reason, mode).await;
            let _ = tokio::fs::remove_file(&summary_path).await;
            result
        }
        .await;
        self.mark_finished(result.as_ref().err().map(ToString::to_string));
        result
    }

    async fn write_temporary_summary(
        &self,
        summary: &PortfolioSummaryResponse,
    ) -> anyhow::Result<PathBuf> {
        let output_dir = self
            .output_json_path
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| PathBuf::from("."));
        tokio::fs::create_dir_all(&output_dir).await?;

        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        let path = output_dir.join(format!(
            ".portfolio-summary-{}-{timestamp}.json",
            std::process::id()
        ));
        let content = serde_json::to_vec(summary)?;
        tokio::fs::write(&path, content).await?;
        Ok(path)
    }

    async fn run_generator(
        &self,
        summary_path: &Path,
        reason: &'static str,
        mode: RefreshMode,
    ) -> anyhow::Result<()> {
        if let Some(parent) = self.output_json_path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        if let Some(parent) = self.output_csv_path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        if let Some(parent) = self.output_db_path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        tokio::fs::create_dir_all(&self.uv_cache_path).await?;

        let mut command = Command::new(&self.settings.command);
        command.current_dir(&self.settings.working_dir);
        if command_uses_uv(&self.settings.command) {
            command
                .env("UV_CACHE_DIR", &self.uv_cache_path)
                .arg("run")
                .arg("--with")
                .arg("httpx")
                .arg("--with")
                .arg("beautifulsoup4")
                .arg("--with")
                .arg("lxml")
                .arg("--with")
                .arg("pydantic")
                .arg("python");
        }

        command
            .arg(&self.settings.script_path)
            .arg("--summary-json")
            .arg(summary_path)
            .arg("--csv")
            .arg(&self.output_csv_path)
            .arg("--json")
            .arg(&self.output_json_path)
            .arg("--db")
            .arg(&self.output_db_path);

        if self.settings.no_live_enrichment || matches!(mode, RefreshMode::FallbackOnly) {
            command.arg("--no-live-enrichment");
        }
        if matches!(mode, RefreshMode::Live) {
            command.arg("--emit-progress");
        }

        info!(
            reason,
            output = %self.output_json_path.display(),
            "starting structured products enrichment refresh"
        );
        command.stdout(std::process::Stdio::piped());
        command.stderr(std::process::Stdio::piped());
        let mut child = command.spawn().with_context(|| {
            format!(
                "failed to spawn structured products generator in {}",
                self.settings.working_dir.display()
            )
        })?;

        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| anyhow!("failed to capture structured products generator stdout"))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| anyhow!("failed to capture structured products generator stderr"))?;
        let progress_service = self.clone();
        let stdout_task = tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            let mut output = Vec::new();
            while let Some(line) = lines.next_line().await? {
                progress_service.handle_stdout_line(&line);
                output.push(line);
            }
            anyhow::Ok(output.join("\n"))
        });
        let stderr_task = tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            let mut output = Vec::new();
            while let Some(line) = lines.next_line().await? {
                output.push(line);
            }
            anyhow::Ok(output.join("\n"))
        });

        let status = child.wait().await?;
        let stdout = stdout_task
            .await
            .context("structured products stdout reader task failed")??;
        let stderr = stderr_task
            .await
            .context("structured products stderr reader task failed")??;

        if !status.success() {
            return Err(anyhow!(
                "structured products generator exited with {status}: {stderr}",
            ));
        }

        info!(
            reason,
            output = %self.output_json_path.display(),
            stdout = %stdout.trim(),
            "structured products enrichment refresh finished"
        );
        Ok(())
    }

    fn empty_payload(&self, read_error: Option<String>) -> Value {
        json!({
            "source": "rust_backend_structured_products_service",
            "count": 0,
            "items": [],
            "read_error": read_error,
            "path": self.output_json_path.display().to_string(),
        })
    }

    fn mark_started(&self, mode: RefreshMode) {
        if let Ok(mut status) = self.status.write() {
            status.running = true;
            status.mode = Some(mode.as_str());
            status.progress_current = 0;
            status.progress_total = 0;
            status.progress_percent = 0;
            status.progress_label = Some("Starting realtime fetch".to_owned());
            status.last_started_at = Some(chrono::Utc::now().to_rfc3339());
            status.last_error = None;
        }
    }

    fn mark_finished(&self, error: Option<String>) {
        if let Ok(mut status) = self.status.write() {
            status.running = false;
            if error.is_none() && status.progress_total > 0 {
                status.progress_current = status.progress_total;
                status.progress_percent = 100;
                status.progress_label = Some("Realtime fetch complete".to_owned());
            }
            status.last_finished_at = Some(chrono::Utc::now().to_rfc3339());
            status.last_error = error;
        }
    }

    fn handle_stdout_line(&self, line: &str) {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            return;
        };
        if value.get("event").and_then(Value::as_str) != Some("structured_products_progress") {
            return;
        }

        let current = value
            .get("current")
            .and_then(Value::as_u64)
            .unwrap_or_default() as usize;
        let total = value
            .get("total")
            .and_then(Value::as_u64)
            .unwrap_or_default() as usize;
        let percent = if total > 0 {
            ((current.saturating_mul(100)) / total).min(100) as u8
        } else {
            0
        };
        let label = value
            .get("label")
            .and_then(Value::as_str)
            .map(str::to_owned);

        if let Ok(mut status) = self.status.write() {
            status.progress_current = current;
            status.progress_total = total;
            status.progress_percent = percent;
            status.progress_label = label;
        }
    }
}

impl RefreshMode {
    fn as_str(self) -> &'static str {
        match self {
            Self::FallbackOnly => "fallback",
            Self::Live => "live",
        }
    }
}

fn absolute_path(path: &Path) -> anyhow::Result<PathBuf> {
    if path.is_absolute() {
        return Ok(path.to_path_buf());
    }

    Ok(std::env::current_dir()
        .context("failed to resolve current directory")?
        .join(path))
}

fn command_uses_uv(command: &str) -> bool {
    Path::new(command)
        .file_name()
        .and_then(|value| value.to_str())
        .is_some_and(|name| name == "uv")
}
