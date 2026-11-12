use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, RwLock},
    time::{Duration, Instant},
};

use super::{
    alpaca_http::AlpacaHttp,
    provider_access::{ProviderAccess, ProviderRequestError},
};
use apca::{
    ApiInfo,
    data::v2::{Feed, bars, last_quotes},
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
    services::daily_bars::{DailyBar, DailyBarStats, StoredDailyBars, summarize},
};

const DAILY_BARS_MAX_SYMBOLS: usize = 100;
// Enough sessions for a 200-day average and a one-year range.
const DAILY_BARS_LOOKBACK_DAYS: i64 = 400;
const DAILY_BARS_REFRESH_HOURS: i64 = 12;
const DAILY_BARS_CONCURRENCY: usize = 4;
const DAILY_BARS_KEY_PREFIX: &str = "alpaca_daily_bars:";

#[derive(Clone)]
pub struct AlpacaMarketDataService {
    settings: AlpacaSettings,
    fx_rate_service: FxRateService,
    market_data_repository: Arc<dyn MarketDataRepository>,
    client: Option<Arc<AlpacaHttp>>,
    cache: Arc<RwLock<HashMap<String, CachedQuote>>>,
    // All callers (HTTP and monitoring) share one cache check / network critical section.
    refresh_gate: Arc<tokio::sync::Mutex<()>>,
    // Concurrent callers wait for one history refresh and then read its cache.
    daily_bars_gate: Arc<tokio::sync::Mutex<()>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DailyBarStatsResponse {
    pub generated_at: String,
    pub provider: &'static str,
    pub feed: &'static str,
    pub enabled: bool,
    pub status: AlpacaQuoteStatus,
    pub lookback_days: i64,
    pub refresh_hours: i64,
    pub stats: Vec<DailyBarStats>,
    pub warnings: Vec<String>,
}

struct CachedDailyBars {
    bars: Vec<DailyBar>,
    fetched_at: String,
    fresh: bool,
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
    pub fetched_at: String,
    pub cached: bool,
}

impl AlpacaMarketDataService {
    pub fn new(
        settings: AlpacaSettings,
        fx_rate_service: FxRateService,
        market_data_repository: Arc<dyn MarketDataRepository>,
        access: ProviderAccess,
    ) -> Self {
        let client = if settings.enabled
            && std::env::var_os("APCA_API_KEY_ID").is_some()
            && std::env::var_os("APCA_API_SECRET_KEY").is_some()
        {
            match ApiInfo::from_env() {
                Ok(api_info) => Some(Arc::new(AlpacaHttp::new(api_info, access))),
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
            refresh_gate: Arc::new(tokio::sync::Mutex::new(())),
            daily_bars_gate: Arc::new(tokio::sync::Mutex::new(())),
        }
    }

    /// Statistics from split- and dividend-adjusted daily IEX bars. History
    /// older than the refresh interval is fetched again unless `cache_only`;
    /// when that fails the previous history is returned and marked stale.
    pub async fn daily_bar_stats(
        &self,
        symbols_param: &str,
        cache_only: bool,
    ) -> DailyBarStatsResponse {
        let (symbols, mut warnings) = parse_symbols_param(symbols_param, DAILY_BARS_MAX_SYMBOLS);
        if symbols.is_empty() {
            return self.daily_bar_stats_response(
                AlpacaQuoteStatus::EmptyRequest,
                Vec::new(),
                warnings,
            );
        }

        let _guard = self.daily_bars_gate.lock().await;
        let now = Utc::now();
        let mut cached = HashMap::new();
        for symbol in &symbols {
            match self.load_daily_bars(symbol, now).await {
                Ok(Some(entry)) => {
                    cached.insert(symbol.clone(), entry);
                }
                Ok(None) => {}
                Err(error) => {
                    warn!(%symbol, %error, "failed to read cached daily bars");
                    warnings.push(format!("Daily bar cache read failed for {symbol}"));
                }
            }
        }

        let outdated: Vec<String> = symbols
            .iter()
            .filter(|symbol| !cached.get(*symbol).is_some_and(|entry| entry.fresh))
            .cloned()
            .collect();
        let mut status = AlpacaQuoteStatus::Ok;
        if !outdated.is_empty() && !cache_only {
            match (&self.client, self.settings.enabled) {
                (_, false) => {
                    status = AlpacaQuoteStatus::Disabled;
                    warnings.push("Alpaca provider is disabled; using cached history".to_owned());
                }
                (None, true) => {
                    status = AlpacaQuoteStatus::MissingCredentials;
                    warnings
                        .push("Alpaca credentials are missing; using cached history".to_owned());
                }
                (Some(client), true) => {
                    let failed = self
                        .refresh_daily_bars(client, &outdated, now, &mut cached, &mut warnings)
                        .await;
                    if failed {
                        status = AlpacaQuoteStatus::Error;
                    }
                }
            }
        }

        let mut stats = Vec::new();
        for symbol in &symbols {
            match cached.get(symbol) {
                Some(entry) if !entry.bars.is_empty() => {
                    stats.push(summarize(
                        symbol,
                        &entry.bars,
                        &entry.fetched_at,
                        !entry.fresh,
                    ));
                }
                _ => warnings.push(format!("No daily history available for {symbol}")),
            }
        }
        if status == AlpacaQuoteStatus::Ok && stats.len() != symbols.len() {
            status = AlpacaQuoteStatus::Partial;
        }
        self.daily_bar_stats_response(status, stats, warnings)
    }

    async fn load_daily_bars(
        &self,
        symbol: &str,
        now: DateTime<Utc>,
    ) -> anyhow::Result<Option<CachedDailyBars>> {
        let key = format!("{DAILY_BARS_KEY_PREFIX}{symbol}");
        let Some(record) = self
            .market_data_repository
            .load_payload_record(&key)
            .await?
        else {
            return Ok(None);
        };
        let stored: StoredDailyBars = serde_json::from_str(&record.payload_json)?;
        let fresh = DateTime::parse_from_rfc3339(&record.updated_at).is_ok_and(|fetched_at| {
            now.signed_duration_since(fetched_at)
                < chrono::Duration::hours(DAILY_BARS_REFRESH_HOURS)
        });
        Ok(Some(CachedDailyBars {
            bars: stored.bars,
            fetched_at: record.updated_at,
            fresh,
        }))
    }

    /// Returns true when the provider failed for a whole batch, after which
    /// the remaining symbols are left on their cached history.
    async fn refresh_daily_bars(
        &self,
        client: &Arc<AlpacaHttp>,
        symbols: &[String],
        now: DateTime<Utc>,
        cached: &mut HashMap<String, CachedDailyBars>,
        warnings: &mut Vec<String>,
    ) -> bool {
        let start = now - chrono::Duration::days(DAILY_BARS_LOOKBACK_DAYS);
        info!(count = symbols.len(), "requesting Alpaca IEX daily bars");
        for batch in symbols.chunks(DAILY_BARS_CONCURRENCY) {
            let mut requests = tokio::task::JoinSet::new();
            for symbol in batch {
                let client = Arc::clone(client);
                let symbol = symbol.clone();
                requests.spawn(async move {
                    let result = fetch_daily_bars(&client, &symbol, start, now).await;
                    (symbol, result)
                });
            }

            let mut succeeded = 0;
            while let Some(joined) = requests.join_next().await {
                let (symbol, result) = match joined {
                    Ok(output) => output,
                    Err(error) => {
                        warn!(%error, "daily bar request task failed");
                        continue;
                    }
                };
                match result {
                    Ok(stored) => {
                        succeeded += 1;
                        let fetched_at = now.to_rfc3339();
                        let key = format!("{DAILY_BARS_KEY_PREFIX}{symbol}");
                        match serde_json::to_string(&stored) {
                            Ok(payload) => {
                                if let Err(error) = self
                                    .market_data_repository
                                    .store_payload(&key, &payload, &fetched_at)
                                    .await
                                {
                                    warn!(%symbol, %error, "failed to persist daily bars");
                                    warnings
                                        .push(format!("Daily bar cache write failed for {symbol}"));
                                }
                            }
                            Err(error) => warn!(%symbol, %error, "failed to encode daily bars"),
                        }
                        cached.insert(
                            symbol,
                            CachedDailyBars {
                                bars: stored.bars,
                                fetched_at,
                                fresh: true,
                            },
                        );
                    }
                    Err(error) => {
                        warn!(%symbol, %error, "Alpaca daily bar request failed");
                        warnings.push(format!("Alpaca daily bar request failed for {symbol}"));
                    }
                }
            }
            if succeeded == 0 {
                warnings.push("Alpaca daily bar refresh stopped after a failed batch".to_owned());
                return true;
            }
        }
        false
    }

    fn daily_bar_stats_response(
        &self,
        status: AlpacaQuoteStatus,
        stats: Vec<DailyBarStats>,
        warnings: Vec<String>,
    ) -> DailyBarStatsResponse {
        DailyBarStatsResponse {
            generated_at: Utc::now().to_rfc3339(),
            provider: "alpaca",
            feed: "iex",
            enabled: self.settings.enabled,
            status,
            lookback_days: DAILY_BARS_LOOKBACK_DAYS,
            refresh_hours: DAILY_BARS_REFRESH_HOURS,
            stats,
            warnings,
        }
    }

    pub async fn latest_quotes(&self, symbols_param: &str) -> AlpacaQuotesResponse {
        let _guard = self.refresh_gate.lock().await;
        // Successful cache reads remain available even while the shared
        // provider is cooling down; only network access is paused.
        self.latest_quotes_inner(symbols_param).await
    }

    pub fn batch_size(&self) -> usize {
        self.settings.max_symbols_per_request.clamp(1, 200)
    }

    pub async fn market_calendar(
        &self,
        start: chrono::NaiveDate,
        end: chrono::NaiveDate,
    ) -> anyhow::Result<Vec<apca::api::v2::calendar::OpenClose>> {
        anyhow::ensure!(self.settings.enabled, "Alpaca disabled");
        let client = self
            .client
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("Alpaca credentials unavailable"))?;
        let request = apca::api::v2::calendar::ListReqInit::default().init(start, end);
        client.calendar(&request).await
    }

