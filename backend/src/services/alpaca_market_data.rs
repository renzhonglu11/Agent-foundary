use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, RwLock},
    time::{Duration, Instant},
};

use apca::{
    ApiInfo, Client,
    data::v2::{Feed, last_quotes},
};
use chrono::{DateTime, Utc};
use serde::Serialize;
use tracing::{info, warn};

use crate::{
    application::{
        ports::market_data_repository::{MarketDataRepository, MarketQuoteRecord},
        services::fx_rate_service::FxRateService,
    },
    config::AlpacaSettings,
};

#[derive(Clone)]
pub struct AlpacaMarketDataService {
    settings: AlpacaSettings,
    fx_rate_service: FxRateService,
    market_data_repository: Arc<dyn MarketDataRepository>,
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
    pub currency: String,
    pub bid_price: f64,
    pub ask_price: f64,
    pub raw_price: f64,
    pub raw_bid_price: f64,
    pub raw_ask_price: f64,
    pub raw_currency: String,
    pub usd_eur_rate: f64,
    pub fx_rate_source: String,
    pub bid_size: u64,
    pub ask_size: u64,
    pub price_source: String,
    pub price_as_of: String,
    pub cached: bool,
}

impl AlpacaMarketDataService {
    pub fn new(
        settings: AlpacaSettings,
        fx_rate_service: FxRateService,
        market_data_repository: Arc<dyn MarketDataRepository>,
    ) -> Self {
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
            market_data_repository,
            client,
            cache: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub async fn latest_quotes(&self, symbols_param: &str) -> AlpacaQuotesResponse {
        let mut warnings = Vec::new();
        let (symbols, rejected) =
            parse_symbols_param(symbols_param, self.settings.max_symbols_per_request);
        warnings.extend(rejected);

        if symbols.is_empty() {
            info!("Alpaca market data refresh skipped because no valid symbols were requested");
            return self.response(AlpacaQuoteStatus::EmptyRequest, Vec::new(), warnings);
        }

        if !self.settings.enabled {
            info!("Alpaca market data refresh skipped because provider is disabled");
            warnings
                .push("Alpaca provider is disabled; using stored quotes if available".to_owned());
            return self
                .stored_quotes_response(AlpacaQuoteStatus::Disabled, &symbols, warnings)
                .await;
        }

        let Some(client) = &self.client else {
            warn!("Alpaca market data refresh skipped because credentials are missing");
            warnings.push(
                "Alpaca credentials are missing; set APCA_API_KEY_ID and APCA_API_SECRET_KEY"
                    .to_owned(),
            );
            warnings.push("Using stored Alpaca quotes if available".to_owned());
            return self
                .stored_quotes_response(AlpacaQuoteStatus::MissingCredentials, &symbols, warnings)
                .await;
        };

        info!(
            symbols = ?symbols,
            max_symbols = self.settings.max_symbols_per_request,
            cache_ttl_seconds = self.settings.cache_ttl_seconds,
            "starting Alpaca IEX latest quote refresh"
        );

        let now = Instant::now();
        let now_utc = Utc::now();
        let ttl = Duration::from_secs(self.settings.cache_ttl_seconds);
        let fx_rate = self.fx_rate_service.usd_eur_rate().await;
        let mut quotes_by_symbol = HashMap::new();
        let mut missing = Vec::new();
        let mut stored_fallbacks = HashMap::new();

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
            match self
                .market_data_repository
                .load_quotes("alpaca", "iex", &missing)
                .await
            {
                Ok(records) => {
                    let mut still_missing = Vec::new();
                    let stored_symbols: HashSet<_> =
                        records.iter().map(|record| record.symbol.clone()).collect();

                    for record in records {
                        let quote = quote_from_record(&record, true);
                        if is_fresh(record.fetched_at, now_utc, ttl) {
                            info!(
                                symbol = %quote.symbol,
                                price = quote.price,
                                price_as_of = %quote.price_as_of,
                                fetched_at = %record.fetched_at.to_rfc3339(),
                                "using persisted Alpaca IEX quote"
                            );
                            if let Ok(mut cache) = self.cache.write() {
                                cache.insert(
                                    quote.symbol.clone(),
                                    CachedQuote {
                                        quote: quote.clone(),
                                        fetched_at: now,
                                    },
                                );
                            }
                            quotes_by_symbol.insert(quote.symbol.clone(), quote);
                        } else {
                            stored_fallbacks.insert(quote.symbol.clone(), quote);
                        }
                    }

                    for symbol in missing {
                        if !quotes_by_symbol.contains_key(&symbol) {
                            still_missing.push(symbol.clone());
                        }
                        if !stored_symbols.contains(&symbol) {
                            stored_fallbacks.remove(&symbol);
                        }
                    }
                    missing = still_missing;
                }
                Err(error) => {
                    warn!(%error, "failed to read persisted Alpaca quotes");
                    warnings.push("Alpaca quote database cache read failed".to_owned());
                }
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
                    let fetched_at_utc = Utc::now();
                    let mut fetched_symbols = HashSet::new();
                    let mut records = Vec::new();
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
                            records.push(record_from_quote(&alpaca_quote, fetched_at_utc));
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

                    if let Err(error) = self.market_data_repository.store_quotes(&records).await {
                        warn!(%error, "failed to persist Alpaca quotes");
                        warnings.push("Alpaca quote database cache write failed".to_owned());
                    }

                    for symbol in missing {
                        if !fetched_symbols.contains(&symbol) {
                            warn!(
                                symbol = %symbol,
                                "Alpaca returned no latest IEX quote for requested symbol"
                            );
                            warnings
                                .push(format!("Alpaca returned no latest IEX quote for {symbol}"));
                            if let Some(quote) = stored_fallbacks.remove(&symbol) {
                                warnings
                                    .push(format!("Using last stored Alpaca quote for {symbol}"));
                                quotes_by_symbol.insert(symbol, quote);
                            }
                        }
                    }
                }
                Err(error) => {
                    warn!(%error, "Alpaca latest quote request failed");
                    warnings.push(format!("Alpaca latest quote request failed: {error}"));
                    for (symbol, quote) in stored_fallbacks {
                        warnings.push(format!("Using last stored Alpaca quote for {symbol}"));
                        quotes_by_symbol.entry(symbol).or_insert(quote);
                    }
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

    async fn stored_quotes_response(
        &self,
        status: AlpacaQuoteStatus,
        symbols: &[String],
        mut warnings: Vec<String>,
    ) -> AlpacaQuotesResponse {
        match self
            .market_data_repository
            .load_quotes("alpaca", "iex", symbols)
            .await
        {
            Ok(records) => {
                let quotes_by_symbol = records
                    .iter()
                    .map(|record| (record.symbol.clone(), quote_from_record(record, true)))
                    .collect();
                let quotes = ordered_quotes(symbols, &quotes_by_symbol);
                if !quotes.is_empty() {
                    warnings.push("Returned persisted Alpaca quotes from SQLite".to_owned());
                }
                self.response(status, quotes, warnings)
            }
            Err(error) => {
                warn!(%error, "failed to read persisted Alpaca quotes");
                warnings.push("Alpaca quote database cache read failed".to_owned());
                self.response(status, Vec::new(), warnings)
            }
        }
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

fn is_fresh(fetched_at: DateTime<Utc>, now: DateTime<Utc>, ttl: Duration) -> bool {
    now.signed_duration_since(fetched_at)
        .to_std()
        .map(|age| age <= ttl)
        .unwrap_or(false)
}

fn record_from_quote(quote: &AlpacaQuote, fetched_at: DateTime<Utc>) -> MarketQuoteRecord {
    MarketQuoteRecord {
        provider: "alpaca".to_owned(),
        feed: "iex".to_owned(),
        symbol: quote.symbol.clone(),
        price: quote.price,
        currency: quote.currency.clone(),
        bid_price: quote.bid_price,
        ask_price: quote.ask_price,
        raw_price: quote.raw_price,
        raw_bid_price: quote.raw_bid_price,
        raw_ask_price: quote.raw_ask_price,
        raw_currency: quote.raw_currency.clone(),
        usd_eur_rate: quote.usd_eur_rate,
        fx_rate_source: quote.fx_rate_source.clone(),
        bid_size: quote.bid_size as i64,
        ask_size: quote.ask_size as i64,
        price_source: quote.price_source.clone(),
        price_as_of: quote.price_as_of.clone(),
        fetched_at,
    }
}

fn quote_from_record(record: &MarketQuoteRecord, cached: bool) -> AlpacaQuote {
    AlpacaQuote {
        symbol: record.symbol.clone(),
        price: record.price,
        currency: record.currency.clone(),
        bid_price: record.bid_price,
        ask_price: record.ask_price,
        raw_price: record.raw_price,
        raw_bid_price: record.raw_bid_price,
        raw_ask_price: record.raw_ask_price,
        raw_currency: record.raw_currency.clone(),
        usd_eur_rate: record.usd_eur_rate,
        fx_rate_source: record.fx_rate_source.clone(),
        bid_size: record.bid_size.max(0) as u64,
        ask_size: record.ask_size.max(0) as u64,
        price_source: record.price_source.clone(),
        price_as_of: record.price_as_of.clone(),
        cached,
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
        currency: "EUR".to_owned(),
        bid_price: raw_bid_price * usd_eur_rate,
        ask_price: raw_ask_price * usd_eur_rate,
        raw_price,
        raw_bid_price,
        raw_ask_price,
        raw_currency: "USD".to_owned(),
        usd_eur_rate,
        fx_rate_source,
        bid_size: quote.bid_size,
        ask_size: quote.ask_size,
        price_source: "alpaca_iex".to_owned(),
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
