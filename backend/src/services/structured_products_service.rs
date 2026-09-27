use std::{
    path::{Path, PathBuf},
    sync::{
        Arc, RwLock,
        atomic::{AtomicUsize, Ordering},
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, anyhow};
use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::Command,
    sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel},
};
use tracing::{info, warn};

use crate::{
    application::{
        ports::market_data_repository::MarketDataRepository,
        services::portfolio_service::PortfolioService,
    },
    config::StructuredProductsSettings,
    domain::portfolio::PortfolioSummaryResponse,
    services::market_calendar,
};

const STRUCTURED_PRODUCTS_PAYLOAD_KEY: &str = "structured_products_enrichment";
const STRUCTURED_PRODUCTS_RISK_PAYLOAD_KEY: &str = "structured_products_risk";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RefreshMode {
    FallbackOnly,
    Live,
}

#[derive(Clone)]
pub struct StructuredProductsService {
    settings: StructuredProductsSettings,
    market_data_repository: Arc<dyn MarketDataRepository>,
    output_json_path: PathBuf,
    risk_json_path: PathBuf,
    output_csv_path: PathBuf,
    output_db_path: PathBuf,
    uv_cache_path: PathBuf,
    playwright_browsers_path: PathBuf,
    refresh_sender: UnboundedSender<RefreshRequest>,
    queued_requests: Arc<AtomicUsize>,
    status: Arc<RwLock<RefreshStatus>>,
}

#[derive(Debug, Clone)]
struct RefreshRequest {
    summary: PortfolioSummaryResponse,
    reason: &'static str,
    mode: RefreshMode,
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
    auto_refresh_active: bool,
    last_scheduled_refresh_at: Option<String>,
}

#[derive(Debug, Clone)]
struct TemporaryOutputPaths {
    enrichment_json: PathBuf,
    risk_json: PathBuf,
    csv: PathBuf,
}

impl StructuredProductsService {
    pub fn new(
        settings: StructuredProductsSettings,
        market_data_repository: Arc<dyn MarketDataRepository>,
    ) -> anyhow::Result<Self> {
        let uv_cache_path = std::env::var("AGENT_FOUNDRY_UV_CACHE_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("data/uv-cache"));
        let playwright_browsers_path = std::env::var("AGENT_FOUNDRY_PLAYWRIGHT_BROWSERS_PATH")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("data/playwright-browsers"));

        let (refresh_sender, refresh_receiver) = unbounded_channel();
        let service = Self {
            output_json_path: absolute_path(&settings.output_json_path)?,
            risk_json_path: absolute_path(&settings.risk_json_path)?,
            output_csv_path: absolute_path(&settings.output_csv_path)?,
            output_db_path: absolute_path(&settings.output_db_path)?,
            uv_cache_path: absolute_path(&uv_cache_path)?,
            playwright_browsers_path: absolute_path(&playwright_browsers_path)?,
            settings,
            market_data_repository,
            refresh_sender,
            queued_requests: Arc::new(AtomicUsize::new(0)),
            status: Arc::new(RwLock::new(RefreshStatus::default())),
        };
        service.start_refresh_worker(refresh_receiver);
        Ok(service)
    }

