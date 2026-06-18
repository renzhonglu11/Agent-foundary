use axum::{Json, extract::State};
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
};
use tokio::process::Command;
use tracing::{info, warn};

use crate::{api::error::ApiError, app_state::AppState};

fn macro_analysis_path() -> PathBuf {
    std::env::var("MACRO_ANALYSIS_PATH")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("data/macro-analysis.json"))
}

fn macro_analysis_command() -> String {
    std::env::var("MACRO_ANALYSIS_COMMAND")
        .unwrap_or_else(|_| "backend/python/.venv/bin/agent-foundry-macro-analysis".to_owned())
}

fn hermes_path() -> PathBuf {
    std::env::var("HERMES_PATH")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            std::env::var("HOME")
                .map(|home| PathBuf::from(home).join(".local/bin/hermes"))
                .unwrap_or_else(|_| PathBuf::from("hermes"))
        })
}

fn executable_available(path: &Path) -> bool {
    let raw_path = path.to_string_lossy();
    if path.is_absolute() || raw_path.contains('/') {
        return path.is_file();
    }

    std::env::var_os("PATH")
        .map(|paths| std::env::split_paths(&paths).any(|dir| dir.join(path).is_file()))
        .unwrap_or(false)
}

fn hermes_available() -> bool {
    executable_available(&hermes_path())
}

fn mark_ai_commentary_unavailable(payload: &mut Value) {
    if let Some(obj) = payload.as_object_mut() {
        if !obj.contains_key("summary_commentary") {
            obj.insert("ai_commentary_available".to_string(), json!(false));
            obj.insert(
                "ai_commentary_unavailable_reason".to_string(),
                json!("Hermes executable is not available in this environment"),
            );
        }
    }
}

/// Serves the pre-generated macroeconomic analysis and dynamic Reddit trending tickers JSON.
pub async fn get_macro_analysis(State(state): State<Arc<AppState>>) -> Json<Value> {
    let ai_commentary_available = hermes_available();

    // 1. Read the pre-generated macroeconomic commentary JSON cache from disk
    let mut macro_payload = match tokio::fs::read_to_string(macro_analysis_path()).await {
        Ok(content) => match serde_json::from_str::<Value>(&content) {
            Ok(payload) => payload,
            Err(error) => {
                warn!(%error, "Failed to parse macro-analysis.json cache");
                fallback_payload(Some(error.to_string()), ai_commentary_available)
            }
        },
        Err(error) => {
            warn!(%error, "Failed to read macro-analysis.json cache");
            fallback_payload(Some(error.to_string()), ai_commentary_available)
        }
    };

    if ai_commentary_available {
        if let Some(obj) = macro_payload.as_object_mut() {
            obj.insert("ai_commentary_available".to_string(), json!(true));
        }
    } else {
        mark_ai_commentary_unavailable(&mut macro_payload);
    }

    // 2. Fetch the ApeWisdom Reddit trends from in-memory cache
    let reddit_trends = match state.ape_wisdom_service.get_cached_trends() {
        Some(trends) => serde_json::to_value(trends).unwrap_or(json!({
            "stocks": [],
            "wallstreetbets": [],
            "updated_at": chrono::Utc::now().to_rfc3339()
        })),
        None => json!({
            "stocks": [],
            "wallstreetbets": [],
            "updated_at": chrono::Utc::now().to_rfc3339()
        }),
    };

    // 3. Dynamically merge them by replacing or inserting the "reddit_trending" key
    if let Some(obj) = macro_payload.as_object_mut() {
        obj.insert("reddit_trending".to_string(), reddit_trends);
    }

    Json(macro_payload)
}

/// Asynchronously spawns a concurrent background refresh of both the ApeWisdom cache and macro commentary.
pub async fn refresh_macro_analysis(
    State(state): State<Arc<AppState>>,
) -> Result<Json<Value>, ApiError> {
    info!("Triggering macroeconomic analysis manual refresh in background");

    let state_clone = state.clone();
    // Spawn script and refresh in background to avoid holding the HTTP thread
    tokio::spawn(async move {
        // First trigger an immediate ApeWisdom fetch concurrently
        info!("Concurrently triggering manual ApeWisdom fetch");
        if let Err(error) = state_clone
            .ape_wisdom_service
            .fetch_and_update_cache()
            .await
        {
            warn!(%error, "Failed to manually fetch ApeWisdom trends");
        } else {
            info!("Manual ApeWisdom fetch completed successfully");
        }

        if !hermes_available() {
            warn!("Skipping macroeconomic AI refresh because Hermes is not available");
            return;
        }

        // Then trigger python generator
        let mut command = Command::new(macro_analysis_command());

        match command.spawn() {
            Ok(mut child) => match child.wait().await {
                Ok(status) => {
                    if status.success() {
                        info!("Manual macroeconomic analysis refresh completed successfully");
                    } else {
                        warn!(
                            "Manual macroeconomic analysis refresh failed with exit code: {:?}",
                            status.code()
                        );
                    }
                }
                Err(error) => {
                    warn!(%error, "Error waiting for macroeconomic analysis generator child process");
                }
            },
            Err(error) => {
                warn!(%error, "Failed to spawn macroeconomic analysis generator process");
            }
        }
    });

    Ok(Json(json!({
        "ok": true,
        "status": "started",
        "message": "Macroeconomic analysis and ApeWisdom trends refresh triggered in the background"
    })))
}

/// Fallback payload in case of file missing or parse errors.
fn fallback_payload(error: Option<String>, ai_commentary_available: bool) -> Value {
    json!({
        "analysis_date": chrono::Utc::now().to_rfc3339(),
        "ai_commentary_available": ai_commentary_available,
        "reddit_trending": {
            "stocks": [],
            "wallstreetbets": [],
            "updated_at": chrono::Utc::now().to_rfc3339()
        },
        "read_error": error
    })
}
