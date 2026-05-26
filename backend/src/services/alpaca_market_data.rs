use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, RwLock},
    time::{Duration, Instant},
};

use apca::{
    ApiInfo, Client,
    data::v2::{Feed, last_quotes},
};
use chrono::Utc;
use serde::Serialize;
use tracing::{info, warn};

use crate::{application::services::fx_rate_service::FxRateService, config::AlpacaSettings};

#[derive(Clone)]
pub struct AlpacaMarketDataService {
    settings: AlpacaSettings,
    fx_rate_service: FxRateService,
    client: Option<Arc<Client>>,
    cache: Arc<RwLock<HashMap<String, CachedQuote>>>,
}

#[derive(Debug, Clone)]
struct CachedQuote {
    quote: AlpacaQuote,
    fetched_at: Instant,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlpacaQuotesResponse {
    pub generated_at: String,
    pub provider: &'static str,
    pub feed: &'static str,
    pub enabled: bool,
    pub status: AlpacaQuoteStatus,
    pub max_symbols: usize,
    pub cache_ttl_seconds: u64,
    pub usd_eur_rate: f64,
    pub fx_rate_source: String,
    pub fx_rate_fetched_at: String,
    pub quotes: Vec<AlpacaQuote>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AlpacaQuoteStatus {
    Ok,
    Partial,
    Disabled,
    MissingCredentials,
    EmptyRequest,
    Error,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlpacaQuote {
    pub symbol: String,
    pub price: f64,
    pub currency: &'static str,
    pub bid_price: f64,
    pub ask_price: f64,
    pub raw_price: f64,
    pub raw_bid_price: f64,
    pub raw_ask_price: f64,
    pub raw_currency: &'static str,
    pub usd_eur_rate: f64,
    pub fx_rate_source: String,
    pub bid_size: u64,
    pub ask_size: u64,
    pub price_source: &'static str,
    pub price_as_of: String,
    pub cached: bool,
}

impl AlpacaMarketDataService {
    pub fn new(settings: AlpacaSettings, fx_rate_service: FxRateService) -> Self {
        let client = if settings.enabled
            && std::env::var_os("APCA_API_KEY_ID").is_some()
            && std::env::var_os("APCA_API_SECRET_KEY").is_some()
        {
            match ApiInfo::from_env() {
                Ok(api_info) => Some(Arc::new(Client::new(api_info))),
                Err(error) => {
                    warn!(%error, "failed to initialize Alpaca client from environment");
                    None
                }
            }
        } else {
            None
        };

        Self {
            settings,
            fx_rate_service,
            client,
            cache: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub async fn latest_quotes(&self, symbols_param: &str) -> AlpacaQuotesResponse {
        let mut warnings = Vec::new();

        if !self.settings.enabled {
            info!("Alpaca market data refresh skipped because provider is disabled");
            return self.response(AlpacaQuoteStatus::Disabled, Vec::new(), warnings);
        }

        let Some(client) = &self.client else {
            warn!("Alpaca market data refresh skipped because credentials are missing");
            warnings.push(
                "Alpaca credentials are missing; set APCA_API_KEY_ID and APCA_API_SECRET_KEY"
                    .to_owned(),
            );
            return self.response(AlpacaQuoteStatus::MissingCredentials, Vec::new(), warnings);
        };

        let (symbols, rejected) =
            parse_symbols_param(symbols_param, self.settings.max_symbols_per_request);
        warnings.extend(rejected);

        if symbols.is_empty() {
            info!("Alpaca market data refresh skipped because no valid symbols were requested");
            return self.response(AlpacaQuoteStatus::EmptyRequest, Vec::new(), warnings);
        }

        info!(
            symbols = ?symbols,
            max_symbols = self.settings.max_symbols_per_request,
            cache_ttl_seconds = self.settings.cache_ttl_seconds,
            "starting Alpaca IEX latest quote refresh"
        );

        let now = Instant::now();
        let ttl = Duration::from_secs(self.settings.cache_ttl_seconds);
        let fx_rate = self.fx_rate_service.usd_eur_rate().await;
        let mut quotes_by_symbol = HashMap::new();
        let mut missing = Vec::new();

        match self.cache.read() {
            Ok(cache) => {
                for symbol in &symbols {
                    if let Some(cached) = cache.get(symbol) {
                        if now.duration_since(cached.fetched_at) <= ttl {
                            let mut quote = cached.quote.clone();
                            quote.cached = true;
                            info!(
                                symbol = %quote.symbol,
                                price = quote.price,
                                currency = quote.currency,
                                raw_price = quote.raw_price,
                                raw_currency = quote.raw_currency,
                                bid = quote.bid_price,
                                ask = quote.ask_price,
                                price_as_of = %quote.price_as_of,
                                cached = true,
                                "using cached Alpaca IEX quote"
                            );
                            quotes_by_symbol.insert(symbol.clone(), quote);
                            continue;
                        }
                    }
                    missing.push(symbol.clone());
                }
            }
            Err(_) => {
                warnings
                    .push("Alpaca quote cache read failed; fetching uncached quotes".to_owned());
                missing = symbols.clone();
            }
        }

        if !missing.is_empty() {
            info!(
                symbols = ?missing,
                count = missing.len(),
                "requesting Alpaca IEX latest quotes"
            );

            let request = last_quotes::GetReqInit {
                feed: Some(Feed::IEX),
                ..Default::default()
            }
            .init(missing.clone());

            match client.issue::<last_quotes::Get>(&request).await {
                Ok(items) => {
                    let fetched_at = Instant::now();
                    let mut fetched_symbols = HashSet::new();
                    for (symbol, quote) in items {
                        let symbol = symbol.to_ascii_uppercase();
                        fetched_symbols.insert(symbol.clone());
                        if let Some(alpaca_quote) = convert_quote(
                            symbol.clone(),
                            quote,
                            fx_rate.rate,
                            fx_rate.source.clone(),
                        ) {
                            info!(
                                symbol = %alpaca_quote.symbol,
                                price = alpaca_quote.price,
                                currency = alpaca_quote.currency,
                                raw_price = alpaca_quote.raw_price,
                                raw_currency = alpaca_quote.raw_currency,
                                bid = alpaca_quote.bid_price,
                                ask = alpaca_quote.ask_price,
                                bid_size = alpaca_quote.bid_size,
                                ask_size = alpaca_quote.ask_size,
                                price_as_of = %alpaca_quote.price_as_of,
                                cached = false,
                                "updated Alpaca IEX quote"
                            );
                            quotes_by_symbol.insert(symbol.clone(), alpaca_quote.clone());
                            match self.cache.write() {
                                Ok(mut cache) => {
                                    cache.insert(
                                        symbol,
                                        CachedQuote {
                                            quote: alpaca_quote,
                                            fetched_at,
                                        },
                                    );
                                }
                                Err(_) => {
                                    warn!("failed to write Alpaca quote cache");
                                }
                            }
                        }
                    }

                    for symbol in missing {
                        if !fetched_symbols.contains(&symbol) {
                            warn!(
                                symbol = %symbol,
                                "Alpaca returned no latest IEX quote for requested symbol"
                            );
                            warnings
                                .push(format!("Alpaca returned no latest IEX quote for {symbol}"));
                        }
                    }
                }
                Err(error) => {
                    warn!(%error, "Alpaca latest quote request failed");
                    warnings.push(format!("Alpaca latest quote request failed: {error}"));
                    let quotes = ordered_quotes(&symbols, &quotes_by_symbol);
                    return self.response(AlpacaQuoteStatus::Error, quotes, warnings);
                }
            }
        }

        let quotes = ordered_quotes(&symbols, &quotes_by_symbol);
        let status = if quotes.len() == symbols.len() {
            AlpacaQuoteStatus::Ok
        } else {
            AlpacaQuoteStatus::Partial
        };

        self.response_with_fx(
            status,
            quotes,
            warnings,
            fx_rate.rate,
            &fx_rate.source,
            &fx_rate.fetched_at.to_rfc3339(),
        )
    }

    fn response(
        &self,
        status: AlpacaQuoteStatus,
        quotes: Vec<AlpacaQuote>,
        warnings: Vec<String>,
    ) -> AlpacaQuotesResponse {
        self.response_with_fx(
            status,
            quotes,
            warnings,
            self.settings.usd_eur_rate,
            "fallback_env",
            &Utc::now().to_rfc3339(),
        )
    }

    fn response_with_fx(
        &self,
        status: AlpacaQuoteStatus,
        quotes: Vec<AlpacaQuote>,
        warnings: Vec<String>,
        usd_eur_rate: f64,
        fx_rate_source: &str,
        fx_rate_fetched_at: &str,
    ) -> AlpacaQuotesResponse {
        AlpacaQuotesResponse {
            generated_at: Utc::now().to_rfc3339(),
            provider: "alpaca",
            feed: "iex",
            enabled: self.settings.enabled,
            status,
            max_symbols: self.settings.max_symbols_per_request,
            cache_ttl_seconds: self.settings.cache_ttl_seconds,
            usd_eur_rate,
            fx_rate_source: fx_rate_source.to_owned(),
            fx_rate_fetched_at: fx_rate_fetched_at.to_owned(),
            quotes,
            warnings,
        }
    }
}

fn parse_symbols_param(symbols_param: &str, limit: usize) -> (Vec<String>, Vec<String>) {
    let mut symbols = Vec::new();
    let mut seen = HashSet::new();
    let mut warnings = Vec::new();

    for raw in symbols_param.split(',') {
        let symbol = raw.trim().to_ascii_uppercase();
        if symbol.is_empty() {
            continue;
        }

        if !is_valid_alpaca_symbol(&symbol) {
            warnings.push(format!(
                "Skipped unsupported Alpaca symbol candidate: {symbol}"
            ));
            continue;
        }

        if seen.insert(symbol.clone()) {
            symbols.push(symbol);
        }
    }

    if symbols.len() > limit {
        warnings.push(format!(
            "Requested {} symbols; limited to first {limit} to respect the free Alpaca API",
            symbols.len()
        ));
        symbols.truncate(limit);
    }

    (symbols, warnings)
}

fn is_valid_alpaca_symbol(symbol: &str) -> bool {
    let mut chars = symbol.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    first.is_ascii_uppercase()
        && symbol.len() <= 10
        && symbol
            .chars()
            .all(|value| value.is_ascii_uppercase() || value.is_ascii_digit() || value == '.')
}

fn convert_quote(
    symbol: String,
    quote: last_quotes::Quote,
    usd_eur_rate: f64,
    fx_rate_source: String,
) -> Option<AlpacaQuote> {
    let raw_bid_price = quote.bid_price.to_f64()?;
    let raw_ask_price = quote.ask_price.to_f64()?;
    let raw_price = match (raw_bid_price > 0.0, raw_ask_price > 0.0) {
        (true, true) => (raw_bid_price + raw_ask_price) / 2.0,
        (true, false) => raw_bid_price,
        (false, true) => raw_ask_price,
        (false, false) => return None,
    };

    Some(AlpacaQuote {
        symbol,
        price: raw_price * usd_eur_rate,
        currency: "EUR",
        bid_price: raw_bid_price * usd_eur_rate,
        ask_price: raw_ask_price * usd_eur_rate,
        raw_price,
        raw_bid_price,
        raw_ask_price,
        raw_currency: "USD",
        usd_eur_rate,
        fx_rate_source,
        bid_size: quote.bid_size,
        ask_size: quote.ask_size,
        price_source: "alpaca_iex",
        price_as_of: quote.time.to_rfc3339(),
        cached: false,
    })
}

fn ordered_quotes(
    symbols: &[String],
    quotes_by_symbol: &HashMap<String, AlpacaQuote>,
) -> Vec<AlpacaQuote> {
    symbols
        .iter()
        .filter_map(|symbol| quotes_by_symbol.get(symbol).cloned())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_symbols_with_limit_and_rejections() {
        let (symbols, warnings) = parse_symbols_param(" nvda, US67066G1040, msft, BRK.B, nvda ", 3);

        assert_eq!(symbols, vec!["NVDA", "MSFT", "BRK.B"]);
        assert!(
            warnings
                .iter()
                .any(|warning| warning.contains("US67066G1040"))
        );
    }

    #[test]
    fn valid_alpaca_symbol_candidates_are_short_us_tickers() {
        assert!(is_valid_alpaca_symbol("NVDA"));
        assert!(is_valid_alpaca_symbol("BRK.B"));
        assert!(!is_valid_alpaca_symbol("US67066G1040"));
        assert!(!is_valid_alpaca_symbol("ALPHABET INC"));
        assert!(!is_valid_alpaca_symbol(""));
    }
}