    pub async fn refresh_if_missing(&self, summary: PortfolioSummaryResponse) {
        let enrichment_payload = self
            .market_data_repository
            .load_payload(STRUCTURED_PRODUCTS_PAYLOAD_KEY)
            .await;
        let risk_payload = self
            .market_data_repository
            .load_payload(STRUCTURED_PRODUCTS_RISK_PAYLOAD_KEY)
            .await;

        match (&enrichment_payload, &risk_payload) {
            (Ok(Some(_)), Ok(Some(_))) => return,
            (Ok(_), Ok(_)) => {}
            (Err(error), _) => {
                warn!(%error, "failed to check persisted structured products payload");
            }
            (_, Err(error)) => {
                warn!(%error, "failed to check persisted structured products risk payload");
            }
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

        self.queued_requests.fetch_add(1, Ordering::SeqCst);
        if self
            .refresh_sender
            .send(RefreshRequest {
                summary,
                reason,
                mode,
            })
            .is_err()
        {
            self.queued_requests.fetch_sub(1, Ordering::SeqCst);
            warn!(reason, "structured products refresh queue is unavailable");
        }
    }

    fn start_refresh_worker(&self, mut receiver: UnboundedReceiver<RefreshRequest>) {
        let service = self.clone();
        tokio::spawn(async move {
            let mut retry_after = tokio::time::Instant::now();
            while let Some(mut request) = receiver.recv().await {
                // Queue requests through a short cooldown, then coalesce to the newest summary.
                tokio::time::sleep_until(retry_after).await;
                service.queued_requests.fetch_sub(1, Ordering::SeqCst);

                let mut coalesced_count = 1usize;
                while let Ok(next) = receiver.try_recv() {
                    service.queued_requests.fetch_sub(1, Ordering::SeqCst);
                    request = request.coalesce(next);
                    coalesced_count += 1;
                }

                if coalesced_count > 1 {
                    info!(
                        coalesced_count,
                        reason = request.reason,
                        mode = request.mode.as_str(),
                        "coalesced pending structured products refresh requests"
                    );
                }

                if let Err(error) = service
                    .refresh(request.summary, request.reason, request.mode)
                    .await
                {
                    retry_after = tokio::time::Instant::now() + Duration::from_secs(300);
                    warn!(
                        %error,
                        reason = request.reason,
                        "structured products enrichment refresh failed"
                    );
                } else {
                    retry_after = tokio::time::Instant::now() + Duration::from_secs(60);
                }
            }
        });
    }

    /// Start a background auto-refresh loop that keeps Tier-1 structured-product
    /// data fresh during European trading hours (08:00–22:00 CET, Mon–Fri).
    ///
    /// * During market hours — refreshes every `auto_refresh_interval_mins`.
    /// * After market close — takes one closing snapshot, then sleeps until the
    ///   next trading day.
    /// * Weekends & holidays — skipped (checked via FinCal API + hardcoded fallback).
    pub fn start_auto_refresh_loop(&self, portfolio_service: PortfolioService) {
        if !self.settings.auto_refresh_enabled {
            info!("structured products auto-refresh is disabled");
            return;
        }

        let service = self.clone();
        let interval =
            Duration::from_secs(self.settings.auto_refresh_interval_mins.clamp(1, 1440) * 60);
        let market_open = self.settings.market_open_hour_cet;
        let market_close = self.settings.market_close_hour_cet;
        let sleep_off_hours = Duration::from_secs(1800); // 30 min when market is closed

        tokio::spawn(async move {
            // Brief initial delay so the server finishes binding its port.
            tokio::time::sleep(Duration::from_secs(10)).await;
            info!(
                interval_mins = service.settings.auto_refresh_interval_mins,
                market_open, market_close, "starting structured products auto-refresh loop"
            );
            service.set_auto_refresh_active(true);

            let mut post_close_done = false;

            loop {
                let today = market_calendar::berlin_now().date_naive();
                let cet_hour = market_calendar::current_cet_hour();

                if !market_calendar::is_xetra_trading_day(today).await {
                    // Weekend or public holiday — check back periodically.
                    post_close_done = false;
                    tokio::time::sleep(sleep_off_hours).await;
                    continue;
                }

                if cet_hour >= market_open && cet_hour < market_close {
                    // ----- Market hours: refresh on the configured interval -----
                    post_close_done = false;
                    let summary = match portfolio_service.summary().await {
                        Ok(s) => s,
                        Err(error) => {
                            warn!(%error, "auto-refresh: failed to load portfolio summary, retrying");
                            tokio::time::sleep(sleep_off_hours).await;
                            continue;
                        }
                    };
                    service.set_last_scheduled_refresh_at();
                    service.spawn_refresh(summary, "scheduled", RefreshMode::Live);
                    tokio::time::sleep(interval).await;
                } else if cet_hour >= market_close && !post_close_done {
                    // ----- Post-close: one snapshot, then wait for next open -----
                    post_close_done = true;
                    let summary = match portfolio_service.summary().await {
                        Ok(s) => s,
                        Err(error) => {
                            warn!(%error, "auto-refresh: failed to load portfolio summary for close snapshot");
                            tokio::time::sleep(sleep_off_hours).await;
                            continue;
                        }
                    };
                    info!("auto-refresh: taking post-close snapshot");
                    service.set_last_scheduled_refresh_at();
                    service.spawn_refresh(summary, "scheduled_close_snapshot", RefreshMode::Live);
                    tokio::time::sleep(sleep_off_hours).await;
                } else {
                    // ----- Pre-market: wait until open -----
                    let hours_to_open = market_open.saturating_sub(cet_hour);
                    let wait = Duration::from_secs(
                        (hours_to_open as u64 * 3600)
                            .min(sleep_off_hours.as_secs())
                            .max(60),
                    );
                    tokio::time::sleep(wait).await;
                }
            }
        });
    }

    pub async fn read_persisted_payload(&self) -> Value {
        self.read_persisted_json_payload(
            STRUCTURED_PRODUCTS_PAYLOAD_KEY,
            self.empty_enrichment_payload(None),
        )
        .await
    }

    pub async fn read_persisted_risk_payload(&self) -> Value {
        self.read_persisted_json_payload(STRUCTURED_PRODUCTS_RISK_PAYLOAD_KEY, Value::Array(vec![]))
            .await
    }

    async fn read_persisted_json_payload(&self, payload_key: &str, fallback: Value) -> Value {
        match self.market_data_repository.load_payload(payload_key).await {
            Ok(Some(content)) => match serde_json::from_str::<Value>(&content) {
                Ok(payload) => payload,
                Err(error) => self.payload_with_read_error(
                    fallback,
                    format!("Failed to parse persisted realtime payload {payload_key}: {error}"),
                ),
            },
            Ok(None) => fallback,
            Err(error) => self.payload_with_read_error(
                fallback,
                format!("Failed to read persisted realtime payload {payload_key}: {error}"),
            ),
        }
    }

    pub fn status_payload(&self) -> Value {
        match self.status.read() {
            Ok(status) => json!({
                "running": status.running,
                "queued": self.queued_requests.load(Ordering::SeqCst) > 0,
                "queuedRequests": self.queued_requests.load(Ordering::SeqCst),
                "mode": status.mode,
                "progressCurrent": status.progress_current,
                "progressTotal": status.progress_total,
                "progressPercent": status.progress_percent,
                "progressLabel": status.progress_label,
                "lastStartedAt": status.last_started_at,
                "lastFinishedAt": status.last_finished_at,
                "lastError": status.last_error,
                "autoRefreshActive": status.auto_refresh_active,
                "lastScheduledRefreshAt": status.last_scheduled_refresh_at,
                "intervalMinutes": self.settings.auto_refresh_interval_mins,
                "marketOpenHourBerlin": self.settings.market_open_hour_cet,
                "marketCloseHourBerlin": self.settings.market_close_hour_cet,
                "liveEnabled": self.settings.enabled && !self.settings.no_live_enrichment,
            }),
            Err(_) => json!({
                "running": false,
                "lastError": "structured products refresh status lock poisoned",
            }),
        }
    }

    pub async fn market_open(&self) -> bool {
        market_calendar::is_xetra_trading_day(market_calendar::berlin_now().date_naive()).await
            && market_calendar::current_cet_hour() >= self.settings.market_open_hour_cet
            && market_calendar::current_cet_hour() < self.settings.market_close_hour_cet
    }

    async fn refresh(
        &self,
        summary: PortfolioSummaryResponse,
        reason: &'static str,
        mode: RefreshMode,
    ) -> anyhow::Result<()> {
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

    fn temporary_output_paths(&self) -> anyhow::Result<TemporaryOutputPaths> {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        let suffix = format!("{}-{timestamp}", std::process::id());
        let output_dir = self
            .output_json_path
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| PathBuf::from("."));
        let csv_dir = self
            .output_csv_path
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| PathBuf::from("."));

        Ok(TemporaryOutputPaths {
            enrichment_json: output_dir
                .join(format!(".structured-products-enrichment-{suffix}.json")),
            risk_json: output_dir.join(format!(".structured-products-risk-{suffix}.json")),
            csv: csv_dir.join(format!(".structured-products-enrichment-{suffix}.csv")),
        })
    }

