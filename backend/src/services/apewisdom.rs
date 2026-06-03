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
    pub mentions_change_pct: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RedditTrendingPayload {
    pub stocks: Vec<RedditTicker>,
    pub wallstreetbetsnew: Vec<RedditTicker>,
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
    mentions_24h_ago: Option<i32>,
}

#[derive(Clone)]
pub struct ApeWisdomService {
    client: reqwest::Client,
    cache: Arc<RwLock<Option<RedditTrendingPayload>>>,
}

impl ApeWisdomService {
    pub fn new() -> Self {
        Self {
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(15))
                .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
                .build()
                .unwrap_or_else(|_| reqwest::Client::new()),
            cache: Arc::new(RwLock::new(None)),
        }
    }

    /// Loads the cache from the local JSON file on startup to prevent initial delay.
    pub async fn load_cache_from_file(&self) -> Result<()> {
        if tokio::fs::metadata(REDDIT_TRENDS_PATH).await.is_ok() {
            let content = tokio::fs::read_to_string(REDDIT_TRENDS_PATH).await?;
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
        let stocks = self
            .fetch_subreddit("stocks")
            .await
            .context("failed to fetch r/stocks trends from ApeWisdom")?;

        // Small delay to prevent hitting the API too aggressively
        sleep(Duration::from_millis(500)).await;

        let wallstreetbetsnew = self
            .fetch_subreddit("wallstreetbetsnew")
            .await
            .context("failed to fetch r/wallstreetbetsnew trends from ApeWisdom")?;

        let payload = RedditTrendingPayload {
            stocks,
            wallstreetbetsnew,
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
        let url = format!("https://apewisdom.io/api/v1.0/filter/{subreddit}");
        let response = self.client.get(&url).send().await?;

        if !response.status().is_success() {
            anyhow::bail!(
                "ApeWisdom returned HTTP {} for filter {}",
                response.status(),
                subreddit
            );
        }

        let api_data: ApeWisdomApiResponse = response.json().await?;

        // Take top 10 tickers
        let mut tickers = Vec::new();
        for r in api_data.results.into_iter().take(10) {
            tickers.push(RedditTicker {
                rank: r.rank,
                ticker: r.ticker,
                name: r.name,
                mentions: r.mentions,
                mentions_change_pct: mentions_change_pct(r.mentions, r.mentions_24h_ago),
            });
        }

        Ok(tickers)
    }

    async fn save_payload_to_file(&self, payload: &RedditTrendingPayload) -> Result<()> {
        let json_str = serde_json::to_string_pretty(payload)?;
        if let Some(parent) = std::path::Path::new(REDDIT_TRENDS_PATH).parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        tokio::fs::write(REDDIT_TRENDS_PATH, json_str).await?;
        Ok(())
    }
}

impl Default for ApeWisdomService {
    fn default() -> Self {
        Self::new()
    }
}

fn mentions_change_pct(current_mentions: i32, mentions_24h_ago: Option<i32>) -> f64 {
    let Some(previous_mentions) = mentions_24h_ago else {
        return 0.0;
    };

    if previous_mentions <= 0 {
        return 0.0;
    }

    ((current_mentions - previous_mentions) as f64 / previous_mentions as f64) * 100.0
}

#[cfg(test)]
mod tests {
    use super::mentions_change_pct;

    #[test]
    fn calculates_positive_mentions_change_pct() {
        assert!((mentions_change_pct(32, Some(19)) - 68.421_052_631_578_95).abs() < f64::EPSILON);
    }

    #[test]
    fn calculates_negative_mentions_change_pct() {
        assert!((mentions_change_pct(14, Some(19)) + 26.315_789_473_684_21).abs() < f64::EPSILON);
    }

    #[test]
    fn treats_missing_previous_mentions_as_zero_change() {
        assert_eq!(mentions_change_pct(10, None), 0.0);
    }

    #[test]
    fn treats_zero_previous_mentions_as_zero_change() {
        assert_eq!(mentions_change_pct(10, Some(0)), 0.0);
    }
}
