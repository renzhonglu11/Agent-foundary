use super::provider_access::ProviderAccess;
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::{
    sync::{Arc, RwLock},
    time::Duration,
};
use tokio::time::sleep;
use tracing::{info, warn};

const REDDIT_TRENDS_PATH: &str = "data/reddit-trends.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RedditTicker {
    pub rank: i32,
    pub ticker: String,
    pub name: String,
    pub mentions: i32,
    #[serde(default)]
    pub upvotes: i32,
    #[serde(default)]
    pub rank_24h_ago: Option<i32>,
    #[serde(default)]
    pub mentions_24h_ago: Option<i32>,
    #[serde(default)]
    pub mentions_change_pct: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RedditTrendingPayload {
    pub stocks: Vec<RedditTicker>,
    #[serde(default, alias = "wallstreetbetsnew")]
    pub wallstreetbets: Vec<RedditTicker>,
    pub updated_at: String,
}

#[derive(Debug, Deserialize)]
struct ApeWisdomApiResponse {
    results: Vec<ApeWisdomApiTicker>,
}

#[derive(Debug, Deserialize)]
struct ApeWisdomApiTicker {
    rank: i32,
    ticker: String,
    name: String,
    mentions: i32,
    #[serde(default)]
    upvotes: i32,
    rank_24h_ago: Option<i32>,
    mentions_24h_ago: Option<i32>,
}

#[derive(Clone)]
pub struct ApeWisdomService {
    access: ProviderAccess,
    endpoint: String,
    cache_path: std::path::PathBuf,
    refresh_lock: Arc<tokio::sync::Mutex<()>>,
    cache: Arc<RwLock<Option<RedditTrendingPayload>>>,
}

impl ApeWisdomService {
    pub fn new(access: ProviderAccess) -> Self {
        Self {
            access,
            endpoint: "https://apewisdom.io/api/v1.0/filter".into(),
            cache_path: REDDIT_TRENDS_PATH.into(),
            refresh_lock: Arc::new(tokio::sync::Mutex::new(())),
            cache: Arc::new(RwLock::new(None)),
        }
    }

    /// Loads the cache from the local JSON file on startup to prevent initial delay.
    pub async fn load_cache_from_file(&self) -> Result<()> {
        if tokio::fs::metadata(&self.cache_path).await.is_ok() {
            let content = tokio::fs::read_to_string(&self.cache_path).await?;
            let payload: RedditTrendingPayload = serde_json::from_str(&content)?;
            if let Ok(mut cache) = self.cache.write() {
                *cache = Some(payload);
                info!("ApeWisdom cache successfully loaded and warmed from local file");
            }
        } else {
            info!(
                "No pre-existing ApeWisdom cache file found, cache will be warmed on first API poll"
            );
        }
        Ok(())
    }

    /// Spawns the background 5-minute polling loop.
    pub fn start_polling_in_background(&self) {
        let service = self.clone();
        tokio::spawn(async move {
            info!("Starting background ApeWisdom polling loop...");

            // Wait 2 seconds on startup before first poll to avoid blocking main thread initialization
            sleep(Duration::from_secs(2)).await;

            loop {
                info!("Polling ApeWisdom Reddit trends from API in background...");
                match service.fetch_and_update_cache().await {
                    Ok(_) => {
                        info!("ApeWisdom background poll completed successfully");
                    }
                    Err(error) => {
                        warn!(%error, "Failed to poll ApeWisdom background data");
                    }
                }

                // Sleep for 5 minutes
                sleep(Duration::from_secs(300)).await;
            }
        });
    }

    /// Fetches live data from ApeWisdom for both subreddits and updates the cache & JSON file.
    pub async fn fetch_and_update_cache(&self) -> Result<RedditTrendingPayload> {
        let _refresh = self.refresh_lock.lock().await;
        if let Some(cached) = self.get_cached_trends() {
            if chrono::DateTime::parse_from_rfc3339(&cached.updated_at).is_ok_and(|at| {
                let age = chrono::Utc::now().signed_duration_since(at);
                age.num_seconds() >= 0 && age.num_seconds() < 300
            }) {
                return Ok(cached);
            }
        }
        let stocks = self
            .fetch_subreddit("stocks")
            .await
            .context("failed to fetch r/stocks trends from ApeWisdom")?;

        let wallstreetbets = self
            .fetch_subreddit("wallstreetbets")
            .await
            .context("failed to fetch r/wallstreetbets trends from ApeWisdom")?;

        let payload = RedditTrendingPayload {
            stocks,
            wallstreetbets,
            updated_at: chrono::Utc::now().to_rfc3339(),
        };

        // Update RAM cache
        if let Ok(mut cache) = self.cache.write() {
            *cache = Some(payload.clone());
        }

        // Persist to local JSON file
        if let Err(error) = self.save_payload_to_file(&payload).await {
            warn!(%error, "Failed to persist ApeWisdom payload to local file");
        }

        Ok(payload)
    }

