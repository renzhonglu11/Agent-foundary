use std::{net::IpAddr, path::PathBuf};

use anyhow::{Context, bail};

#[derive(Debug, Clone)]
pub struct Settings {
    pub app_env: AppEnv,
    pub host: IpAddr,
    pub port: u16,
    pub frontend_origin: String,
    pub database_url: String,
    pub structured_products: StructuredProductsSettings,
    pub fx_rates: FxRateSettings,
    pub alpaca: AlpacaSettings,
    pub fred: FredSettings,
    pub log_format: LogFormat,
}

#[derive(Debug, Clone)]
pub struct StructuredProductsSettings {
    pub enabled: bool,
    pub command: String,
    pub working_dir: PathBuf,
    pub output_json_path: PathBuf,
    pub output_csv_path: PathBuf,
    pub output_db_path: PathBuf,
    pub no_live_enrichment: bool,
}

#[derive(Debug, Clone)]
pub struct AlpacaSettings {
    pub enabled: bool,
    pub max_symbols_per_request: usize,
    pub cache_ttl_seconds: u64,
    pub usd_eur_rate: f64,
}

#[derive(Debug, Clone)]
pub struct FxRateSettings {
    pub enabled: bool,
    pub endpoint: String,
    pub cache_ttl_seconds: u64,
    pub fallback_usd_eur_rate: f64,
}

#[derive(Debug, Clone)]
pub struct FredSettings {
    pub api_key: Option<String>,
    pub cache_ttl_seconds: u64,
    pub fallback_cache_ttl_seconds: u64,
    pub request_delay_ms: u64,
    pub max_retries: u32,
    pub retry_base_delay_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AppEnv {
    Local,
    Production,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LogFormat {
    Pretty,
    Json,
}

impl Settings {
    pub fn from_env() -> anyhow::Result<Self> {
        let app_env = match env_or("APP_ENV", "local").as_str() {
            "local" | "development" => AppEnv::Local,
            "production" | "prod" => AppEnv::Production,
            other => bail!("unsupported APP_ENV '{other}'"),
        };

        let host = env_or("HOST", "127.0.0.1")
            .parse()
            .context("HOST must be a valid IP address")?;
        let port = env_or("PORT", "8080")
            .parse()
            .context("PORT must be a valid u16")?;
        let frontend_origin = env_or_non_empty("FRONTEND_ORIGIN", "http://localhost:5173");
        let database_url = env_or("DATABASE_URL", "sqlite://data/agent_foundry.db");
        let structured_products = StructuredProductsSettings::from_env();
        let fx_rates = FxRateSettings::from_env()?;
        let alpaca = AlpacaSettings::from_env()?;
        let fred = FredSettings::from_env();
        let log_format = match env_or("LOG_FORMAT", "pretty").as_str() {
            "pretty" => LogFormat::Pretty,
            "json" => LogFormat::Json,
            other => bail!("unsupported LOG_FORMAT '{other}'"),
        };

        Ok(Self {
            app_env,
            host,
            port,
            frontend_origin,
            database_url,
            structured_products,
            fx_rates,
            alpaca,
            fred,
            log_format,
        })
    }
}

impl StructuredProductsSettings {
    fn from_env() -> Self {
        Self {
            enabled: env_bool("STRUCTURED_PRODUCTS_ENRICHMENT_ENABLED", true),
            command: env_or(
                "STRUCTURED_PRODUCTS_ENRICHMENT_COMMAND",
                ".venv/bin/agent-foundry-structured-products",
            ),
            working_dir: PathBuf::from(env_or(
                "STRUCTURED_PRODUCTS_ENRICHMENT_WORKDIR",
                "backend/python",
            )),
            output_json_path: PathBuf::from(env_or(
                "STRUCTURED_PRODUCTS_ENRICHMENT_JSON",
                "data/structured-products-enrichment.json",
            )),
            output_csv_path: PathBuf::from(env_or(
                "STRUCTURED_PRODUCTS_ENRICHMENT_CSV",
                "data/structured-products-enrichment.csv",
            )),
            output_db_path: PathBuf::from(env_or(
                "STRUCTURED_PRODUCTS_ENRICHMENT_DB",
                "data/structured-products-enrichment.sqlite3",
            )),
            no_live_enrichment: env_bool("STRUCTURED_PRODUCTS_ENRICHMENT_NO_LIVE", false),
        }
    }
}

impl AlpacaSettings {
    fn from_env() -> anyhow::Result<Self> {
        Ok(Self {
            enabled: env_bool("ALPACA_MARKET_DATA_ENABLED", true),
            max_symbols_per_request: env_or("ALPACA_MAX_SYMBOLS_PER_REQUEST", "20")
                .parse()
                .context("ALPACA_MAX_SYMBOLS_PER_REQUEST must be a usize")?,
            cache_ttl_seconds: env_or("ALPACA_QUOTE_CACHE_TTL_SECONDS", "60")
                .parse()
                .context("ALPACA_QUOTE_CACHE_TTL_SECONDS must be a u64")?,
            usd_eur_rate: env_or("ALPACA_USD_EUR_RATE", "0.92")
                .parse()
                .context("ALPACA_USD_EUR_RATE must be an f64")?,
        })
    }
}

impl FxRateSettings {
    fn from_env() -> anyhow::Result<Self> {
        Ok(Self {
            enabled: env_bool("FX_RATES_ENABLED", true),
            endpoint: env_or(
                "FRANKFURTER_USD_LATEST_URL",
                "https://api.frankfurter.dev/v1/latest?base=USD",
            ),
            cache_ttl_seconds: env_or("FX_RATE_CACHE_TTL_SECONDS", "3600")
                .parse()
                .context("FX_RATE_CACHE_TTL_SECONDS must be a u64")?,
            fallback_usd_eur_rate: env_or("ALPACA_USD_EUR_RATE", "0.92")
                .parse()
                .context("ALPACA_USD_EUR_RATE must be an f64")?,
        })
    }
}

impl FredSettings {
    fn from_env() -> Self {
        Self {
            api_key: std::env::var("FRED_API_KEY")
                .ok()
                .filter(|s| !s.trim().is_empty()),
            cache_ttl_seconds: env_or("FRED_CACHE_TTL_SECONDS", "86400")
                .parse()
                .unwrap_or(86400),
            fallback_cache_ttl_seconds: env_or("FRED_FALLBACK_CACHE_TTL_SECONDS", "600")
                .parse()
                .unwrap_or(600),
            request_delay_ms: env_or("FRED_REQUEST_DELAY_MS", "350")
                .parse()
                .unwrap_or(350),
            max_retries: env_or("FRED_MAX_RETRIES", "2").parse().unwrap_or(2),
            retry_base_delay_ms: env_or("FRED_RETRY_BASE_DELAY_MS", "1000")
                .parse()
                .unwrap_or(1000),
        }
    }
}

fn env_or(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_owned())
}

fn env_or_non_empty(key: &str, default: &str) -> String {
    match std::env::var(key) {
        Ok(value) if !value.trim().is_empty() => value,
        _ => default.to_owned(),
    }
}

fn env_bool(key: &str, default: bool) -> bool {
    match std::env::var(key) {
        Ok(value) => matches!(
            value.trim().to_ascii_lowercase().as_str(),
            "1" | "true" | "yes" | "on"
        ),
        Err(_) => default,
    }
}
