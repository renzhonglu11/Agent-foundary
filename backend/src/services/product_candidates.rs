//! Warrant search on onvista's public JSON endpoints. Candidates never enter portfolio accounting.
use std::{collections::HashMap, sync::Arc, time::Duration};

use anyhow::{Context, bail};
use chrono::{DateTime, NaiveDate, TimeDelta, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::SqlitePool;
use tokio::sync::Mutex;

use super::provider_access::{
    ProviderAccess, ProviderBudgetExhausted, ProviderCoolingDown, ProviderRequestError,
};
use crate::{application::services::fx_rate_service::FxRateService, services::monitor_symbols};

// The endpoints serve onvista.de itself; they are not a documented API.
const ENDPOINT: &str = "https://api.onvista.de/api/v1";
const SOURCE: &str = "onvista";
const PAGE_SIZE: usize = 30;
const WATCHLIST_LIMIT: i64 = 100;
type ProviderCache = HashMap<String, (DateTime<Utc>, Value)>;

#[derive(Clone)]
pub struct ProductCandidates {
    pool: SqlitePool,
    fx: FxRateService,
    endpoint: String,
    cache: Arc<Mutex<ProviderCache>>,
    // Home-market tickers by underlying ISIN; they do not change while the process runs.
    symbols: Arc<Mutex<HashMap<String, Option<String>>>>,
    write_lock: Arc<Mutex<()>>,
    access: ProviderAccess,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CandidateSearch {
    pub query: Option<String>,
    pub roll_from: Option<String>,
    pub direction: Option<String>,
    pub min_expiry: Option<String>,
    pub offset: Option<usize>,
}

impl CandidateSearch {
    pub fn validate(&self) -> Result<(), &'static str> {
        if let Some(isin) = &self.roll_from {
            if !valid_isin(isin) {
                return Err("原持仓 ISIN 格式无效");
            }
        } else if self
            .query
            .as_ref()
            .is_none_or(|q| !(2..=80).contains(&q.trim().chars().count()))
        {
            return Err("请输入 2–80 个字符的标的名称、代码或产品 ISIN");
        }
        if self
            .direction
            .as_ref()
            .is_some_and(|d| d != "call" && d != "put")
        {
            return Err("方向必须为 call 或 put");
        }
        if self
            .min_expiry
            .as_ref()
            .is_some_and(|d| NaiveDate::parse_from_str(d, "%Y-%m-%d").is_err())
        {
            return Err("到期日格式必须为 YYYY-MM-DD");
        }
        if self.offset.unwrap_or(0) > 10_000 {
            return Err("搜索分页超出范围，请缩小条件");
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WarrantCandidate {
    pub isin: String,
    pub wkn: Option<String>,
    pub issuer: Option<String>,
    pub product_type: String,
    pub option_type: String,
    pub underlying_id: String,
    pub underlying_isin: Option<String>,
    pub underlying_name: String,
    pub underlying_symbol: Option<String>,
    pub underlying_currency: String,
    pub underlying_spot: Option<f64>,
    pub underlying_as_of: Option<String>,
    pub quote_currency: String,
    pub bid: Option<f64>,
    pub ask: Option<f64>,
    pub quote_as_of: Option<String>,
    pub expiry: String,
    pub strike_price: Option<f64>,
    pub ratio: Option<f64>,
    pub iv: Option<f64>,
    pub delta: Option<f64>,
    pub omega: Option<f64>,
    pub tradable: Option<bool>,
    pub status: String,
    pub payment_style: String,
    pub source: String,
    pub source_url: String,
    pub fetched_at: String,
    pub usd_eur_rate: Option<f64>,
    pub fx_source: Option<String>,
    pub fx_as_of: Option<String>,
}

/// The instrument a warrant is written on, as onvista identifies it.
#[derive(Debug, Clone, PartialEq)]
struct Underlying {
    entity_type: String,
    entity_value: String,
    isin: Option<String>,
    name: String,
}

impl Underlying {
    fn parse(raw: &Value) -> Option<Self> {
        Some(Self {
            entity_type: text(&raw["entityType"])?,
            entity_value: text(&raw["entityValue"])?,
            isin: text(&raw["isin"]),
            name: text(&raw["name"])?,
        })
    }

    fn of(product: &WarrantCandidate) -> Option<Self> {
        let (entity_type, entity_value) = product.underlying_id.split_once(':')?;
        Some(Self {
            entity_type: entity_type.to_owned(),
            entity_value: entity_value.to_owned(),
            isin: product.underlying_isin.clone(),
            name: product.underlying_name.clone(),
        })
    }

    fn id(&self) -> String {
        format!("{}:{}", self.entity_type, self.entity_value)
    }
}

struct FinderPage {
    fetched_at: DateTime<Utc>,
    total: u64,
    rows: usize,
    items: Vec<WarrantCandidate>,
}

impl ProductCandidates {
    pub fn new(
        pool: SqlitePool,
        fx: FxRateService,
        access: ProviderAccess,
    ) -> anyhow::Result<Self> {
        Ok(Self {
            pool,
            fx,
            endpoint: ENDPOINT.into(),
            cache: Arc::new(Mutex::new(HashMap::new())),
            symbols: Arc::new(Mutex::new(HashMap::new())),
            write_lock: Arc::new(Mutex::new(())),
            access,
        })
    }

    // One in-flight provider request, bounded cache, and no automatic retry loop.
    // A cached response keeps its original capture time; errors never overwrite data.
    async fn get(
        &self,
        path: &str,
        query: &[(&str, String)],
    ) -> anyhow::Result<(DateTime<Utc>, Value)> {
        let url = reqwest::Url::parse_with_params(&format!("{}/{path}", self.endpoint), query)?;
        let key = url.to_string();
        let mut cache = self.cache.lock().await;
        if let Some((at, value)) = cache.get(&key) {
            if Utc::now() - *at < TimeDelta::minutes(5) {
                return Ok((*at, value.clone()));
            }
        }
        let data: Value = self
            .access
            .json("api.onvista.de", &key, |client| {
                client.get(url).header("Accept", "application/json")
            })
            .await?;
        if !data.is_object() {
            bail!("onvista response is not a JSON object");
        }
        let at = Utc::now();
        cache.retain(|_, (saved, _)| at - *saved < TimeDelta::minutes(5));
        if cache.len() >= 128 {
            cache.clear();
        }
        cache.insert(key, (at, data.clone()));
        Ok((at, data))
    }

    pub async fn provider_status(&self) -> anyhow::Result<Value> {
        self.access.status().await
    }

    async fn lookup(&self, isin: &str) -> anyhow::Result<WarrantCandidate> {
        let (at, data) = self
            .get(&format!("derivatives/ISIN:{isin}/snapshot"), &[])
            .await?;
        let mut product =
            parse_snapshot(&data, at).context("未找到可支持的普通权证，或产品条款不完整")?;
        if product.isin != isin {
            bail!("Provider returned a different ISIN");
        }
        product.underlying_symbol = self.symbol(&product).await;
        Ok(product)
    }

    // The shared registry decides first. Otherwise the provider's home-market
    // ticker is accepted only for a US security quoted in USD. Nothing is
    // inferred from a company name, so ADRs and second listings stay unmapped.
    async fn symbol(&self, product: &WarrantCandidate) -> Option<String> {
        let isin = product.underlying_isin.as_deref()?;
        if let Some(symbol) = monitor_symbols::registry_symbol(isin) {
            return Some(symbol);
        }
        if !isin.starts_with("US") || product.underlying_currency != "USD" {
            return None;
        }
        if let Some(known) = self.symbols.lock().await.get(isin) {
            return known.clone();
        }
        let query = [("limit", "5".to_owned()), ("searchValue", isin.to_owned())];
        // A failed request is not remembered as "no ticker".
        let (_, data) = self.get("instruments/query", &query).await.ok()?;
        let found = home_symbol(&data, isin);
        self.symbols
            .lock()
            .await
            .insert(isin.to_owned(), found.clone());
        found
    }

    async fn find_underlying(&self, phrase: &str) -> anyhow::Result<Option<Underlying>> {
        let query = [
            ("limit", "10".to_owned()),
            ("searchValue", phrase.to_owned()),
        ];
        let (_, data) = self.get("instruments/query", &query).await?;
        Ok(first_underlying(&data))
    }

    async fn find(
        &self,
        underlying: &Underlying,
        direction: &str,
        earliest: NaiveDate,
        page: usize,
        per_page: usize,
    ) -> anyhow::Result<FinderPage> {
        let query = finder_query(underlying, direction, earliest, page, per_page);
        let (fetched_at, data) = self
            .get("derivatives/finder/configuration_query", &query)
            .await?;
        let rows = data["list"]
            .as_array()
            .context("onvista finder response missing product list")?;
        Ok(FinderPage {
            fetched_at,
            total: data["total"]
                .as_u64()
                .context("onvista finder response missing result count")?,
            rows: rows.len(),
            items: rows
                .iter()
                .filter_map(|row| parse_finder_row(row, fetched_at))
                .collect(),
        })
    }

    async fn add_fx(&self, items: &mut [WarrantCandidate]) {
        if items.iter().any(|p| p.underlying_currency == "USD") {
            let rate = self.fx.usd_eur_rate().await;
            for item in items.iter_mut().filter(|p| p.underlying_currency == "USD") {
                item.usd_eur_rate = Some(rate.rate);
                item.fx_source = Some(rate.source.clone());
                item.fx_as_of = Some(rate.fetched_at.to_rfc3339());
            }
        }
    }

    pub async fn search(&self, request: &CandidateSearch) -> anyhow::Result<Value> {
        request.validate().map_err(anyhow::Error::msg)?;
        let today = Utc::now().date_naive();
        let offset = request.offset.unwrap_or(0);
        let mut origin = None;
        let underlying = if let Some(isin) = &request.roll_from {
            let held = self.lookup(isin).await?;
            let underlying =
                Underlying::of(&held).context("held warrant has no searchable underlying")?;
            origin = Some(held);
            underlying
        } else {
            let phrase = request.query.as_deref().unwrap_or_default().trim();
            // A product ISIN names one warrant; anything else names an underlying.
            if valid_isin(phrase) {
                if let Ok(product) = self.lookup(phrase).await {
                    let mut items: Vec<_> = Some(product)
                        .into_iter()
                        .filter(|p| matches_search(p, request, None, today))
                        .collect();
                    self.add_fx(&mut items).await;
                    return Ok(result_page(
                        &items,
                        None,
                        1,
                        offset,
                        None,
                        1,
                        Utc::now(),
                        None,
                    ));
                }
            }
            match self.find_underlying(phrase).await? {
                Some(underlying) => underlying,
                None => return Ok(result_page(&[], None, 0, offset, None, 0, Utc::now(), None)),
            }
        };

        let earliest = earliest_expiry(request, origin.as_ref(), today)?;
        // The finder lists one direction per request.
        let directions: Vec<String> = match origin
            .as_ref()
            .map(|p| p.option_type.clone())
            .or_else(|| request.direction.clone())
        {
            Some(direction) => vec![direction],
            None => vec!["call".into(), "put".into()],
        };
        let (page, per_page) = (offset / PAGE_SIZE, PAGE_SIZE / directions.len());
        let (mut items, mut total, mut rows, mut more) = (Vec::new(), 0, 0, false);
        let mut fetched_at = Utc::now();
        for direction in &directions {
            let found = self
                .find(&underlying, direction, earliest, page, per_page)
                .await?;
            fetched_at = fetched_at.min(found.fetched_at);
            total += found.total;
            rows += found.rows;
            more |= (((page + 1) * per_page) as u64) < found.total;
            items.extend(found.items);
        }

        // Finder rows carry no underlying price. One snapshot of the same
        // underlying supplies it for the whole page.
        let reference = match (&origin, items.first()) {
            (Some(held), _) => Some(held.clone()),
            (None, Some(first)) => self.lookup(&first.isin).await.ok(),
            (None, None) => None,
        };
        if let Some(reference) = &reference {
            for item in &mut items {
                item.adopt_underlying_quote(reference);
            }
        }
        items.retain(|p| matches_search(p, request, origin.as_ref(), today));
        items.sort_by(|a, b| a.expiry.cmp(&b.expiry));
        self.add_fx(&mut items).await;
        if let Some(p) = &mut origin {
            self.add_fx(std::slice::from_mut(p)).await;
        }
        let next = offset + PAGE_SIZE;
        Ok(result_page(
            &items,
            origin.as_ref(),
            total,
            offset,
            (rows > 0 && more && next <= 10_000).then_some(next),
            rows,
            fetched_at,
            Some(&underlying),
        ))
    }

    pub async fn watchlist(&self) -> anyhow::Result<Value> {
        let rows: Vec<String> = sqlx::query_scalar(
            "SELECT product_json FROM product_watchlist ORDER BY added_at DESC, isin",
        )
        .fetch_all(&self.pool)
        .await?;
        let items: Vec<WarrantCandidate> = rows
            .iter()
            .map(|s| serde_json::from_str(s))
            .collect::<Result<_, _>>()?;
        Ok(json!({"items":items,"limit":WATCHLIST_LIMIT}))
    }

    pub async fn save(&self, isin: &str) -> anyhow::Result<WarrantCandidate> {
        if !valid_isin(isin) {
            bail!("Invalid ISIN");
        }
        let mut product = self.lookup(isin).await?;
        self.add_fx(std::slice::from_mut(&mut product)).await;
        let _guard = self.write_lock.lock().await;
        persist_candidate(&self.pool, &product).await?;
        Ok(product)
    }

    pub async fn remove(&self, isin: &str) -> anyhow::Result<()> {
        let _guard = self.write_lock.lock().await;
        sqlx::query("DELETE FROM product_watchlist WHERE isin = ?")
            .bind(isin)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub fn start_watchlist_refresh(&self) {
        let service = self.clone();
        tokio::spawn(async move {
            loop {
                let ids: Result<Vec<String>, _> = sqlx::query_scalar(
                    "SELECT isin FROM product_watchlist ORDER BY updated_at LIMIT 100",
                )
                .fetch_all(&service.pool)
                .await;
                match ids {
                    Ok(ids) => {
                        for isin in ids {
                            // Deletion during refresh must not re-add the user's candidate.
                            let result = async {
                                let mut product = service.lookup(&isin).await?;
                                service.add_fx(std::slice::from_mut(&mut product)).await;
                                let _guard = service.write_lock.lock().await;
                                let exists: bool = sqlx::query_scalar(
                                    "SELECT EXISTS(SELECT 1 FROM product_watchlist WHERE isin = ?)",
                                )
                                .bind(&isin)
                                .fetch_one(&service.pool)
                                .await?;
                                if exists {
                                    persist_candidate(&service.pool, &product).await?;
                                }
                                Ok::<(), anyhow::Error>(())
                            }
                            .await;
                            if let Err(error) = result {
                                tracing::warn!(%error, %isin, "watchlist refresh failed; retaining previous observation");
                                if refused(&error) {
                                    // The source turned the client away; the rest of
                                    // the list would only repeat the refusal.
                                    tracing::warn!(
                                        "product source refused the request; ending this watchlist refresh"
                                    );
                                    break;
                                }
                            }
                            tokio::time::sleep(Duration::from_millis(500)).await;
                        }
                    }
                    Err(error) => {
                        tracing::warn!(%error, "cannot read product watchlist for refresh")
                    }
                }
                tokio::time::sleep(Duration::from_secs(6 * 60 * 60)).await;
            }
        });
    }
}

impl WarrantCandidate {
    /// Takes the underlying's price, its time and its ticker from another
    /// warrant on the same underlying in the same currency.
    fn adopt_underlying_quote(&mut self, reference: &WarrantCandidate) {
        if self.underlying_id != reference.underlying_id
            || self.underlying_currency != reference.underlying_currency
        {
            return;
        }
        if self.underlying_spot.is_none() {
            self.underlying_spot = reference.underlying_spot;
            self.underlying_as_of
                .clone_from(&reference.underlying_as_of);
        }
        if self.underlying_symbol.is_none() {
            self.underlying_symbol
                .clone_from(&reference.underlying_symbol);
        }
    }
}

/// HTTP 403 and 429 answer the client, not the product that was asked for.
fn refused(error: &anyhow::Error) -> bool {
    if error.downcast_ref::<ProviderCoolingDown>().is_some()
        || error.downcast_ref::<ProviderBudgetExhausted>().is_some()
    {
        return true;
    }
    error
        .downcast_ref::<ProviderRequestError>()
        .is_some_and(|e| matches!(e.status, 0 | 401 | 403 | 429 | 500..=599))
}

#[allow(clippy::too_many_arguments)]
fn result_page(
    items: &[WarrantCandidate],
    origin: Option<&WarrantCandidate>,
    total: u64,
    offset: usize,
    next_offset: Option<usize>,
    rows: usize,
    fetched_at: DateTime<Utc>,
    underlying: Option<&Underlying>,
) -> Value {
    let scope = match underlying {
        Some(u) => format!(
            "onvista 可检索的普通权证，匹配标的：{}{}；含多家发行人，不代表全市场或你的券商可交易范围",
            u.name,
            u.isin
                .as_deref()
                .map(|isin| format!("（{isin}）"))
                .unwrap_or_default()
        ),
        None if total == 0 => "onvista 没有找到与输入匹配的标的".to_owned(),
        None => "按产品 ISIN 在 onvista 查到的单只普通权证".to_owned(),
    };
    json!({"items":items,"origin":origin,"total":total,"offset":offset,"nextOffset":next_offset,
        "excludedCount":rows.saturating_sub(items.len()),"fetchedAt":fetched_at,"source":SOURCE,
        "underlying":underlying.map(|u| json!({"id":u.id(),"name":u.name,"isin":u.isin})),"scope":scope})
}

fn earliest_expiry(
    request: &CandidateSearch,
    origin: Option<&WarrantCandidate>,
    today: NaiveDate,
) -> anyhow::Result<NaiveDate> {
    let mut earliest = today + TimeDelta::days(1);
    if let Some(date) = &request.min_expiry {
        earliest = earliest.max(NaiveDate::parse_from_str(date, "%Y-%m-%d")?);
    }
    if let Some(held) = origin {
        earliest =
            earliest.max(NaiveDate::parse_from_str(&held.expiry, "%Y-%m-%d")? + TimeDelta::days(1));
    }
    Ok(earliest)
}

fn finder_query(
    underlying: &Underlying,
    direction: &str,
    earliest: NaiveDate,
    page: usize,
    per_page: usize,
) -> Vec<(&'static str, String)> {
    // onvista numbers the exercise right: 1 is a put, 2 a call.
    let right = if direction == "put" { 1 } else { 2 };
    vec![
        ("entityTypeUnderlying", underlying.entity_type.clone()),
        ("entityValueUnderlying", underlying.entity_value.clone()),
        ("page", page.to_string()),
        ("perPage", per_page.to_string()),
        ("sort", "dateMaturity".into()),
        ("order", "ASC".into()),
        (
            "queryParameters",
            format!("entitySubType=WARRANT&idExerciseRight={right}&dateMaturityRange={earliest};"),
        ),
    ]
}

fn matches_search(
    p: &WarrantCandidate,
    request: &CandidateSearch,
    origin: Option<&WarrantCandidate>,
    today: NaiveDate,
) -> bool {
    if p.status != "ACTIVE" || p.expiry.as_str() <= today.to_string().as_str() {
        return false;
    }
    if request
        .min_expiry
        .as_ref()
        .is_some_and(|min| p.expiry < *min)
    {
        return false;
    }
    if let Some(held) = origin {
        p.isin != held.isin
            && p.underlying_id == held.underlying_id
            && p.option_type == held.option_type
            && p.expiry > held.expiry
    } else {
        request
            .direction
            .as_ref()
            .is_none_or(|d| p.option_type == *d)
    }
}

pub fn valid_isin(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 12
        || !bytes[..2].iter().all(u8::is_ascii_uppercase)
        || !bytes[11].is_ascii_digit()
    {
        return false;
    }
    if !bytes
        .iter()
        .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit())
    {
        return false;
    }
    let digits: String = bytes
        .iter()
        .map(|b| {
            if b.is_ascii_digit() {
                char::from(*b).to_string()
            } else {
                (b - b'A' + 10).to_string()
            }
        })
        .collect();
    digits
        .bytes()
        .rev()
        .enumerate()
        .map(|(i, b)| {
            let n = (b - b'0') as u32 * if i % 2 == 1 { 2 } else { 1 };
            n / 10 + n % 10
        })
        .sum::<u32>()
        % 10
        == 0
}

fn text(value: &Value) -> Option<String> {
    value
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .map(str::to_owned)
}
fn positive(value: &Value) -> Option<f64> {
    value.as_f64().filter(|v| v.is_finite() && *v > 0.0)
}
fn instant(value: &Value) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value.as_str()?)
        .ok()
        .map(|time| time.with_timezone(&Utc))
}

// Only instruments a warrant can be written on; a product or a future is not one.
fn first_underlying(search: &Value) -> Option<Underlying> {
    search["list"]
        .as_array()?
        .iter()
        .filter(|hit| {
            !matches!(
                hit["entityType"].as_str(),
                None | Some("DERIVATIVE" | "FUTURE" | "OPTION")
            )
        })
        .find_map(Underlying::parse)
}

fn home_symbol(search: &Value, isin: &str) -> Option<String> {
    search["list"]
        .as_array()?
        .iter()
        .find(|hit| hit["isin"] == isin)
        .and_then(|hit| text(&hit["homeSymbol"]))
        .filter(|symbol| monitor_symbols::is_valid_alpaca_symbol(symbol))
}

/// One warrant as onvista describes it. A snapshot and a finder row hold the
/// same facts in different places.
struct Listing<'a> {
    instrument: &'a Value,
    issuer: &'a Value,
    right: &'a Value,
    maturity: &'a Value,
    quanto: &'a Value,
    open_ended: &'a Value,
    barrier_hit: &'a Value,
    bid_only: &'a Value,
    underlying: &'a Value,
    underlying_currency: &'a Value,
    strike: &'a Value,
    ratio: &'a Value,
    iv: &'a Value,
    omega: &'a Value,
    delta: &'a Value,
    quote: &'a Value,
    spot: Option<(f64, Option<DateTime<Utc>>)>,
}

fn parse_snapshot(raw: &Value, captured: DateTime<Utc>) -> Option<WarrantCandidate> {
    let details = &raw["derivativesDetails"];
    let figure = &raw["derivativesFigure"];
    let underlyings = raw["derivativesUnderlyingList"]["list"].as_array()?;
    if underlyings.len() != 1
        || details["numberUnderlyings"]
            .as_u64()
            .is_some_and(|n| n != 1)
    {
        return None;
    }
    let underlying = &underlyings[0];
    let strike = underlying["derivativesBarrierList"]["list"]
        .as_array()?
        .iter()
        .find(|barrier| barrier["typeBarrier"] == "STRIKE")?;
    // The price belongs to the warrant only in the underlying's own currency.
    let spot = positive(&figure["priceUnderlying"])
        .filter(|_| figure["isoCurrencyUnderlying"] == underlying["isoCurrency"])
        .map(|price| (price, instant(&figure["datetimePriceUnderlying"])));
    candidate(
        Listing {
            instrument: &raw["instrument"],
            issuer: &raw["derivativesIssuer"],
            right: &details["codeExerciseRight"],
            maturity: &details["datetimeMaturity"],
            quanto: &details["quanto"],
            open_ended: &details["openEnded"],
            barrier_hit: &details["hasBarrierBeenHit"],
            bid_only: &details["hasOnlyBidPrices"],
            underlying: &underlying["instrument"],
            underlying_currency: &underlying["isoCurrency"],
            strike: &strike["barrier"],
            ratio: &underlying["coverRatio"],
            iv: if figure["impliedVolatilityAsk"].is_number() {
                &figure["impliedVolatilityAsk"]
            } else {
                &figure["impliedVolatility"]
            },
            omega: &figure["leverage"],
            delta: &figure["delta"],
            quote: &raw["quote"],
            spot,
        },
        captured,
    )
}

fn parse_finder_row(raw: &Value, captured: DateTime<Utc>) -> Option<WarrantCandidate> {
    candidate(
        Listing {
            instrument: &raw["instrument"],
            issuer: &raw["issuer"],
            right: &raw["codeExerciseRight"],
            maturity: &raw["dateMaturity"],
            quanto: &raw["quanto"],
            open_ended: &raw["openEnded"],
            barrier_hit: &Value::Null,
            bid_only: &Value::Null,
            underlying: &raw["instrumentUnderlying"],
            underlying_currency: &raw["isoCurrencyUnderlying"],
            strike: &raw["strikeAbs"],
            ratio: &raw["coverRatio"],
            iv: &raw["impliedVolatilityAsk"],
            omega: &raw["leverage"],
            delta: &Value::Null,
            quote: &raw["quote"],
            spot: None,
        },
        captured,
    )
}

fn candidate(listing: Listing, captured: DateTime<Utc>) -> Option<WarrantCandidate> {
    let isin = text(&listing.instrument["isin"])?;
    if !valid_isin(&isin)
        || listing.instrument["entitySubType"] != "WARRANT"
        || listing.open_ended.as_bool() == Some(true)
    {
        return None;
    }
    let option_type = match listing.right.as_str()? {
        "C" => "call",
        "P" => "put",
        _ => return None,
    };
    let expiry = instant(listing.maturity)?.date_naive().to_string();
    let underlying = Underlying::parse(listing.underlying)?;
    let quote = listing.quote;
    // The older side dates a two-sided quote.
    let quote_as_of = [
        instant(&quote["datetimeBid"]),
        instant(&quote["datetimeAsk"]),
    ]
    .into_iter()
    .flatten()
    .min();
    // onvista states no trading status. A size on both sides means the issuer
    // is quoting the warrant both ways; a bid-only product cannot be bought.
    let tradable = if listing.bid_only.as_bool() == Some(true) {
        Some(false)
    } else {
        quote["volumeBid"]
            .as_f64()
            .zip(quote["volumeAsk"].as_f64())
            .map(|(bid, ask)| bid > 0.0 && ask > 0.0)
    };
    let website = text(&listing.instrument["urls"]["WEBSITE"])
        .filter(|url| url.starts_with("https://www.onvista.de/"));
    Some(WarrantCandidate {
        source_url: website
            .unwrap_or_else(|| format!("https://www.onvista.de/suche?searchValue={isin}")),
        isin,
        wkn: text(&listing.instrument["wkn"]),
        issuer: text(&listing.issuer["name"]),
        product_type: "optionsschein".into(),
        option_type: option_type.into(),
        underlying_id: underlying.id(),
        underlying_isin: underlying.isin,
        underlying_name: underlying.name,
        underlying_symbol: None,
        underlying_currency: text(listing.underlying_currency).unwrap_or_default(),
        underlying_spot: listing.spot.map(|(price, _)| price),
        underlying_as_of: listing
            .spot
            .and_then(|(_, time)| time)
            .map(|time| time.to_rfc3339()),
        quote_currency: text(&quote["isoCurrency"]).unwrap_or_default(),
        bid: positive(&quote["bid"]),
        ask: positive(&quote["ask"]),
        quote_as_of: quote_as_of.map(|time| time.to_rfc3339()),
        expiry,
        strike_price: positive(listing.strike),
        ratio: positive(listing.ratio),
        // onvista reports percentage points, including values below one percent.
        iv: positive(listing.iv).map(|v| v / 100.0),
        delta: listing.delta.as_f64(),
        omega: positive(listing.omega),
        tradable,
        status: if listing.barrier_hit.as_bool() == Some(true) {
            "KNOCKED_OUT"
        } else {
            "ACTIVE"
        }
        .into(),
        payment_style: match listing.quanto.as_bool() {
            Some(false) => "DOMESTIC",
            Some(true) => "QUANTO",
            None => "",
        }
        .into(),
        source: SOURCE.into(),
        fetched_at: captured.to_rfc3339(),
        usd_eur_rate: None,
        fx_source: None,
        fx_as_of: None,
    })
}

async fn persist_candidate(pool: &SqlitePool, product: &WarrantCandidate) -> anyhow::Result<()> {
    let mut tx = pool.begin().await?;
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM product_watchlist WHERE isin != ?")
        .bind(&product.isin)
        .fetch_one(&mut *tx)
        .await?;
    if count >= WATCHLIST_LIMIT {
        bail!("观察列表最多保存 {WATCHLIST_LIMIT} 只产品");
    }
    sqlx::query("INSERT INTO product_watchlist(isin,added_at,updated_at,product_json) VALUES(?,?,?,?) ON CONFLICT(isin) DO UPDATE SET updated_at=excluded.updated_at,product_json=excluded.product_json")
        .bind(&product.isin).bind(Utc::now().to_rfc3339()).bind(&product.fetched_at).bind(serde_json::to_string(product)?)
        .execute(&mut *tx).await?;
    // The IV is recorded under the associated quote's UTC date, never the fetch
    // date, so old quotes cannot create new days.
    if let (Some(iv), Some(at)) = (
        product.iv,
        product
            .quote_as_of
            .as_deref()
            .and_then(|s| DateTime::parse_from_rfc3339(s).ok()),
    ) {
        if at <= Utc::now() + TimeDelta::minutes(2)
            && at >= Utc::now() - TimeDelta::hours(36)
            && product.status == "ACTIVE"
        {
            sqlx::query("INSERT INTO structured_product_iv_history(isin,observed_on,iv,quote_price,underlying,greeks_source,observed_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(isin,observed_on) DO UPDATE SET iv=excluded.iv,quote_price=excluded.quote_price,underlying=excluded.underlying,greeks_source=excluded.greeks_source,observed_at=excluded.observed_at WHERE excluded.observed_at > structured_product_iv_history.observed_at")
                .bind(&product.isin).bind(at.date_naive().to_string()).bind(iv).bind(product.ask)
                .bind(&product.underlying_name).bind(format!("{}:watchlist_quote_date", product.source)).bind(at.to_rfc3339())
                .execute(&mut *tx).await?;
        }
    }
    tx.commit().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        config::FxRateSettings,
        infrastructure::db::{migrations::run_migrations, sqlite_fx_rate_cache::SqliteFxRateCache},
    };

    // Reduced copies of live onvista responses from 2026-11-10.
    fn snapshot() -> anyhow::Result<Value> {
        Ok(serde_json::from_str(include_str!(
            "fixtures/onvista_warrant_snapshot.json"
        ))?)
    }

    fn finder() -> anyhow::Result<Value> {
        Ok(serde_json::from_str(include_str!(
            "fixtures/onvista_warrant_finder.json"
        ))?)
    }

    fn instrument_search() -> anyhow::Result<Value> {
        Ok(serde_json::from_str(include_str!(
            "fixtures/onvista_instrument_search.json"
        ))?)
    }

    fn product() -> anyhow::Result<WarrantCandidate> {
        parse_snapshot(&snapshot()?, Utc::now()).context("fixture must parse")
    }

    async fn service() -> anyhow::Result<ProductCandidates> {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await?;
        run_migrations(&pool).await?;
        let access = ProviderAccess::from_pool(pool.clone(), 0.0).await?;
        let fx = FxRateService::new(
            Arc::new(SqliteFxRateCache::new(pool.clone())),
            FxRateSettings {
                enabled: false,
                endpoint: String::new(),
                cache_ttl_seconds: 3600,
                fallback_usd_eur_rate: 0.9,
            },
            access.clone(),
        );
        ProductCandidates::new(pool, fx, access)
    }

    #[test]
    fn validates_isin_checksum_and_search_bounds() {
        assert!(valid_isin("DE000UG7MVU1"));
        assert!(!valid_isin("DE000UG7MVU2"));
        assert!(!valid_isin("DE00<script>"));
        assert!(CandidateSearch::default().validate().is_err());
        assert!(
            CandidateSearch {
                query: Some("Tesla".into()),
                ..Default::default()
            }
            .validate()
            .is_ok()
        );
        assert!(
            CandidateSearch {
                roll_from: Some("DE000UG7MVU1".into()),
                offset: Some(10_001),
                ..Default::default()
            }
            .validate()
            .is_err()
        );
    }

    #[test]
    fn parses_a_real_snapshot_and_preserves_quote_times_and_units() -> anyhow::Result<()> {
        let mut raw = snapshot()?;
        let p = parse_snapshot(&raw, Utc::now()).context("parse")?;
        assert_eq!(p.isin, "DE000UG3NHT9");
        assert_eq!(p.issuer.as_deref(), Some("UniCredit"));
        assert_eq!(p.option_type, "call");
        assert_eq!(p.underlying_id, "STOCK:33837581");
        assert_eq!(p.underlying_isin.as_deref(), Some("US88160R1014"));
        assert_eq!(p.underlying_currency, "USD");
        assert_eq!(p.quote_currency, "EUR");
        assert_eq!(p.expiry, "2027-06-16");
        assert_eq!((p.strike_price, p.ratio), (Some(300.0), Some(0.1)));
        assert_eq!((p.bid, p.ask), (Some(9.6199), Some(9.63)));
        // The underlying is priced in its own currency and keeps its own time.
        assert_eq!(p.underlying_spot, Some(379.78));
        assert_eq!(
            p.underlying_as_of.as_deref(),
            Some("2026-11-10T21:00:00.390+00:00")
        );
        assert_eq!(
            p.quote_as_of.as_deref(),
            Some("2026-11-10T20:59:52.166+00:00")
        );
        assert_ne!(p.quote_as_of.as_deref(), Some(p.fetched_at.as_str()));
        // Percentage points at the source, a fraction here.
        assert!(p.iv.is_some_and(|iv| (iv - 0.572837753296).abs() < 1e-12));
        assert_eq!(
            (p.status.as_str(), p.payment_style.as_str()),
            ("ACTIVE", "DOMESTIC")
        );
        assert_eq!(p.tradable, Some(true));
        assert!(p.source_url.starts_with("https://www.onvista.de/derivate/"));

        raw["derivativesFigure"]["impliedVolatilityAsk"] = json!(0.5);
        assert_eq!(
            parse_snapshot(&raw, Utc::now()).context("low IV")?.iv,
            Some(0.005)
        );
        // The older side dates the quote; without any time it stays unknown.
        raw["quote"]["datetimeBid"] = json!("2026-11-10T20:00:00.000+00:00");
        assert_eq!(
            parse_snapshot(&raw, Utc::now())
                .context("older bid")?
                .quote_as_of
                .as_deref(),
            Some("2026-11-10T20:00:00+00:00")
        );
        raw["quote"]["datetimeBid"] = Value::Null;
        raw["quote"]["datetimeAsk"] = Value::Null;
        assert_eq!(
            parse_snapshot(&raw, Utc::now())
                .context("no time")?
                .quote_as_of,
            None
        );
        Ok(())
    }

    #[test]
    fn tradability_settlement_and_status_come_only_from_what_the_source_states()
    -> anyhow::Result<()> {
        let parsed = |change: &dyn Fn(&mut Value)| -> anyhow::Result<Option<WarrantCandidate>> {
            let mut raw = snapshot()?;
            change(&mut raw);
            Ok(parse_snapshot(&raw, Utc::now()))
        };
        let field = |change: &dyn Fn(&mut Value)| -> anyhow::Result<WarrantCandidate> {
            parsed(change)?.context("should still parse")
        };
        // No ask size: the issuer is not offering the warrant.
        assert_eq!(
            field(&|raw| raw["quote"]["volumeAsk"] = json!(0.0))?.tradable,
            Some(false)
        );
        assert_eq!(
            field(&|raw| raw["derivativesDetails"]["hasOnlyBidPrices"] = json!(true))?.tradable,
            Some(false)
        );
        // Without sizes nothing is claimed either way.
        assert_eq!(
            field(&|raw| raw["quote"]["volumeBid"] = Value::Null)?.tradable,
            None
        );
        assert_eq!(
            field(&|raw| raw["derivativesDetails"]["quanto"] = json!(true))?.payment_style,
            "QUANTO"
        );
        assert_eq!(
            field(&|raw| raw["derivativesDetails"]["quanto"] = Value::Null)?.payment_style,
            ""
        );
        assert_eq!(
            field(&|raw| raw["derivativesDetails"]["hasBarrierBeenHit"] = json!(true))?.status,
            "KNOCKED_OUT"
        );
        // A price in another currency is not this warrant's underlying price.
        assert_eq!(
            field(&|raw| raw["derivativesFigure"]["isoCurrencyUnderlying"] = json!("EUR"))?
                .underlying_spot,
            None
        );
        // Not a plain single-underlying warrant.
        assert!(
            parsed(&|raw| raw["instrument"]["entitySubType"] = json!("KNOCKOUT_CERTIFICATE"))?
                .is_none()
        );
        assert!(parsed(&|raw| raw["derivativesDetails"]["openEnded"] = json!(true))?.is_none());
        assert!(
            parsed(&|raw| raw["derivativesDetails"]["numberUnderlyings"] = json!(2))?.is_none()
        );
        assert!(
            parsed(&|raw| raw["derivativesDetails"]["codeExerciseRight"] = json!("X"))?.is_none()
        );
        assert!(
            parsed(&|raw| {
                raw["derivativesUnderlyingList"]["list"][0]["derivativesBarrierList"]["list"] =
                    json!([])
            })?
            .is_none()
        );
        Ok(())
    }

    #[test]
    fn finder_rows_take_the_underlying_price_only_from_the_same_underlying() -> anyhow::Result<()> {
        let rows = finder()?;
        let mut row = parse_finder_row(&rows["list"][1], Utc::now()).context("row")?;
        assert_eq!(row.isin, "DE000UG83QC8");
        assert_eq!(
            (row.option_type.as_str(), row.expiry.as_str()),
            ("call", "2027-06-16")
        );
        assert_eq!((row.strike_price, row.ratio), (Some(305.0), Some(0.1)));
        assert_eq!(row.underlying_id, "STOCK:33837581");
        assert!(row.bid.is_some() && row.ask.is_some() && row.quote_as_of.is_some());
        assert_eq!(row.payment_style, "DOMESTIC");
        // The finder lists no underlying price and no delta.
        assert_eq!((row.underlying_spot, row.delta), (None, None));

        let mut reference = product()?;
        reference.underlying_symbol = Some("TSLA".into());
        let mut other = row.clone();
        other.underlying_id = "STOCK:1".into();
        other.adopt_underlying_quote(&reference);
        assert_eq!(
            (other.underlying_spot, other.underlying_symbol),
            (None, None)
        );
        let mut other = row.clone();
        other.underlying_currency = "EUR".into();
        other.adopt_underlying_quote(&reference);
        assert_eq!(other.underlying_spot, None);

        row.adopt_underlying_quote(&reference);
        assert_eq!(row.underlying_spot, Some(379.78));
        assert_eq!(row.underlying_as_of, reference.underlying_as_of);
        assert_eq!(row.underlying_symbol.as_deref(), Some("TSLA"));
        Ok(())
    }

    #[test]
    fn roll_search_uses_exact_underlying_direction_and_strictly_later_expiry() -> anyhow::Result<()>
    {
        let origin = product()?;
        let request = CandidateSearch {
            roll_from: Some(origin.isin.clone()),
            query: Some("wrong name".into()),
            direction: Some("put".into()),
            ..Default::default()
        };
        let today = NaiveDate::from_ymd_opt(2026, 11, 10).context("date")?;
        let earliest = earliest_expiry(&request, Some(&origin), today)?;
        assert_eq!(earliest.to_string(), "2027-06-17");
        let underlying = Underlying::of(&origin).context("underlying")?;
        let query: HashMap<_, _> = finder_query(&underlying, &origin.option_type, earliest, 2, 30)
            .into_iter()
            .collect();
        assert_eq!(query["entityTypeUnderlying"], "STOCK");
        assert_eq!(query["entityValueUnderlying"], "33837581");
        assert_eq!(
            (query["page"].as_str(), query["perPage"].as_str()),
            ("2", "30")
        );
        // The held warrant is a call, whatever the request says; 2 is onvista's call.
        assert_eq!(
            query["queryParameters"],
            "entitySubType=WARRANT&idExerciseRight=2&dateMaturityRange=2027-06-17;"
        );
        assert!(
            finder_query(&underlying, "put", earliest, 0, 15)
                .iter()
                .any(|(_, value)| value.contains("idExerciseRight=1&"))
        );
        // Without a held warrant the request's own date and tomorrow bound the search.
        let free = CandidateSearch {
            query: Some("Tesla".into()),
            min_expiry: Some("2027-01-01".into()),
            ..Default::default()
        };
        assert_eq!(
            earliest_expiry(&free, None, today)?.to_string(),
            "2027-01-01"
        );
        assert_eq!(
            earliest_expiry(&CandidateSearch::default(), None, today)?.to_string(),
            "2026-11-11"
        );

        let mut candidate = origin.clone();
        candidate.isin = "DE000UG83QC8".into();
        candidate.expiry = "2027-12-17".into();
        assert!(matches_search(&candidate, &request, Some(&origin), today));
        candidate.underlying_id = "STOCK:204675797".into();
        assert!(!matches_search(&candidate, &request, Some(&origin), today));
        candidate.underlying_id = origin.underlying_id.clone();
        candidate.option_type = "put".into();
        assert!(!matches_search(&candidate, &request, Some(&origin), today));
        candidate.option_type = "call".into();
        candidate.expiry = origin.expiry.clone();
        assert!(!matches_search(&candidate, &request, Some(&origin), today));
        Ok(())
    }

    #[test]
    fn a_phrase_resolves_to_an_underlying_and_a_ticker_only_by_exact_isin() -> anyhow::Result<()> {
        let mut search = instrument_search()?;
        let underlying = first_underlying(&search).context("underlying")?;
        assert_eq!(underlying.id(), "STOCK:33837581");
        assert_eq!(underlying.isin.as_deref(), Some("US88160R1014"));
        assert_eq!(
            home_symbol(&search, "US88160R1014").as_deref(),
            Some("TSLA")
        );
        // The Canadian receipt shares the ticker text but is another security.
        assert_eq!(home_symbol(&search, "US0000000000"), None);
        // A product or a future in front is not an underlying.
        let hits = search["list"].as_array_mut().context("list")?;
        hits.retain(|hit| hit["entityType"] != "STOCK");
        assert_eq!(first_underlying(&search), None);
        Ok(())
    }

    #[tokio::test]
    async fn watchlist_upserts_do_not_create_holdings_or_fake_iv_observation_days()
    -> anyhow::Result<()> {
        let service = service().await?;
        let mut p = product()?;
        let at = Utc::now()
            .date_naive()
            .and_hms_opt(0, 0, 0)
            .context("midnight")?
            .and_utc()
            - TimeDelta::hours(1);
        p.quote_as_of = Some(at.to_rfc3339());
        persist_candidate(&service.pool, &p).await?;
        p.fetched_at = (Utc::now() + TimeDelta::days(1)).to_rfc3339();
        persist_candidate(&service.pool, &p).await?;
        assert_eq!(
            service.watchlist().await?["items"]
                .as_array()
                .context("items")?
                .len(),
            1
        );
        let days: Vec<(String, String)> =
            sqlx::query_as("SELECT observed_on, greeks_source FROM structured_product_iv_history")
                .fetch_all(&service.pool)
                .await?;
        assert_eq!(
            days,
            vec![(
                at.date_naive().to_string(),
                "onvista:watchlist_quote_date".to_owned()
            )]
        );
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM transactions")
            .fetch_one(&service.pool)
            .await?;
        assert_eq!(count, 0);
        p.quote_as_of = Some(Utc::now().to_rfc3339());
        persist_candidate(&service.pool, &p).await?;
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM structured_product_iv_history")
            .fetch_one(&service.pool)
            .await?;
        assert_eq!(count, 2);
        p.quote_as_of = Some((Utc::now() - TimeDelta::days(3)).to_rfc3339());
        persist_candidate(&service.pool, &p).await?;
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM structured_product_iv_history")
            .fetch_one(&service.pool)
            .await?;
        assert_eq!(
            count, 2,
            "stale quotes cannot manufacture historical IV observations"
        );
        service.remove(&p.isin).await?;
        assert_eq!(service.watchlist().await?["items"], json!([]));
        Ok(())
    }

    #[tokio::test]
    async fn searches_by_name_with_few_cached_requests_and_reports_a_refusal() -> anyhow::Result<()>
    {
        use axum::{
            Json, Router,
            extract::{Path, Query, State},
            http::StatusCode,
            routing::get,
        };
        use std::sync::Mutex as SyncMutex;

        // Maturities move with the clock so the fixtures never expire.
        let maturity = (Utc::now() + TimeDelta::days(400)).to_rfc3339();
        let mut rows = finder()?;
        for row in rows["list"].as_array_mut().context("rows")? {
            row["dateMaturity"] = json!(maturity);
        }
        let mut detail = snapshot()?;
        detail["derivativesDetails"]["datetimeMaturity"] = json!(maturity);
        type Seen = Arc<SyncMutex<Vec<String>>>;
        let seen: Seen = Arc::new(SyncMutex::new(Vec::new()));
        let note = |seen: &Seen, entry: String| {
            if let Ok(mut list) = seen.lock() {
                list.push(entry);
            }
        };
        let app = Router::new()
            .route(
                "/instruments/query",
                get({
                    let hits = instrument_search()?;
                    move |State(seen): State<Seen>, Query(query): Query<HashMap<String, String>>| async move {
                        note(&seen, format!("instrument {}", query["searchValue"]));
                        match query["searchValue"].as_str() {
                            "refused" => Err(StatusCode::FORBIDDEN),
                            "nothing" => Ok(Json(json!({"list":[]}))),
                            _ => Ok(Json(hits)),
                        }
                    }
                }),
            )
            .route(
                "/derivatives/finder/configuration_query",
                get(move |State(seen): State<Seen>, Query(query): Query<HashMap<String, String>>| async move {
                    let put = query["queryParameters"].contains("idExerciseRight=1&");
                    note(&seen, format!("finder {} {}", if put { "put" } else { "call" }, query["perPage"]));
                    // The fixture holds calls only.
                    Json(if put { json!({"total":0,"list":[]}) } else { rows })
                }),
            )
            .route(
                "/derivatives/{id}/snapshot",
                get(move |State(seen): State<Seen>, Path(id): Path<String>| async move {
                    note(&seen, format!("snapshot {id}"));
                    Json(detail)
                }),
            )
            .with_state(seen.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let address = listener.local_addr()?;
        let server = tokio::spawn(async move { axum::serve(listener, app).await });
        let mut service = service().await?;
        service.endpoint = format!("http://{address}");

        let request = CandidateSearch {
            query: Some("tesla".into()),
            ..Default::default()
        };
        let found = service.search(&request).await?;
        let items = found["items"].as_array().context("items")?;
        assert_eq!(items.len(), 3);
        assert_eq!(found["source"], "onvista");
        assert_eq!(found["underlying"]["isin"], "US88160R1014");
        assert_eq!(found["total"], 4540);
        assert_eq!(found["nextOffset"], 30);
        assert_eq!(found["excludedCount"], 0);
        for item in items {
            // Price and ticker of the shared underlying come from the one snapshot.
            assert_eq!(item["underlyingSpot"], 379.78);
            assert_eq!(item["underlyingSymbol"], "TSLA");
            assert_eq!(item["usdEurRate"], 0.9);
        }
        let requests = || seen.lock().map(|list| list.clone()).unwrap_or_default();
        assert_eq!(
            requests(),
            [
                "instrument tesla",
                "finder call 15",
                "finder put 15",
                "snapshot ISIN:DE000UG3NHT9"
            ]
        );
        // Repeating the search within five minutes asks the source nothing.
        service.search(&request).await?;
        assert_eq!(requests().len(), 4);

        let none = service
            .search(&CandidateSearch {
                query: Some("nothing".into()),
                ..Default::default()
            })
            .await?;
        assert_eq!((&none["total"], &none["items"]), (&json!(0), &json!([])));
        assert_eq!(
            requests().last().map(String::as_str),
            Some("instrument nothing")
        );

        let error = service
            .search(&CandidateSearch {
                query: Some("refused".into()),
                ..Default::default()
            })
            .await
            .err()
            .context("a refusal is an error, not an empty result")?;
        assert!(refused(&error));
        assert!(!refused(&anyhow::anyhow!("unrelated")));
        let count = requests().len();
        // A second browser search must respect the same refusal as watchlist
        // refresh, even when it asks for a different instrument.
        assert!(
            service
                .search(&CandidateSearch {
                    query: Some("another".into()),
                    ..Default::default()
                })
                .await
                .is_err()
        );
        assert_eq!(requests().len(), count);
        // Previously cached searches are still usable without touching the source.
        assert!(service.search(&request).await.is_ok());
        assert_eq!(requests().len(), count);
        server.abort();
        Ok(())
    }
}