    async fn latest_quotes_inner(&self, symbols_param: &str) -> AlpacaQuotesResponse {
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

            match client.quotes(&request).await {
                Ok(items) => {
                    let fetched_at = Instant::now();
                    let fetched_at_utc = Utc::now();
                    let mut fetched_symbols = HashSet::new();
                    let mut records = Vec::new();
                    for (symbol, quote) in items {
                        let symbol = symbol.to_ascii_uppercase();
                        if let Some(alpaca_quote) = convert_quote(
                            symbol.clone(),
                            quote,
                            fx_rate.rate,
                            fx_rate.source.clone(),
                        ) {
                            fetched_symbols.insert(symbol.clone());
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
        let status = if quotes.len() == symbols.len() && warnings.is_empty() {
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

    pub async fn persisted_quotes(&self, symbols_param: &str) -> AlpacaQuotesResponse {
        let mut warnings = Vec::new();
        let (symbols, rejected) =
            parse_symbols_param(symbols_param, self.settings.max_symbols_per_request);
        warnings.extend(rejected);

        if symbols.is_empty() {
            info!("Alpaca persisted quote read skipped because no valid symbols were requested");
            return self.response(AlpacaQuoteStatus::EmptyRequest, Vec::new(), warnings);
        }

        match self
            .market_data_repository
            .load_quotes("alpaca", "iex", &symbols)
            .await
        {
            Ok(records) => {
                let quotes_by_symbol = records
                    .iter()
                    .map(|record| (record.symbol.clone(), quote_from_record(record, true)))
                    .collect();
                let quotes = ordered_quotes(&symbols, &quotes_by_symbol);
                if !quotes.is_empty() {
                    warnings.push("Returned persisted Alpaca quotes from SQLite".to_owned());
                }
                let status = if quotes.len() == symbols.len() {
                    AlpacaQuoteStatus::Ok
                } else {
                    AlpacaQuoteStatus::Partial
                };
                self.response(status, quotes, warnings)
            }
            Err(error) => {
                warn!(%error, "failed to read persisted Alpaca quotes");
                warnings.push("Alpaca quote database cache read failed".to_owned());
                self.response(AlpacaQuoteStatus::Error, Vec::new(), warnings)
            }
        }
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

async fn fetch_daily_bars(
    client: &AlpacaHttp,
    symbol: &str,
    start: DateTime<Utc>,
    end: DateTime<Utc>,
) -> anyhow::Result<StoredDailyBars> {
    let mut request = bars::ListReqInit {
        limit: Some(1000),
        adjustment: Some(bars::Adjustment::All),
        feed: Some(Feed::IEX),
        ..Default::default()
    }
    .init(symbol, start, end, bars::TimeFrame::OneDay);
    let mut bars = Vec::new();
    // Normally a single page for 400 calendar days; never silently truncate.
    for page_index in 0..5 {
        match client.bars(&request).await {
            Ok(page) => {
                anyhow::ensure!(
                    page.symbol == symbol,
                    "Alpaca bars returned a different symbol"
                );
                bars.extend(page.bars.iter().filter_map(convert_bar));
                if page.next_page_token.is_none() {
                    break;
                }
                anyhow::ensure!(page_index < 4, "Alpaca daily history exceeded page limit");
                request.page_token = page.next_page_token;
            }
            Err(error)
                if error
                    .downcast_ref::<ProviderRequestError>()
                    .is_some_and(|e| matches!(e.status, 400 | 404 | 422)) =>
            {
                // Invalid symbols are a cached empty result, not a host outage.
                return Ok(StoredDailyBars {
                    symbol: symbol.into(),
                    feed: "iex".into(),
                    adjustment: "all".into(),
                    bars: Vec::new(),
                });
            }
            Err(error) => return Err(error),
        }
    }
    Ok(StoredDailyBars {
        symbol: symbol.to_owned(),
        feed: "iex".to_owned(),
        adjustment: "all".to_owned(),
        bars,
    })
}

// Daily bars are stamped at midnight New York time, which is the same
// calendar date in UTC.
fn convert_bar(bar: &bars::Bar) -> Option<DailyBar> {
    let close = bar.close.to_f64().filter(|value| *value > 0.0)?;
    Some(DailyBar {
        date: bar.time.date_naive(),
        open: bar.open.to_f64()?,
        high: bar.high.to_f64()?,
        low: bar.low.to_f64()?,
        close,
    })
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
        fetched_at: record.fetched_at.to_rfc3339(),
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
    super::monitor_symbols::is_valid_alpaca_symbol(symbol)
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
        fetched_at: Utc::now().to_rfc3339(),
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
    use crate::{
        application::ports::fx_rate_cache::FxRateCache,
        config::FxRateSettings,
        infrastructure::db::{
            migrations::run_migrations, sqlite_fx_rate_cache::SqliteFxRateCache,
            sqlite_market_data_repository::SqliteMarketDataRepository,
        },
    };

    #[tokio::test]
    async fn daily_stats_serve_cached_history_and_mark_what_could_not_be_renewed()
    -> anyhow::Result<()> {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await?;
        run_migrations(&pool).await?;
        let repository: Arc<dyn MarketDataRepository> =
            Arc::new(SqliteMarketDataRepository::new(pool.clone()));
        let fx_cache: Arc<dyn FxRateCache> = Arc::new(SqliteFxRateCache::new(pool.clone()));
        let access = ProviderAccess::from_pool(pool, 0.0).await?;
        // Disabled provider: no client, so nothing can reach the network.
        let service = AlpacaMarketDataService::new(
            AlpacaSettings {
                enabled: false,
                max_symbols_per_request: 20,
                cache_ttl_seconds: 60,
                usd_eur_rate: 0.9,
            },
            FxRateService::new(
                fx_cache,
                FxRateSettings {
                    enabled: false,
                    endpoint: String::new(),
                    cache_ttl_seconds: 3600,
                    fallback_usd_eur_rate: 0.9,
                },
                access.clone(),
            ),
            Arc::clone(&repository),
            access,
        );

        let history = |symbol: &str| -> anyhow::Result<String> {
            let date = chrono::NaiveDate::from_ymd_opt(2026, 10, 1)
                .ok_or_else(|| anyhow::anyhow!("invalid date"))?;
            Ok(serde_json::to_string(&StoredDailyBars {
                symbol: symbol.to_owned(),
                feed: "iex".to_owned(),
                adjustment: "all".to_owned(),
                bars: vec![DailyBar {
                    date,
                    open: 10.0,
                    high: 11.0,
                    low: 9.0,
                    close: 10.5,
                }],
            })?)
        };
        let recent = Utc::now().to_rfc3339();
        let old = (Utc::now() - chrono::Duration::hours(DAILY_BARS_REFRESH_HOURS + 1)).to_rfc3339();
        repository
            .store_payload("alpaca_daily_bars:NEW", &history("NEW")?, &recent)
            .await?;
        repository
            .store_payload("alpaca_daily_bars:OLD", &history("OLD")?, &old)
            .await?;

        let response = service.daily_bar_stats("new,old,none", false).await;
        assert_eq!(response.status, AlpacaQuoteStatus::Disabled);
        let stale: Vec<_> = response
            .stats
            .iter()
            .map(|stats| (stats.symbol.as_str(), stats.stale, stats.last_close))
            .collect();
        assert_eq!(
            stale,
            [("NEW", false, Some(10.5)), ("OLD", true, Some(10.5))]
        );
        assert!(
            response
                .warnings
                .iter()
                .any(|warning| warning == "No daily history available for NONE")
        );

        // A cache-only read never reports a provider problem.
        let cached = service.daily_bar_stats("new", true).await;
        assert_eq!(cached.status, AlpacaQuoteStatus::Ok);
        assert_eq!(cached.stats.len(), 1);
        assert_eq!(
            service.daily_bar_stats("", true).await.status,
            AlpacaQuoteStatus::EmptyRequest
        );
        Ok(())
    }

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
        for symbol in [
            "DISNEY", "INT.SUR.", "ZSCALER", "COREWEAV", "ABC.", "A.B.C", "ETF001",
        ] {
            assert!(
                !is_valid_alpaca_symbol(symbol),
                "{symbol} must not reach Alpaca"
            );
        }
        let (symbols, warnings) = parse_symbols_param(
            "DISNEY,INT.SUR.,ZSCALER,COREWEAV,DIS,ISRG,ZS,CRWV,BRK.B",
            20,
        );
        assert_eq!(symbols, vec!["DIS", "ISRG", "ZS", "CRWV", "BRK.B"]);
        assert_eq!(warnings.len(), 4);
    }

    #[test]
    fn persisted_quote_keeps_capture_and_market_times_separate() -> anyhow::Result<()> {
        let raw: last_quotes::Quote = serde_json::from_value(
            serde_json::json!({"t":"2026-09-04T20:00:00Z","ap":101,"as":10,"bp":99,"bs":10}),
        )?;
        let quote = convert_quote("NVDA".into(), raw, 0.9, "frankfurter".into())
            .ok_or_else(|| anyhow::anyhow!("fixture must have valid prices"))?;
        let fetched_at = "2026-09-06T22:00:00Z".parse()?;
        let restored = quote_from_record(&record_from_quote(&quote, fetched_at), true);
        assert_eq!(restored.fetched_at, "2026-09-06T22:00:00+00:00");
        assert_eq!(restored.price_as_of, "2026-09-04T20:00:00+00:00");
        assert_eq!(restored.price, 90.0);
        assert!(!is_fresh(
            fetched_at,
            "2026-09-07T20:00:00Z".parse()?,
            Duration::from_secs(60)
        ));
        Ok(())
    }
}
