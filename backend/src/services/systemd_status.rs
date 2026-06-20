//! systemd unit status — queries `systemctl` for the app's own units.
//!
//! Gracefully handles missing systemd (WSL, Docker, macOS) by returning an
//! `available: false` payload instead of failing.

use serde::Serialize;
use tokio::process::Command;
use tracing::warn;

/// Units that belong to this project.
const PROJECT_UNITS: &[(&str, &str)] = &[
    ("agent-foundry-backend.service", "Backend 服务"),
    ("agent-foundry-hermes-cron-sync.service", "Hermes Cron 同步"),
    (
        "agent-foundry-hermes-cron-sync.path",
        "Hermes Cron 文件监控",
    ),
];

// ---------------------------------------------------------------------------
// Public type
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemdStatus {
    pub available: bool,
    pub generated_at: String,
    pub units: Vec<SystemdUnit>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemdUnit {
    pub unit: String,
    pub label: String,
    pub load_state: String,
    pub active_state: String,
    pub unit_state: String,
    pub enabled_state: String,
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

#[derive(Clone, Default)]
pub struct SystemdStatusService;

impl SystemdStatusService {
    pub fn new() -> Self {
        Self
    }

    pub async fn status(&self) -> SystemdStatus {
        match probe_systemd().await {
            Ok(()) => build_systemd_status().await,
            Err(error) => SystemdStatus {
                available: false,
                generated_at: chrono::Utc::now().to_rfc3339(),
                units: Vec::new(),
                error: Some(error),
            },
        }
    }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async fn probe_systemd() -> Result<(), String> {
    match Command::new("systemctl").arg("--version").output().await {
        Ok(output) if output.status.success() => Ok(()),
        Ok(output) => Err(format!("systemctl --version exited with {}", output.status)),
        Err(error) => Err(format!("systemctl not available: {error}")),
    }
}

async fn build_systemd_status() -> SystemdStatus {
    let mut units = Vec::with_capacity(PROJECT_UNITS.len());

    for (unit_name, label) in PROJECT_UNITS {
        let (load_state, active_state, unit_state) = systemctl_show(unit_name).await;
        let enabled_state = systemctl_is_enabled(unit_name).await;
        units.push(SystemdUnit {
            unit: (*unit_name).to_owned(),
            label: (*label).to_owned(),
            load_state,
            active_state,
            unit_state,
            enabled_state,
        });
    }

    SystemdStatus {
        available: true,
        generated_at: chrono::Utc::now().to_rfc3339(),
        units,
        error: None,
    }
}

/// Run `systemctl show` for service state.
/// Returns (load_state, active_state, unit_file_state).
async fn systemctl_show(unit: &str) -> (String, String, String) {
    let mut load = "unknown".to_owned();
    let mut active = "unknown".to_owned();
    let mut state = "unknown".to_owned();

    let result = Command::new("systemctl")
        .args([
            "show",
            "-p",
            "LoadState",
            "-p",
            "ActiveState",
            "-p",
            "UnitFileState",
            unit,
        ])
        .output()
        .await;

    match result {
        Ok(output) if output.status.success() => {
            let text = String::from_utf8_lossy(&output.stdout);
            for line in text.lines() {
                let Some((key, value)) = line.trim().split_once('=') else {
                    continue;
                };
                match key {
                    "LoadState" => load = value.to_owned(),
                    "ActiveState" => active = value.to_owned(),
                    "UnitFileState" => state = value.to_owned(),
                    _ => {}
                }
            }
            if load == "not-found" {
                active = "not-found".to_owned();
                state = "not-found".to_owned();
            }
        }
        Ok(output) => {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
            if stderr.contains("not found") || stderr.contains("No such file") {
                load = "not-found".to_owned();
                active = "not-found".to_owned();
                state = "not-found".to_owned();
            } else {
                warn!(%unit, %stderr, "systemctl show failed");
                load = "error".to_owned();
                active = "error".to_owned();
                state = "error".to_owned();
            }
        }
        Err(error) => {
            warn!(%unit, %error, "failed to run systemctl show");
            load = "error".to_owned();
            active = "error".to_owned();
            state = "error".to_owned();
        }
    }

    (load, active, state)
}

/// Run `systemctl is-enabled <unit>` — simpler, returns a single word.
async fn systemctl_is_enabled(unit: &str) -> String {
    match Command::new("systemctl")
        .args(["is-enabled", unit])
        .output()
        .await
    {
        Ok(output) => {
            let text = String::from_utf8_lossy(&output.stdout).trim().to_owned();
            if text.is_empty() {
                "not-found".to_owned()
            } else {
                text
            }
        }
        Err(_) => "error".to_owned(),
    }
}
