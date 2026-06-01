use std::{
    collections::HashMap,
    sync::{Arc, RwLock},
    time::{Duration, Instant},
};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use tracing::{info, warn};

use crate::config::FredSettings;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FredObservation {
    pub date: String,
    pub value: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FredSeriesData {
    pub id: String,
    pub title: String,
    pub units: String,
    pub frequency: String,
    pub observations: Vec<FredObservation>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FredMacroDataResponse {
    pub generated_at: String,
    pub provider: &'static str,
    pub status: &'static str, // "live" or "sandbox_mock"
    pub cache_ttl_seconds: u64,
    pub series: Vec<FredSeriesData>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct FredApiResponse {
    observations: Vec<FredApiObservation>,
}

#[derive(Debug, Deserialize)]
struct FredApiObservation {
    date: String,
    value: String,
}

#[derive(Clone)]
pub struct FredService {
    settings: FredSettings,
    client: reqwest::Client,
    cache: Arc<RwLock<Option<(Instant, FredMacroDataResponse)>>>,
}

impl FredService {
    pub fn new(settings: FredSettings) -> Self {
        Self {
            settings,
            client: reqwest::Client::new(),
            cache: Arc::new(RwLock::new(None)),
        }
    }

    pub async fn get_macro_data(&self) -> FredMacroDataResponse {
        let now = Instant::now();
        let ttl = Duration::from_secs(self.settings.cache_ttl_seconds);

        // Check cache first
        if let Ok(cache) = self.cache.read() {
            if let Some((fetched_at, cached_response)) = &*cache {
                if now.duration_since(*fetched_at) <= ttl {
                    info!("Using cached FRED macroeconomic data");
                    return cached_response.clone();
                }
            }
        }

        let mut warnings = Vec::new();
        let api_key = match &self.settings.api_key {
            Some(key) => key.clone(),
            None => {
                info!("FRED_API_KEY is not configured; using sandbox mock data");
                warnings.push(
                    "FRED_API_KEY is not configured in .env; displaying sandbox mock data."
                        .to_owned(),
                );
                let response = self.generate_mock_data(warnings);
                return response;
            }
        };

        info!("Fetching live macroeconomic data from FRED API");
        match self.fetch_live_data(&api_key).await {
            Ok(response) => {
                // Store in cache
                if let Ok(mut cache) = self.cache.write() {
                    *cache = Some((Instant::now(), response.clone()));
                }
                response
            }
            Err(error) => {
                warn!(%error, "Failed to fetch live FRED macroeconomic data; falling back to sandbox mock data");
                warnings.push(format!(
                    "Failed to fetch live FRED data: {error}. Falling back to sandbox mock data."
                ));
                self.generate_mock_data(warnings)
            }
        }
    }

    async fn fetch_live_data(&self, api_key: &str) -> anyhow::Result<FredMacroDataResponse> {
        // Predefined list of FRED series to fetch
        // ID, Title, Units, Frequency, Start Date
        let series_to_fetch = vec![
            (
                "FEDFUNDS",
                "Federal Funds Effective Rate",
                "Percent",
                "Monthly",
                "2021-01-01",
            ),
            (
                "T10Y2Y",
                "10-Year vs 2-Year Treasury Yield Spread",
                "Percent",
                "Daily",
                "2023-01-01",
            ),
            (
                "CPIAUCSL",
                "Consumer Price Index (CPI)",
                "Index",
                "Monthly",
                "2020-01-01",
            ), // Fetch 2020 to calculate YoY inflation from 2021
            (
                "UNRATE",
                "Unemployment Rate",
                "Percent",
                "Monthly",
                "2021-01-01",
            ),
            (
                "DGS10",
                "10-Year Treasury Yield",
                "Percent",
                "Daily",
                "2023-01-01",
            ),
            (
                "GDPC1",
                "Real Gross Domestic Product",
                "Billions of Chained 2017 USD",
                "Quarterly",
                "2021-01-01",
            ),
        ];

        let mut fetched_series = Vec::new();
        let mut cpi_series: Option<FredSeriesData> = None;

        for (id, title, units, freq, start) in series_to_fetch {
            let url = format!(
                "https://api.stlouisfed.org/fred/series/observations?series_id={}&api_key={}&file_type=json&observation_start={}",
                id, api_key, start
            );

            let response = self
                .client
                .get(&url)
                .send()
                .await?
                .error_for_status()?
                .json::<FredApiResponse>()
                .await?;

            let mut observations = Vec::new();
            for obs in response.observations {
                if let Ok(value) = obs.value.trim().parse::<f64>() {
                    observations.push(FredObservation {
                        date: obs.date,
                        value,
                    });
                }
            }

            let series_data = FredSeriesData {
                id: id.to_owned(),
                title: title.to_owned(),
                units: units.to_owned(),
                frequency: freq.to_owned(),
                observations,
            };

            if id == "CPIAUCSL" {
                cpi_series = Some(series_data);
            } else {
                fetched_series.push(series_data);
            }
        }

        // Calculate and add CPI YoY Inflation Rate
        if let Some(cpi) = cpi_series {
            let mut inflation_obs = Vec::new();
            let mut index_by_date = HashMap::new();

            for obs in &cpi.observations {
                index_by_date.insert(obs.date.clone(), obs.value);
            }

            for obs in &cpi.observations {
                // Find 12 months prior date
                // Dates are in format "YYYY-MM-DD"
                if let Some(prior_date) = get_12_months_prior(&obs.date) {
                    if let Some(prior_value) = index_by_date.get(&prior_date) {
                        let yoy_change = ((obs.value - prior_value) / prior_value) * 100.0;
                        // Keep only data starting from 2021-01-01
                        if obs.date.as_str() >= "2021-01-01" {
                            // Round to 2 decimal places
                            let yoy_change_rounded = (yoy_change * 100.0).round() / 100.0;
                            inflation_obs.push(FredObservation {
                                date: obs.date.clone(),
                                value: yoy_change_rounded,
                            });
                        }
                    }
                }
            }

            // Also filter CPIAUCSL observations to keep only 2021-01-01 onwards
            let mut filtered_cpi = cpi;
            filtered_cpi
                .observations
                .retain(|obs| obs.date.as_str() >= "2021-01-01");

            // Add CPI YoY inflation series
            fetched_series.push(FredSeriesData {
                id: "CPI_YOY".to_owned(),
                title: "US CPI Inflation YoY".to_owned(),
                units: "Percent".to_owned(),
                frequency: "Monthly".to_owned(),
                observations: inflation_obs,
            });

            // Add CPI Index series
            fetched_series.push(filtered_cpi);
        }

        Ok(FredMacroDataResponse {
            generated_at: Utc::now().to_rfc3339(),
            provider: "fred",
            status: "live",
            cache_ttl_seconds: self.settings.cache_ttl_seconds,
            series: fetched_series,
            warnings: Vec::new(),
        })
    }

    fn generate_mock_data(&self, warnings: Vec<String>) -> FredMacroDataResponse {
        let mut series = Vec::new();

        // 1. FEDFUNDS Mock (Monthly, Jan 2023 to May 2026)
        let mut fedfunds_obs = Vec::new();
        let fedfunds_vals = vec![
            ("2023-01-01", 4.33),
            ("2023-02-01", 4.57),
            ("2023-03-01", 4.65),
            ("2023-04-01", 4.83),
            ("2023-05-01", 5.06),
            ("2023-06-01", 5.08),
            ("2023-07-01", 5.12),
            ("2023-08-01", 5.33),
            ("2023-09-01", 5.33),
            ("2023-10-01", 5.33),
            ("2023-11-01", 5.33),
            ("2023-12-01", 5.33),
            ("2024-01-01", 5.33),
            ("2024-02-01", 5.33),
            ("2024-03-01", 5.33),
            ("2024-04-01", 5.33),
            ("2024-05-01", 5.33),
            ("2024-06-01", 5.33),
            ("2024-07-01", 5.33),
            ("2024-08-01", 5.33),
            ("2024-09-01", 4.83),
            ("2024-10-01", 4.83),
            ("2024-11-01", 4.58),
            ("2024-12-01", 4.33),
            ("2025-01-01", 4.33),
            ("2025-02-01", 4.33),
            ("2025-03-01", 4.33),
            ("2025-04-01", 4.33),
            ("2025-05-01", 4.33),
            ("2025-06-01", 4.33),
            ("2025-07-01", 4.33),
            ("2025-08-01", 4.33),
            ("2025-09-01", 4.33),
            ("2025-10-01", 4.33),
            ("2025-11-01", 4.33),
            ("2025-12-01", 4.33),
            ("2026-01-01", 4.33),
            ("2026-02-01", 4.33),
            ("2026-03-01", 4.33),
            ("2026-04-01", 4.33),
            ("2026-05-01", 4.33),
        ];
        for (date, val) in fedfunds_vals {
            fedfunds_obs.push(FredObservation {
                date: date.to_owned(),
                value: val,
            });
        }
        series.push(FredSeriesData {
            id: "FEDFUNDS".to_owned(),
            title: "Federal Funds Effective Rate".to_owned(),
            units: "Percent".to_owned(),
            frequency: "Monthly".to_owned(),
            observations: fedfunds_obs,
        });

        // 2. T10Y2Y Mock (Daily yield curve, sampled semi-weekly to keep mock small, Jan 2023 to May 2026)
        let mut t10y2y_obs = Vec::new();
        let t10y2y_raw = vec![
            ("2023-01-03", -0.72),
            ("2023-03-01", -0.89),
            ("2023-05-01", -0.59),
            ("2023-07-03", -1.08),
            ("2023-09-01", -0.74),
            ("2023-11-01", -0.32),
            ("2023-12-29", -0.37),
            ("2024-02-01", -0.31),
            ("2024-04-01", -0.39),
            ("2024-06-03", -0.45),
            ("2024-08-01", -0.22),
            ("2024-10-01", -0.09),
            ("2024-12-02", -0.15),
            ("2025-01-02", 0.05),
            ("2025-03-03", 0.12),
            ("2025-05-01", 0.18),
            ("2025-07-01", 0.15),
            ("2025-09-01", 0.22),
            ("2025-11-03", 0.28),
            ("2025-12-31", 0.35),
            ("2026-02-02", 0.38),
            ("2026-04-01", 0.42),
            ("2026-05-25", 0.45),
        ];
        for (date, val) in t10y2y_raw {
            t10y2y_obs.push(FredObservation {
                date: date.to_owned(),
                value: val,
            });
        }
        series.push(FredSeriesData {
            id: "T10Y2Y".to_owned(),
            title: "10-Year vs 2-Year Treasury Yield Spread".to_owned(),
            units: "Percent".to_owned(),
            frequency: "Daily".to_owned(),
            observations: t10y2y_obs,
        });

        // 3. CPI_YOY Mock (Monthly YoY inflation, Jan 2023 to May 2026)
        let mut cpi_yoy_obs = Vec::new();
        let cpi_yoy_vals = vec![
            ("2023-01-01", 6.4),
            ("2023-02-01", 6.0),
            ("2023-03-01", 5.0),
            ("2023-04-01", 4.9),
            ("2023-05-01", 4.0),
            ("2023-06-01", 3.0),
            ("2023-07-01", 3.2),
            ("2023-08-01", 3.7),
            ("2023-09-01", 3.7),
            ("2023-10-01", 3.2),
            ("2023-11-01", 3.1),
            ("2023-12-01", 3.4),
            ("2024-01-01", 3.1),
            ("2024-02-01", 3.2),
            ("2024-03-01", 3.5),
            ("2024-04-01", 3.4),
            ("2024-05-01", 3.3),
            ("2024-06-01", 3.0),
            ("2024-07-01", 2.9),
            ("2024-08-01", 2.5),
            ("2024-09-01", 2.4),
            ("2024-10-01", 2.6),
            ("2024-11-01", 2.7),
            ("2024-12-01", 2.7),
            ("2025-01-01", 2.5),
            ("2025-02-01", 2.5),
            ("2025-03-01", 2.4),
            ("2025-04-01", 2.4),
            ("2025-05-01", 2.3),
            ("2025-06-01", 2.3),
            ("2025-07-01", 2.2),
            ("2025-08-01", 2.1),
            ("2025-09-01", 2.1),
            ("2025-10-01", 2.0),
            ("2025-11-01", 2.0),
            ("2025-12-01", 2.0),
            ("2026-01-01", 2.0),
            ("2026-02-01", 2.1),
            ("2026-03-01", 2.1),
            ("2026-04-01", 2.0),
            ("2026-05-01", 2.0),
        ];
        for (date, val) in cpi_yoy_vals {
            cpi_yoy_obs.push(FredObservation {
                date: date.to_owned(),
                value: val,
            });
        }
        series.push(FredSeriesData {
            id: "CPI_YOY".to_owned(),
            title: "US CPI Inflation YoY".to_owned(),
            units: "Percent".to_owned(),
            frequency: "Monthly".to_owned(),
            observations: cpi_yoy_obs,
        });

        // 4. CPIAUCSL Mock (Monthly CPI Index, Jan 2023 to May 2026)
        let mut cpiauxsl_obs = Vec::new();
        let cpiauxsl_vals = vec![
            ("2023-01-01", 300.5),
            ("2023-04-01", 302.9),
            ("2023-07-01", 304.3),
            ("2023-10-01", 307.5),
            ("2024-01-01", 309.7),
            ("2024-04-01", 311.5),
            ("2024-07-01", 313.2),
            ("2024-10-01", 315.7),
            ("2025-01-01", 317.5),
            ("2025-04-01", 319.1),
            ("2025-07-01", 320.3),
            ("2025-10-01", 322.0),
            ("2026-01-01", 323.8),
            ("2026-04-01", 325.2),
            ("2026-05-01", 325.8),
        ];
        for (date, val) in cpiauxsl_vals {
            cpiauxsl_obs.push(FredObservation {
                date: date.to_owned(),
                value: val,
            });
        }
        series.push(FredSeriesData {
            id: "CPIAUCSL".to_owned(),
            title: "Consumer Price Index (CPI)".to_owned(),
            units: "Index".to_owned(),
            frequency: "Monthly".to_owned(),
            observations: cpiauxsl_obs,
        });

        // 5. UNRATE Mock (Monthly Unemployment, Jan 2023 to May 2026)
        let mut unrate_obs = Vec::new();
        let unrate_vals = vec![
            ("2023-01-01", 3.4),
            ("2023-03-01", 3.5),
            ("2023-05-01", 3.7),
            ("2023-07-01", 3.5),
            ("2023-09-01", 3.8),
            ("2023-11-01", 3.7),
            ("2024-01-01", 3.7),
            ("2024-03-01", 3.8),
            ("2024-05-01", 4.0),
            ("2024-07-01", 4.3),
            ("2024-09-01", 4.1),
            ("2024-11-01", 4.2),
            ("2025-01-01", 4.1),
            ("2025-03-01", 4.0),
            ("2025-05-01", 3.9),
            ("2025-07-01", 3.9),
            ("2025-09-01", 3.8),
            ("2025-11-01", 3.7),
            ("2026-01-01", 3.7),
            ("2026-03-01", 3.8),
            ("2026-05-01", 3.9),
        ];
        for (date, val) in unrate_vals {
            unrate_obs.push(FredObservation {
                date: date.to_owned(),
                value: val,
            });
        }
        series.push(FredSeriesData {
            id: "UNRATE".to_owned(),
            title: "Unemployment Rate".to_owned(),
            units: "Percent".to_owned(),
            frequency: "Monthly".to_owned(),
            observations: unrate_obs,
        });

        // 6. DGS10 Mock (Daily 10-Year yield, sampled semi-weekly, Jan 2023 to May 2026)
        let mut dgs10_obs = Vec::new();
        let dgs10_raw = vec![
            ("2023-01-03", 3.79),
            ("2023-03-01", 4.01),
            ("2023-05-01", 3.57),
            ("2023-07-03", 3.86),
            ("2023-09-01", 4.18),
            ("2023-10-19", 4.98),
            ("2023-12-29", 3.88),
            ("2024-02-01", 3.86),
            ("2024-04-01", 4.33),
            ("2024-06-03", 4.41),
            ("2024-08-01", 3.98),
            ("2024-10-01", 3.75),
            ("2024-12-02", 4.22),
            ("2025-01-02", 4.35),
            ("2025-03-03", 4.15),
            ("2025-05-01", 3.95),
            ("2025-07-01", 3.80),
            ("2025-09-01", 4.12),
            ("2025-11-03", 4.25),
            ("2025-12-31", 4.30),
            ("2026-02-02", 4.15),
            ("2026-04-01", 4.05),
            ("2026-05-25", 3.98),
        ];
        for (date, val) in dgs10_raw {
            dgs10_obs.push(FredObservation {
                date: date.to_owned(),
                value: val,
            });
        }
        series.push(FredSeriesData {
            id: "DGS10".to_owned(),
            title: "10-Year Treasury Yield".to_owned(),
            units: "Percent".to_owned(),
            frequency: "Daily".to_owned(),
            observations: dgs10_obs,
        });

        // 7. GDPC1 Mock (Quarterly, Q1 2023 to Q1 2026)
        let mut gdpc1_obs = Vec::new();
        let gdpc1_vals = vec![
            ("2023-01-01", 22112.3),
            ("2023-04-01", 22225.4),
            ("2023-07-01", 22490.7),
            ("2023-10-01", 22679.3),
            ("2024-01-01", 22769.0),
            ("2024-04-01", 22943.5),
            ("2024-07-01", 23150.2),
            ("2024-10-01", 23320.5),
            ("2025-01-01", 23480.0),
            ("2025-04-01", 23640.4),
            ("2025-07-01", 23810.2),
            ("2025-10-01", 23980.5),
            ("2026-01-01", 24150.0),
        ];
        for (date, val) in gdpc1_vals {
            gdpc1_obs.push(FredObservation {
                date: date.to_owned(),
                value: val,
            });
        }
        series.push(FredSeriesData {
            id: "GDPC1".to_owned(),
            title: "Real Gross Domestic Product".to_owned(),
            units: "Billions of Chained 2017 USD".to_owned(),
            frequency: "Quarterly".to_owned(),
            observations: gdpc1_obs,
        });

        FredMacroDataResponse {
            generated_at: Utc::now().to_rfc3339(),
            provider: "fred",
            status: "sandbox_mock",
            cache_ttl_seconds: self.settings.cache_ttl_seconds,
            series,
            warnings,
        }
    }
}

// Helper to compute a date 12 months prior.
// Format is YYYY-MM-DD
fn get_12_months_prior(date_str: &str) -> Option<String> {
    if date_str.len() != 10 {
        return None;
    }
    let parts: Vec<&str> = date_str.split('-').collect();
    if parts.len() != 3 {
        return None;
    }
    let year = parts[0].parse::<i32>().ok()?;
    let month_str = parts[1];
    let day_str = parts[2];

    let prior_year = year - 1;
    Some(format!("{:04}-{}-{}", prior_year, month_str, day_str))
}