    async fn export_temporary_outputs(&self, paths: &TemporaryOutputPaths) -> anyhow::Result<()> {
        if let Some(parent) = self.output_json_path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        if let Some(parent) = self.risk_json_path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        if let Some(parent) = self.output_csv_path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }

        tokio::fs::copy(&paths.enrichment_json, &self.output_json_path).await?;
        tokio::fs::copy(&paths.risk_json, &self.risk_json_path).await?;
        tokio::fs::copy(&paths.csv, &self.output_csv_path).await?;
        self.cleanup_temporary_outputs(paths).await;
        Ok(())
    }

    async fn cleanup_temporary_outputs(&self, paths: &TemporaryOutputPaths) {
        let _ = tokio::fs::remove_file(&paths.enrichment_json).await;
        let _ = tokio::fs::remove_file(&paths.risk_json).await;
        let _ = tokio::fs::remove_file(&paths.csv).await;
    }

    async fn run_generator(
        &self,
        summary_path: &Path,
        reason: &'static str,
        mode: RefreshMode,
    ) -> anyhow::Result<()> {
        let output_paths = self.temporary_output_paths()?;

        if let Some(parent) = self.output_json_path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        if let Some(parent) = self.risk_json_path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        if let Some(parent) = self.output_csv_path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        if let Some(parent) = self.output_db_path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        tokio::fs::create_dir_all(&self.uv_cache_path).await?;
        tokio::fs::create_dir_all(&self.playwright_browsers_path).await?;

        let command_path =
            resolve_command_path(&self.settings.command, &self.settings.working_dir)?;
        let mut command = Command::new(&command_path);
        command.current_dir(&self.settings.working_dir);
        if command_uses_uv(&self.settings.command) {
            command
                .env("UV_CACHE_DIR", &self.uv_cache_path)
                .env("PLAYWRIGHT_BROWSERS_PATH", &self.playwright_browsers_path)
                .arg("run")
                .arg("agent-foundry-structured-products");
        }

        command
            .arg("--summary-json")
            .arg(summary_path)
            .arg("--csv")
            .arg(&output_paths.csv)
            .arg("--json")
            .arg(&output_paths.enrichment_json)
            .arg("--risk-json")
            .arg(&output_paths.risk_json)
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
            output = %output_paths.enrichment_json.display(),
            "starting structured products enrichment refresh"
        );
        command.stdout(std::process::Stdio::piped());
        command.stderr(std::process::Stdio::piped());
        command.kill_on_drop(true);
        let mut child = command.spawn().map_err(|error| {
            anyhow!(
                "failed to spawn structured products generator command={} workdir={} ({error})",
                self.settings.command,
                self.settings.working_dir.display(),
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

        let status = match tokio::time::timeout(Duration::from_secs(1800), child.wait()).await {
            Ok(status) => status?,
            Err(_) => {
                let _ = child.kill().await;
                stdout_task.abort();
                stderr_task.abort();
                self.cleanup_temporary_outputs(&output_paths).await;
                return Err(anyhow!(
                    "structured products generator exceeded 30 minute deadline"
                ));
            }
        };
        let stdout = stdout_task
            .await
            .context("structured products stdout reader task failed")??;
        let stderr = stderr_task
            .await
            .context("structured products stderr reader task failed")??;

        if !status.success() {
            self.cleanup_temporary_outputs(&output_paths).await;
            return Err(anyhow!(
                "structured products generator exited with {status}: {stderr}",
            ));
        }
        if !stderr.trim().is_empty() {
            warn!(
                reason,
                stderr = %stderr.trim(),
                "structured products generator reported warnings"
            );
        }

        let payload_json = tokio::fs::read_to_string(&output_paths.enrichment_json)
            .await
            .with_context(|| {
                format!(
                    "failed to read structured products output {}",
                    output_paths.enrichment_json.display()
                )
            })?;
        self.market_data_repository
            .store_payload(
                STRUCTURED_PRODUCTS_PAYLOAD_KEY,
                &payload_json,
                &chrono::Utc::now().to_rfc3339(),
            )
            .await
            .context("failed to persist structured products realtime payload")?;

        let risk_payload_json = tokio::fs::read_to_string(&output_paths.risk_json)
            .await
            .with_context(|| {
                format!(
                    "failed to read structured products risk output {}",
                    output_paths.risk_json.display()
                )
            })?;
        self.market_data_repository
            .store_payload(
                STRUCTURED_PRODUCTS_RISK_PAYLOAD_KEY,
                &risk_payload_json,
                &chrono::Utc::now().to_rfc3339(),
            )
            .await
            .context("failed to persist structured products risk payload")?;

        if self.settings.export_files {
            self.export_temporary_outputs(&output_paths).await?;
        } else {
            self.cleanup_temporary_outputs(&output_paths).await;
        }

        info!(
            reason,
            output = %output_paths.enrichment_json.display(),
            risk_output = %output_paths.risk_json.display(),
            exported = self.settings.export_files,
            stdout = %stdout.trim(),
            "structured products enrichment refresh finished"
        );
        Ok(())
    }

    fn empty_enrichment_payload(&self, read_error: Option<String>) -> Value {
        json!({
            "source": "rust_backend_structured_products_service",
            "count": 0,
            "items": [],
            "read_error": read_error,
            "path": self.output_json_path.display().to_string(),
        })
    }

    fn payload_with_read_error(&self, mut fallback: Value, read_error: String) -> Value {
        match &mut fallback {
            Value::Object(map) => {
                map.insert("read_error".to_owned(), Value::String(read_error));
                fallback
            }
            Value::Array(_) => fallback,
            _ => json!({ "read_error": read_error }),
        }
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

    fn set_auto_refresh_active(&self, active: bool) {
        if let Ok(mut status) = self.status.write() {
            status.auto_refresh_active = active;
        }
    }

    fn set_last_scheduled_refresh_at(&self) {
        if let Ok(mut status) = self.status.write() {
            status.last_scheduled_refresh_at = Some(chrono::Utc::now().to_rfc3339());
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

impl RefreshRequest {
    fn coalesce(self, next: Self) -> Self {
        let mode = if self.mode == RefreshMode::Live || next.mode == RefreshMode::Live {
            RefreshMode::Live
        } else {
            RefreshMode::FallbackOnly
        };

        Self {
            summary: next.summary,
            reason: next.reason,
            mode,
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

fn resolve_command_path(command: &str, working_dir: &Path) -> anyhow::Result<PathBuf> {
    let path = Path::new(command);
    if path.is_absolute() || path.components().count() == 1 {
        return Ok(path.to_path_buf());
    }

    absolute_path(&working_dir.join(path))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::portfolio::{Dividend, DividendSummary, SourceInfo, Summary};

    #[test]
    fn coalescing_keeps_latest_summary_and_strongest_refresh_mode() {
        let merged = RefreshRequest {
            summary: empty_summary("older"),
            reason: "scheduled",
            mode: RefreshMode::Live,
        }
        .coalesce(RefreshRequest {
            summary: empty_summary("newer"),
            reason: "upload_data_success",
            mode: RefreshMode::FallbackOnly,
        });

        assert_eq!(merged.summary.generated_at, "newer");
        assert_eq!(merged.reason, "upload_data_success");
        assert_eq!(merged.mode, RefreshMode::Live);
    }

    fn empty_summary(generated_at: &str) -> PortfolioSummaryResponse {
        PortfolioSummaryResponse {
            generated_at: generated_at.to_owned(),
            source: SourceInfo {
                csv: String::new(),
                pdf: String::new(),
                pdf_text: None,
                isin_name_matches: 0,
                rows: 0,
                first_date: None,
                last_date: None,
            },
            summary: Summary::default(),
            allocation: Vec::new(),
            positions: Vec::new(),
            monthly: Vec::new(),
            dividend: Dividend {
                summary: DividendSummary::default(),
                monthly: Vec::new(),
                top_symbols: Vec::new(),
                records: Vec::new(),
            },
            recent_transactions: Vec::new(),
        }
    }
}
