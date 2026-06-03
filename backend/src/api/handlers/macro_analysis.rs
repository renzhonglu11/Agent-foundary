use axum::{Json, extract::State};
use serde_json::{Value, json};
use std::{path::PathBuf, sync::Arc};
use tokio::process::Command;
use tracing::{info, warn};

use crate::{api::error::ApiError, app_state::AppState};

fn macro_analysis_path() -> PathBuf {
    std::env::var("MACRO_ANALYSIS_PATH")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("data/macro-analysis.json"))
}

fn macro_analysis_script_path() -> PathBuf {
    std::env::var("MACRO_ANALYSIS_SCRIPT")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("backend/python/scripts/generate_macro_analysis.py"))
}

fn macro_analysis_python() -> String {
    std::env::var("MACRO_ANALYSIS_PYTHON")
        .or_else(|_| std::env::var("PYTHON_BIN"))
        .unwrap_or_else(|_| "backend/python/.venv/bin/python".to_owned())
}

/// Serves the pre-generated macroeconomic analysis and dynamic Reddit trending tickers JSON.
pub async fn get_macro_analysis(State(state): State<Arc<AppState>>) -> Json<Value> {
    // 1. Read the pre-generated macroeconomic commentary JSON cache from disk
    let mut macro_payload = match tokio::fs::read_to_string(macro_analysis_path()).await {
        Ok(content) => match serde_json::from_str::<Value>(&content) {
            Ok(payload) => payload,
            Err(error) => {
                warn!(%error, "Failed to parse macro-analysis.json cache");
                fallback_payload(Some(error.to_string()))
            }
        },
        Err(error) => {
            warn!(%error, "Failed to read macro-analysis.json cache");
            fallback_payload(Some(error.to_string()))
        }
    };

    // 2. Fetch the ApeWisdom Reddit trends from in-memory cache
    let reddit_trends = match state.ape_wisdom_service.get_cached_trends() {
        Some(trends) => serde_json::to_value(trends).unwrap_or(json!({
            "stocks": [],
            "wallstreetbetsnew": [],
            "updated_at": chrono::Utc::now().to_rfc3339()
        })),
        None => json!({
            "stocks": [],
            "wallstreetbetsnew": [],
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

        // Then trigger python generator
        let mut command = Command::new(macro_analysis_python());
        command.arg(macro_analysis_script_path());

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
fn fallback_payload(error: Option<String>) -> Value {
    json!({
        "analysis_date": chrono::Utc::now().to_rfc3339(),
        "summary_commentary": "无法读取当前的宏观经济分析，请确认定时任务已成功运行或通过后台触发刷新。",
        "sectors": [
            {
                "title": "🚀 高科技 & 成长板块 (Tech & Growth)",
                "impact": "暂缺",
                "reason": "暂无宏观数据缓存。",
                "suggestion": "请点击右上角手动触发刷新。"
            },
            {
                "title": "🏦 银行 & 金融板块 (Financials)",
                "impact": "暂缺",
                "reason": "暂无宏观数据缓存。",
                "suggestion": "请点击右上角手动触发刷新。"
            },
            {
                "title": "🔌 公用事业 & 房托地产 (Utilities & REITs)",
                "impact": "暂缺",
                "reason": "暂无宏观数据缓存。",
                "suggestion": "请点击右上角手动触发刷新。"
            },
            {
                "title": "🛢️ 能源 & 大宗商品 (Energy & Materials)",
                "impact": "暂缺",
                "reason": "暂无宏观数据缓存。",
                "suggestion": "请点击右上角手动触发刷新。"
            }
        ],
        "reddit_trending": {
            "stocks": [],
            "wallstreetbetsnew": [],
            "updated_at": chrono::Utc::now().to_rfc3339()
        },
        "read_error": error
    })
}
