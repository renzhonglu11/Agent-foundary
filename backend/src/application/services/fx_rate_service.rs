use std::sync::Arc;

use chrono::{DateTime, Utc};
use serde::Deserialize;
use tracing::{info, warn};

use crate::{
    application::ports::fx_rate_cache::{FxRateCache, FxRateCacheEntry},
    config::FxRateSettings,
    services::provider_access::{ProviderAccess, ProviderRequestError},
};

const FRANKFURTER_V1_USD_LATEST_URL: &str = "https://api.frankfurter.dev/v1/latest?base=USD";

#[derive(Clone)]
pub struct FxRateService {
    cache: Arc<dyn FxRateCache>,
    settings: FxRateSettings,
    access: ProviderAccess,
    refresh_lock: Arc<tokio::sync::Mutex<()>>,
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
    pub fn new(
        cache: Arc<dyn FxRateCache>,
        settings: FxRateSettings,
        access: ProviderAccess,
    ) -> Self {
        Self {
            cache,
            settings,
            access,
            refresh_lock: Arc::new(tokio::sync::Mutex::new(())),
        }
    }

    pub async fn usd_eur_rate(&self) -> FxRate {
        if let Some(rate) = self.cached_usd_eur_rate().await {
            return rate;
        }

        if !self.settings.enabled {
            return self.fallback_rate("fx_rates_disabled");
        }

        // Coalesce a cache miss across quote batches, candidate lookups and UI.
        let _refresh = self.refresh_lock.lock().await;
        if let Some(rate) = self.cached_usd_eur_rate().await {
            return rate;
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
                if let Ok(Some(old)) = self.cache.get_rate("USD", "EUR").await {
                    if old.rate.is_finite() && old.rate > 0.0 {
                        return FxRate {
                            base_currency: old.base_currency,
                            quote_currency: old.quote_currency,
                            rate: old.rate,
                            source: "frankfurter_stale".into(),
                            fetched_at: old.fetched_at,
                            cached: true,
                        };
                    }
                }
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
                if self.settings.endpoint.as_str() != FRANKFURTER_V1_USD_LATEST_URL
                    && primary_error
                        .downcast_ref::<ProviderRequestError>()
                        .is_some_and(|e| matches!(e.status, 404 | 410)) =>
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
        let resource = if endpoint == FRANKFURTER_V1_USD_LATEST_URL {
            "USD/EUR:v1"
        } else {
            "USD/EUR:configured"
        };
        let payload: FrankfurterLatestResponse = self
            .access
            .json("api.frankfurter.dev", resource, |client| {
                client.get(endpoint)
            })
            .await?;
        let Some(rate) = payload.rates.get("EUR").copied() else {
            self.access
                .record("api.frankfurter.dev", resource, 0, None)
                .await?;
            anyhow::bail!("Frankfurter response did not include EUR rate");
        };

        if !rate.is_finite() || rate <= 0.0 {
            self.access
                .record("api.frankfurter.dev", resource, 0, None)
                .await?;
            anyhow::bail!("Frankfurter returned an invalid exchange rate");
        }
        info!(rate, "fetched USD/EUR FX rate from Frankfurter");

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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        infrastructure::db::sqlite_fx_rate_cache::SqliteFxRateCache,
        services::provider_test_support::{MockHttp, database},
    };

    async fn service(server: &MockHttp) -> anyhow::Result<(FxRateService, sqlx::SqlitePool)> {
        let pool = database().await?;
        let cache = Arc::new(SqliteFxRateCache::new(pool.clone()));
        let access = ProviderAccess::from_pool(pool.clone(), 0.0).await?;
        Ok((
            FxRateService::new(
                cache,
                FxRateSettings {
                    enabled: true,
                    endpoint: server.url.clone(),
                    cache_ttl_seconds: 3600,
                    fallback_usd_eur_rate: 0.9,
                },
                access,
            ),
            pool,
        ))
    }

    #[tokio::test]
    async fn concurrent_cache_misses_make_one_http_request() -> anyhow::Result<()> {
        let server = MockHttp::start(200, "{\"rates\":{\"EUR\":0.85}}", None).await?;
        let (service, _) = service(&server).await?;
        let mut calls = tokio::task::JoinSet::new();
        for _ in 0..8 {
            let service = service.clone();
            calls.spawn(async move { service.usd_eur_rate().await });
        }
        while let Some(result) = calls.join_next().await {
            assert_eq!(result?.rate, 0.85);
        }
        assert_eq!(server.hits(), 1);
        Ok(())
    }

    #[tokio::test]
    async fn refusal_keeps_old_rate_timestamp_and_survives_service_restart() -> anyhow::Result<()> {
        let server = MockHttp::start(429, "{}", Some("7200")).await?;
        let (service, pool) = service(&server).await?;
        let old = Utc::now() - chrono::Duration::hours(2);
        service
            .cache
            .store_rate(&FxRateCacheEntry {
                base_currency: "USD".into(),
                quote_currency: "EUR".into(),
                rate: 0.87,
                source: "frankfurter".into(),
                fetched_at: old,
            })
            .await?;
        for _ in 0..3 {
            let result = service.usd_eur_rate().await;
            assert_eq!(result.rate, 0.87);
            assert_eq!(result.fetched_at, old);
            assert_eq!(result.source, "frankfurter_stale");
        }
        let restarted = FxRateService::new(
            service.cache.clone(),
            service.settings.clone(),
            ProviderAccess::from_pool(pool, 0.0).await?,
        );
        assert_eq!(restarted.usd_eur_rate().await.fetched_at, old);
        assert_eq!(server.hits(), 1);
        Ok(())
    }
}
