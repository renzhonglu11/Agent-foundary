//! Public GS Markets warrant search. Candidates never enter portfolio accounting.
use std::{collections::HashMap, sync::Arc, time::Duration};

use anyhow::{Context, bail};
use chrono::{DateTime, NaiveDate, TimeDelta, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::SqlitePool;
use tokio::sync::Mutex;

use crate::application::services::fx_rate_service::FxRateService;

const ENDPOINT: &str = "https://www.gs.de/graphql";
const FIELDS: &str = include_str!("warrant_fields.graphql");
const PAGE_SIZE: usize = 30;
const WATCHLIST_LIMIT: i64 = 100;
const WARRANT_TYPES: [&str; 4] = ["COVPLAIN", "INDPLAIN", "COMPLAIN", "FXPLAIN"];
type ProviderCache = HashMap<String, (DateTime<Utc>, Value)>;

#[derive(Clone)]
pub struct ProductCandidates {
    pool: SqlitePool,
    fx: FxRateService,
    client: reqwest::Client,
    endpoint: String,
    cache: Arc<Mutex<ProviderCache>>,
    write_lock: Arc<Mutex<()>>,
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

impl ProductCandidates {
    pub fn new(pool: SqlitePool, fx: FxRateService) -> anyhow::Result<Self> {
        Ok(Self {
            pool,
            fx,
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(15))
                .build()?,
            endpoint: ENDPOINT.into(),
            cache: Arc::new(Mutex::new(HashMap::new())),
            write_lock: Arc::new(Mutex::new(())),
        })
    }

    // One in-flight provider request, bounded cache, and no automatic retry loop.
    // A cached response keeps its original capture time; errors never overwrite data.
    async fn query(
        &self,
        query: String,
        variables: Value,
    ) -> anyhow::Result<(DateTime<Utc>, Value)> {
        let body = json!({"query":query,"variables":variables});
        let key = body.to_string();
        let mut cache = self.cache.lock().await;
        if let Some((at, value)) = cache.get(&key) {
            if Utc::now() - *at < TimeDelta::minutes(5) {
                return Ok((*at, value.clone()));
            }
        }
        let response: Value = self
            .client
            .post(&self.endpoint)
            .header("Referer", "https://www.gs.de/de/produkte")
            .json(&body)
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        if response
            .get("errors")
            .is_some_and(|v| v.as_array().is_none_or(|a| !a.is_empty()))
        {
            bail!("GS product service returned GraphQL errors");
        }
        let data = response
            .get("data")
            .filter(|v| v.is_object())
            .context("GS response missing data")?
            .clone();
        let at = Utc::now();
        cache.retain(|_, (saved, _)| at - *saved < TimeDelta::minutes(5));
        if cache.len() >= 128 {
            cache.clear();
        }
        cache.insert(key, (at, data.clone()));
        Ok((at, data))
    }

    async fn lookup(&self, isin: &str) -> anyhow::Result<WarrantCandidate> {
        let query = format!(
            "query Candidate($id: ID!) {{ getSecuritizedProduct(id: $id) {{ {FIELDS} }} }}"
        );
        let (at, data) = self.query(query, json!({"id":isin})).await?;
        let product = parse_candidate(&data["getSecuritizedProduct"], at)
            .context("未找到可支持的普通权证，或产品条款不完整")?;
        if product.isin != isin {
            bail!("Provider returned a different ISIN");
        }
        Ok(product)
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
        let mut origin = match &request.roll_from {
            Some(isin) => Some(self.lookup(isin).await?),
            None => None,
        };
        let input = search_input(request, origin.as_ref(), Utc::now().date_naive())?;
        let query = format!(
            "query Candidates($searchInput: InputSearchProducts) {{ searchProducts(searchInput: $searchInput) {{ paginatedProducts {{ totalCount results {{ {FIELDS} }} }} }} }}"
        );
        let (at, data) = self.query(query, json!({"searchInput":input})).await?;
        let page = &data["searchProducts"]["paginatedProducts"];
        let rows = page["results"]
            .as_array()
            .context("GS response missing product results")?;
        let mut items: Vec<_> = rows
            .iter()
            .filter_map(|row| parse_candidate(row, at))
            .filter(|p| matches_search(p, request, origin.as_ref(), Utc::now().date_naive()))
            .collect();
        self.add_fx(&mut items).await;
        if let Some(p) = &mut origin {
            self.add_fx(std::slice::from_mut(p)).await;
        }
        let total = page["totalCount"]
            .as_u64()
            .context("GS response missing result count")?;
        let offset = request.offset.unwrap_or(0);
        let next = offset + rows.len();
        Ok(
            json!({"items":items,"origin":origin,"total":total,"offset":offset,
            "nextOffset": if !rows.is_empty() && (next as u64) < total && next <= 10_000 {Some(next)} else {None},
            "excludedCount":rows.len().saturating_sub(items.len()),"fetchedAt":at,"source":"gs.de",
            "scope":"GS Markets 可检索的普通权证；含其他发行人，不代表全市场或你的券商可交易范围"}),
        )
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

fn search_input(
    request: &CandidateSearch,
    origin: Option<&WarrantCandidate>,
    today: NaiveDate,
) -> anyhow::Result<Value> {
    let mut minimum = today + TimeDelta::days(1);
    if let Some(date) = &request.min_expiry {
        minimum = minimum.max(NaiveDate::parse_from_str(date, "%Y-%m-%d")?);
    }
    let mut filters = vec![
        json!({"classificationInfo.flavour.code_in":WARRANT_TYPES}),
        json!({"status":"ACTIVE"}),
    ];
    let direction = if let Some(p) = origin {
        filters.push(json!({"assets.id_eq":p.underlying_id}));
        minimum =
            minimum.max(NaiveDate::parse_from_str(&p.expiry, "%Y-%m-%d")? + TimeDelta::days(1));
        Some(p.option_type.as_str())
    } else {
        request.direction.as_deref()
    };
    if let Some(direction) = direction {
        filters.push(json!({"productTerms.levels.claimType.key":direction.to_uppercase()}));
    }
    filters.push(json!({"productTerms.expirationDate.localeFormatted_gte":minimum.to_string()}));
    Ok(
        json!({"phrase":if origin.is_none() {request.query.as_ref().map(|s| s.trim())} else {None},
        "filter":{"AND":filters},"first":PAGE_SIZE,"offset":request.offset.unwrap_or(0),
        "orderBy":["productTerms.expirationDate.localeFormatted_ASC","economics.price.percentageSpread_ASC"]}),
    )
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
fn timestamp(value: &Value) -> Option<String> {
    value
        .as_i64()
        .and_then(DateTime::<Utc>::from_timestamp_millis)
        .map(|t| t.to_rfc3339())
}

fn parse_candidate(raw: &Value, captured: DateTime<Utc>) -> Option<WarrantCandidate> {
    let isin = text(&raw["synonyms"]["isn"])?;
    if !valid_isin(&isin)
        || !WARRANT_TYPES.contains(&raw["classificationInfo"]["flavour"]["code"].as_str()?)
    {
        return None;
    }
    let assets = raw["assets"].as_array()?;
    if assets.len() != 1 {
        return None;
    }
    let asset = &assets[0];
    let underlying_id = text(&asset["id"])?;
    let terms = &raw["productTerms"];
    let levels = terms["levels"].as_array()?;
    if levels.len() != 1 {
        return None;
    }
    let direction = text(&levels[0]["claimType"]["key"])?.to_lowercase();
    if !matches!(direction.as_str(), "call" | "put") {
        return None;
    }
    let expiry = text(&terms["expirationDate"]["localeFormatted"])?;
    NaiveDate::parse_from_str(&expiry, "%Y-%m-%d").ok()?;
    let economics = &raw["economics"];
    let pricing = economics["underlyingPricings"]
        .as_array()
        .and_then(|rows| rows.iter().find(|p| p["assetName"] == underlying_id));
    let currency = text(&asset["currency"]).unwrap_or_default();
    let pricing = pricing.filter(|p| p["currency"] == currency);
    // Do not map ADRs or another listing by a fuzzy company name.
    let parts: Vec<_> = underlying_id.split_whitespace().collect();
    let symbol = if currency == "USD"
        && parts.len() == 2
        && matches!(parts[1], "UW" | "UN" | "UQ" | "US")
        && parts[0]
            .bytes()
            .all(|b| b.is_ascii_uppercase() || b == b'.')
    {
        Some(parts[0].to_owned())
    } else {
        None
    };
    Some(WarrantCandidate {
        source_url: format!("https://www.gs.de/de/optionsschein-rechner?isin={isin}"),
        isin,
        wkn: text(&raw["synonyms"]["wpk"]),
        issuer: text(&raw["issuanceInfo"]["issuer"]["name"]),
        product_type: "optionsschein".into(),
        option_type: direction,
        underlying_id,
        underlying_isin: text(&asset["assetSynonyms"]["isn"]),
        underlying_name: text(&asset["name"])?,
        underlying_symbol: symbol,
        underlying_currency: currency,
        underlying_spot: pricing
            .and_then(|p| positive(&p["value"]))
            .or_else(|| positive(&asset["assetPrice"]["spotPrice"])),
        underlying_as_of: pricing.and_then(|p| timestamp(&p["time"])),
        quote_currency: text(&terms["denominated"]).unwrap_or_default(),
        bid: positive(&economics["price"]["bid"]),
        ask: positive(&economics["price"]["ask"]),
        quote_as_of: timestamp(&economics["price"]["time"]),
        expiry,
        strike_price: positive(&terms["strike"]),
        ratio: positive(&terms["ratio"]),
        // GS reports percentage points, including values below one percent.
        iv: positive(&economics["realTimeData"]["impliedVolatility"]).map(|v| v / 100.0),
        delta: economics["realTimeData"]["delta"].as_f64(),
        omega: positive(&economics["realTimeData"]["omega"]),
        tradable: economics["realTimeData"]["tradableStatus"].as_bool(),
        status: text(&raw["status"]).unwrap_or_default(),
        payment_style: text(&terms["paymentStyle"]).unwrap_or_default(),
        source: "gs.de".into(),
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
    // IV has no independent market timestamp in this feed. Use the associated
    // quote's UTC date, never the fetch date, so old quotes cannot create new days.
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
                .bind(&product.underlying_name).bind("gs.de:watchlist_quote_date").bind(at.to_rfc3339())
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

    fn fixture() -> anyhow::Result<Value> {
        Ok(serde_json::from_str(include_str!(
            "fixtures/gs_warrant_search.json"
        ))?)
    }

    fn product() -> anyhow::Result<WarrantCandidate> {
        parse_candidate(
            &fixture()?["data"]["searchProducts"]["paginatedProducts"]["results"][0],
            Utc::now(),
        )
        .context("fixture must parse")
    }

    async fn service() -> anyhow::Result<ProductCandidates> {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await?;
        run_migrations(&pool).await?;
        let fx = FxRateService::new(
            Arc::new(SqliteFxRateCache::new(pool.clone())),
            FxRateSettings {
                enabled: false,
                endpoint: String::new(),
                cache_ttl_seconds: 3600,
                fallback_usd_eur_rate: 0.9,
            },
        );
        ProductCandidates::new(pool, fx)
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
    fn parses_real_gs_response_and_preserves_quote_times_and_units() -> anyhow::Result<()> {
        let mut raw =
            fixture()?["data"]["searchProducts"]["paginatedProducts"]["results"][0].clone();
        let p = parse_candidate(&raw, Utc::now()).context("parse")?;
        assert_eq!(p.underlying_id, "TSLA UW");
        assert_eq!(p.underlying_symbol.as_deref(), Some("TSLA"));
        assert_eq!(p.underlying_currency, "USD");
        assert_eq!(p.quote_currency, "EUR");
        assert_eq!(p.expiry, "2027-06-16");
        assert_eq!(p.iv, Some(0.5152));
        assert_ne!(p.quote_as_of.as_deref(), Some(p.fetched_at.as_str()));
        raw["economics"]["realTimeData"]["impliedVolatility"] = json!(0.5);
        assert_eq!(
            parse_candidate(&raw, Utc::now()).context("low IV")?.iv,
            Some(0.005)
        );
        raw["economics"]["price"]["time"] = Value::Null;
        assert_eq!(
            parse_candidate(&raw, Utc::now())
                .context("unknown time")?
                .quote_as_of,
            None
        );
        raw["classificationInfo"]["flavour"]["code"] = json!("COVCAP");
        assert!(parse_candidate(&raw, Utc::now()).is_none());
        Ok(())
    }

    #[test]
    fn roll_search_uses_exact_asset_direction_and_strictly_later_expiry() -> anyhow::Result<()> {
        let origin = product()?;
        let request = CandidateSearch {
            roll_from: Some(origin.isin.clone()),
            query: Some("wrong name".into()),
            direction: Some("put".into()),
            ..Default::default()
        };
        let today = NaiveDate::from_ymd_opt(2026, 11, 10).context("date")?;
        let input = search_input(&request, Some(&origin), today)?;
        assert!(input["phrase"].is_null());
        let encoded = input.to_string();
        assert!(
            encoded.contains("TSLA UW")
                && encoded.contains("CALL")
                && encoded.contains("2027-06-17")
        );
        let mut candidate = origin.clone();
        candidate.isin = "DE000UG3NHT9".into();
        candidate.expiry = "2027-12-17".into();
        assert!(matches_search(&candidate, &request, Some(&origin), today));
        candidate.underlying_id = "TSLA GY".into();
        assert!(!matches_search(&candidate, &request, Some(&origin), today));
        candidate.underlying_id = origin.underlying_id.clone();
        candidate.option_type = "put".into();
        assert!(!matches_search(&candidate, &request, Some(&origin), today));
        candidate.option_type = "call".into();
        candidate.expiry = origin.expiry.clone();
        assert!(!matches_search(&candidate, &request, Some(&origin), today));
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
        let days: Vec<String> =
            sqlx::query_scalar("SELECT observed_on FROM structured_product_iv_history")
                .fetch_all(&service.pool)
                .await?;
        assert_eq!(days, vec![at.date_naive().to_string()]);
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
    async fn caches_public_search_and_rejects_graphql_errors_without_empty_success()
    -> anyhow::Result<()> {
        use axum::{Json, Router, extract::State, routing::post};
        use std::sync::atomic::{AtomicUsize, Ordering};
        let requests = Arc::new(AtomicUsize::new(0));
        let app = Router::new()
            .route(
                "/graphql",
                post(
                    |State(count): State<Arc<AtomicUsize>>, Json(input): Json<Value>| async move {
                        count.fetch_add(1, Ordering::SeqCst);
                        if input["variables"]["searchInput"]["phrase"] == "failure" {
                            Json(json!({"errors":[{"message":"upstream unavailable"}],"data":null}))
                        } else {
                            Json(
                                serde_json::from_str::<Value>(include_str!(
                                    "fixtures/gs_warrant_search.json"
                                ))
                                .unwrap_or(Value::Null),
                            )
                        }
                    },
                ),
            )
            .with_state(requests.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let address = listener.local_addr()?;
        let server = tokio::spawn(async move { axum::serve(listener, app).await });
        let mut service = service().await?;
        service.endpoint = format!("http://{address}/graphql");
        let query = format!("query Candidates {{ {FIELDS} }}");
        let variables = json!({"searchInput":{"phrase":"Tesla"}});
        let first = service.query(query.clone(), variables.clone()).await?;
        let second = service.query(query.clone(), variables).await?;
        assert_eq!(first, second);
        assert_eq!(requests.load(Ordering::SeqCst), 1);
        assert!(
            service
                .query(query, json!({"searchInput":{"phrase":"failure"}}))
                .await
                .is_err()
        );
        server.abort();
        Ok(())
    }
}