    /// Gets the currently cached trending tickers, or falls back to reading the file / returning None.
    pub fn get_cached_trends(&self) -> Option<RedditTrendingPayload> {
        if let Ok(cache) = self.cache.read() {
            if let Some(ref payload) = *cache {
                return Some(payload.clone());
            }
        }
        None
    }

    async fn fetch_subreddit(&self, subreddit: &str) -> Result<Vec<RedditTicker>> {
        let url = format!("{}/{subreddit}", self.endpoint);
        let api_data: ApeWisdomApiResponse = self
            .access
            .json("apewisdom.io", subreddit, |client| client.get(url))
            .await?;

        // Take top 10 tickers
        let mut tickers = Vec::new();
        for r in api_data.results.into_iter().take(10) {
            tickers.push(RedditTicker {
                rank: r.rank,
                ticker: r.ticker,
                name: r.name,
                mentions: r.mentions,
                upvotes: r.upvotes,
                rank_24h_ago: r.rank_24h_ago,
                mentions_24h_ago: r.mentions_24h_ago,
                mentions_change_pct: mentions_change_pct(r.mentions, r.mentions_24h_ago),
            });
        }

        Ok(tickers)
    }

    async fn save_payload_to_file(&self, payload: &RedditTrendingPayload) -> Result<()> {
        let json_str = serde_json::to_string_pretty(payload)?;
        if let Some(parent) = self.cache_path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        tokio::fs::write(&self.cache_path, json_str).await?;
        Ok(())
    }
}

fn mentions_change_pct(current_mentions: i32, mentions_24h_ago: Option<i32>) -> Option<f64> {
    let previous_mentions = mentions_24h_ago?;

    if previous_mentions <= 0 {
        return None;
    }

    Some(((current_mentions - previous_mentions) as f64 / previous_mentions as f64) * 100.0)
}

#[cfg(test)]
mod tests {
    use super::ApeWisdomService;
    use super::{RedditTrendingPayload, mentions_change_pct};
    use crate::services::{
        provider_access::ProviderAccess,
        provider_test_support::{MockHttp, database},
    };

    #[tokio::test]
    async fn manual_and_background_callers_share_cache_and_cooldown() -> anyhow::Result<()> {
        let server = MockHttp::start(200, "{\"results\":[]}", None).await?;
        let access = ProviderAccess::from_pool(database().await?, 0.0).await?;
        let mut service = ApeWisdomService::new(access.clone());
        service.endpoint = server.url.clone();
        let temp = tempfile::tempdir()?;
        service.cache_path = temp.path().join("trends.json");
        let (first, second) = tokio::join!(
            service.fetch_and_update_cache(),
            service.fetch_and_update_cache()
        );
        assert!(first.is_ok() && second.is_ok());
        assert_eq!(server.hits(), 2);
        // Use a fresh instance without a success cache to exercise refusal.
        let mut restarted = ApeWisdomService::new(access);
        restarted.endpoint = server.url.clone();
        restarted.cache_path = temp.path().join("trends.json");
        server
            .status
            .store(403, std::sync::atomic::Ordering::SeqCst);
        assert!(restarted.fetch_and_update_cache().await.is_err());
        assert!(restarted.fetch_and_update_cache().await.is_err());
        assert_eq!(server.hits(), 3);
        Ok(())
    }

    #[test]
    fn calculates_positive_mentions_change_pct() {
        let Some(change_pct) = mentions_change_pct(32, Some(19)) else {
            panic!("expected available mentions change percentage");
        };

        assert!((change_pct - 68.421_052_631_578_95).abs() < f64::EPSILON);
    }

    #[test]
    fn calculates_negative_mentions_change_pct() {
        let Some(change_pct) = mentions_change_pct(14, Some(19)) else {
            panic!("expected available mentions change percentage");
        };

        assert!((change_pct + 26.315_789_473_684_21).abs() < f64::EPSILON);
    }

    #[test]
    fn treats_matching_previous_mentions_as_zero_change() {
        assert_eq!(mentions_change_pct(1, Some(1)), Some(0.0));
    }

    #[test]
    fn treats_missing_previous_mentions_as_unavailable_change() {
        assert_eq!(mentions_change_pct(10, None), None);
    }

    #[test]
    fn treats_zero_previous_mentions_as_unavailable_change() {
        assert_eq!(mentions_change_pct(10, Some(0)), None);
    }

    #[test]
    fn reads_legacy_wallstreetbetsnew_cache_key_as_wallstreetbets() {
        let payload = serde_json::from_str::<RedditTrendingPayload>(
            r#"{
                "stocks": [],
                "wallstreetbetsnew": [
                    {
                        "rank": 1,
                        "ticker": "MSFT",
                        "name": "Microsoft",
                        "mentions": 1,
                        "mentions_change_pct": null
                    }
                ],
                "updated_at": "2026-06-03T00:00:00Z"
            }"#,
        );

        let Ok(payload) = payload else {
            panic!("expected legacy reddit trends cache to deserialize");
        };

        assert_eq!(payload.wallstreetbets.len(), 1);
        assert_eq!(payload.wallstreetbets[0].ticker, "MSFT");
    }
}
