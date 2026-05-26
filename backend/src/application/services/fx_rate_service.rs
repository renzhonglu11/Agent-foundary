use std::sync::Arc;

use chrono::{DateTime, Utc};
use serde::Deserialize;
use tracing::{info, warn};

use crate::{
    application::ports::fx_rate_cache::{FxRateCache, FxRateCacheEntry},
    config::FxRateSettings,
};

const FRANKFURTER_V1_USD_LATEST_URL: &str = "https://api.frankfurter.dev/v1/latest?base=USD";

#[derive(Clone)]
pub struct FxRateService {
    cache: Arc<dyn FxRateCache>,
    settings: FxRateSettings,
    client: reqwest::Client,
}

#[derive(Debug, Clone)]
pub struct FxRate {
    pub base_currency: String,
    pub quote_currency: String,
    pub rate: f64,
    pub source: String,
    pub fetched_at: DateTime<Utc>,
    pub cached: bool,
}

#[derive(Debug, Deserialize)]
struct FrankfurterLatestResponse {
    rates: std::collections::HashMap<String, f64>,
}

impl FxRateService {
    pub fn new(cache: Arc<dyn FxRateCache>, settings: FxRateSettings) -> Self {
        Self {
            cache,
            settings,
            client: reqwest::Client::new(),
        }
    }

    pub async fn usd_eur_rate(&self) -> FxRate {
        if let Some(rate) = self.cached_usd_eur_rate().await {
            return rate;
        }

        if !self.settings.enabled {
            return self.fallback_rate("fx_rates_disabled");
        }

        match self.fetch_frankfurter_usd_eur_rate().await {
            Ok(rate) => {
                if let Err(error) = self.store_rate(&rate).await {
                    warn!(%error, "failed to persist USD/EUR FX rate");
                }
                rate
            }
            Err(error) => {
                warn!(%error, "failed to fetch USD/EUR FX rate from Frankfurter; using fallback");
                self.fallback_rate("fallback_env")
            }
        }
    }

    async fn cached_usd_eur_rate(&self) -> Option<FxRate> {
        let cached_rate = match self.cache.get_rate("USD", "EUR").await {
            Ok(Some(rate)) => rate,
            Ok(None) => return None,
            Err(error) => {
                warn!(%error, "failed to load cached USD/EUR FX rate");
                return None;
            }
        };

        let age_seconds = Utc::now()
            .signed_duration_since(cached_rate.fetched_at)
            .num_seconds()
            .max(0) as u64;
        if age_seconds > self.settings.cache_ttl_seconds {
            return None;
        }

        let rate = FxRate {
            base_currency: cached_rate.base_currency,
            quote_currency: cached_rate.quote_currency,
            rate: cached_rate.rate,
            source: cached_rate.source,
            fetched_at: cached_rate.fetched_at,
            cached: true,
        };

        info!(
            rate = rate.rate,
            fetched_at = %rate.fetched_at,
            age_seconds,
            "using cached USD/EUR FX rate"
        );

        Some(rate)
    }

    async fn fetch_frankfurter_usd_eur_rate(&self) -> anyhow::Result<FxRate> {
        match self
            .fetch_frankfurter_endpoint(&self.settings.endpoint)
            .await
        {
            Ok(rate) => Ok(rate),
            Err(primary_error)
                if self.settings.endpoint.as_str() != FRANKFURTER_V1_USD_LATEST_URL =>
            {
                warn!(
                    %primary_error,
                    endpoint = %self.settings.endpoint,
                    fallback_endpoint = FRANKFURTER_V1_USD_LATEST_URL,
                    "Frankfurter primary endpoint failed; trying v1 fallback"
                );
                self.fetch_frankfurter_endpoint(FRANKFURTER_V1_USD_LATEST_URL)
                    .await
            }
            Err(error) => Err(error),
        }
    }

    async fn fetch_frankfurter_endpoint(&self, endpoint: &str) -> anyhow::Result<FxRate> {
        let payload = self
            .client
            .get(endpoint)
            .send()
            .await?
            .error_for_status()?
            .json::<FrankfurterLatestResponse>()
            .await?;
        let Some(rate) = payload.rates.get("EUR").copied() else {
            anyhow::bail!("Frankfurter response did not include EUR rate");
        };

        info!(rate, endpoint, "fetched USD/EUR FX rate from Frankfurter");

        Ok(FxRate {
            base_currency: "USD".to_owned(),
            quote_currency: "EUR".to_owned(),
            rate,
            source: "frankfurter".to_owned(),
            fetched_at: Utc::now(),
            cached: false,
        })
    }

    async fn store_rate(&self, rate: &FxRate) -> anyhow::Result<()> {
        self.cache
            .store_rate(&FxRateCacheEntry {
                base_currency: rate.base_currency.clone(),
                quote_currency: rate.quote_currency.clone(),
                rate: rate.rate,
                source: rate.source.clone(),
                fetched_at: rate.fetched_at,
            })
            .await
    }

    fn fallback_rate(&self, source: &str) -> FxRate {
        FxRate {
            base_currency: "USD".to_owned(),
            quote_currency: "EUR".to_owned(),
            rate: self.settings.fallback_usd_eur_rate,
            source: source.to_owned(),
            fetched_at: Utc::now(),
            cached: false,
        }
    }
}
