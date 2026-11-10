//! Deterministic background risk calculations. No network, wall clock or AI.
//! Monetary inputs are EUR; raw spot and FX are retained for later replay.
use std::collections::BTreeMap;

use chrono::{DateTime, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

pub const MODEL_VERSION: &str = "monitor-risk-v1";

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct RiskSettings {
    pub shock_pct: f64,
    pub horizon_days: u32,
    pub iv_move_pct: f64,
    pub fx_move_pct: f64,
    pub volatility_scaled: bool,
    pub max_loss_eur: Option<f64>,
    pub max_concentration_pct: Option<f64>,
    pub max_knockout_7d_pct: Option<f64>,
    pub max_decay_7d_pct: Option<f64>,
    pub expiry_warning_days: Option<f64>,
    pub min_model_coverage_pct: Option<f64>,
}

impl Default for RiskSettings {
    fn default() -> Self {
        Self {
            shock_pct: 20.0,
            horizon_days: 7,
            iv_move_pct: 0.0,
            fx_move_pct: 0.0,
            volatility_scaled: true,
            max_loss_eur: None,
            max_concentration_pct: None,
            max_knockout_7d_pct: None,
            max_decay_7d_pct: None,
            expiry_warning_days: None,
            min_model_coverage_pct: None,
        }
    }
}

impl RiskSettings {
    pub fn validate(&self) -> Result<(), &'static str> {
        if !(1.0..=100.0).contains(&self.shock_pct)
            || self.horizon_days > 90
            || !(-90.0..=200.0).contains(&self.iv_move_pct)
            || !(-90.0..=100.0).contains(&self.fx_move_pct)
        {
            return Err("情景幅度须为 1–100%，期限 0–90 天，IV -90–200%，汇率 -90–100%");
        }
        for value in [
            self.max_concentration_pct,
            self.max_knockout_7d_pct,
            self.max_decay_7d_pct,
            self.min_model_coverage_pct,
        ]
        .into_iter()
        .flatten()
        {
            if !(0.0..=100.0).contains(&value) {
                return Err("百分比限额须在 0–100 之间");
            }
        }
        if self
            .max_loss_eur
            .is_some_and(|v| !v.is_finite() || v <= 0.0 || v > 1e12)
            || self
                .expiry_warning_days
                .is_some_and(|v| !(0.0..=365.0).contains(&v))
        {
            return Err("损失限额须大于零且不超过 1 万亿；到期提醒须为 0–365 天");
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelPosition {
    pub id: String,
    pub name: String,
    pub group: String,
    pub product_type: String,
    pub put: bool,
    pub price: f64,
    pub quantity: f64,
    pub value: f64,
    pub spot: f64,
    pub raw_spot: f64,
    pub fx: f64,
    pub usd: bool,
    pub strike: Option<f64>,
    pub barrier: Option<f64>,
    pub ratio: Option<f64>,
    pub leverage: Option<f64>,
    pub dte: Option<f64>,
    pub volatility: Option<f64>,
    pub risk_volatility: Option<f64>,
    pub rate: f64,
    pub method: String,
    pub provisional: bool,
}

pub fn number(value: &Value) -> Option<f64> {
    value
        .as_f64()
        .or_else(|| value.as_str()?.parse().ok())
        .filter(|v| v.is_finite())
}
fn positive(value: &Value) -> Option<f64> {
    number(value).filter(|v| *v > 0.0)
}
fn volatility(value: &Value) -> Option<f64> {
    positive(value).map(|v| if v <= 1.0 { v } else { v / 100.0 })
}
pub fn timestamp(value: &Value) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value.as_str()?)
        .ok()
        .map(|d| d.with_timezone(&Utc))
}

pub fn expiry_days(item: &Value, now: DateTime<Utc>) -> Option<f64> {
    item["expiry"]
        .as_str()
        .and_then(|s| s.get(..10))
        .and_then(|s| NaiveDate::parse_from_str(s, "%Y-%m-%d").ok())
        .and_then(|d| d.and_hms_opt(0, 0, 0))
        .map(|d| {
            ((d.and_utc() - now).num_seconds() as f64 / 86400.0)
                .ceil()
                .max(0.0)
        })
}
fn median(values: &mut [f64]) -> Option<f64> {
    values.sort_by(f64::total_cmp);
    let n = values.len();
    if n == 0 {
        None
    } else if n % 2 == 1 {
        Some(values[n / 2])
    } else {
        Some((values[n / 2 - 1] + values[n / 2]) / 2.0)
    }
}

pub fn normal_cdf(value: f64) -> f64 {
    let x = value.abs() / std::f64::consts::SQRT_2;
    let t = 1.0 / (1.0 + 0.3275911 * x);
    let polynomial = ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t
        + 0.254829592)
        * t;
    let erf = 1.0 - polynomial * (-x * x).exp();
    if value >= 0.0 {
        0.5 * (1.0 + erf)
    } else {
        0.5 * (1.0 - erf)
    }
}

pub fn black_scholes(spot: f64, strike: f64, years: f64, vol: f64, rate: f64, put: bool) -> f64 {
    let discounted = strike * (-rate * years.max(0.0)).exp();
    if spot <= 0.0 {
        return if put { discounted } else { 0.0 };
    }
    if years <= 0.0 || vol <= 0.0 {
        return if put {
            discounted - spot
        } else {
            spot - discounted
        }
        .max(0.0);
    }
    let spread = vol * years.sqrt();
    let d1 = ((spot / strike).ln() + (rate + vol * vol / 2.0) * years) / spread;
    let d2 = d1 - spread;
    if put {
        discounted * normal_cdf(-d2) - spot * normal_cdf(-d1)
    } else {
        spot * normal_cdf(d1) - discounted * normal_cdf(d2)
    }
}

fn prepare(
    row: &Value,
    item: &Value,
    stats: &Value,
    now: DateTime<Utc>,
) -> Result<ModelPosition, &'static str> {
    if !matches!(
        row["underlyingQuality"].as_str(),
        Some("fresh" | "closed_last_session")
    ) {
        return Err("underlying_unusable");
    }
    let price = positive(&row["price"]).ok_or("product_price_missing")?;
    let quantity = positive(&row["quantity"]).ok_or("short_or_missing_quantity")?;
    if row["currency"] != "EUR" {
        return Err("unsupported_currency");
    }
    let value = positive(&row["marketValue"]).ok_or("valuation_missing")?;
    if (value - price * quantity).abs() > value * 0.01 {
        return Err("valuation_quantity_mismatch");
    }
    let quote = &row["underlyingQuote"];
    if timestamp(&row["marketAsOf"]).is_some_and(|t| t > now + chrono::TimeDelta::minutes(2)) {
        return Err("product_data_unusable");
    }
    if !matches!(quote["rawCurrency"].as_str(), Some("USD" | "EUR")) {
        return Err("unsupported_currency");
    }
    let usd = quote["rawCurrency"] == "USD";
    let fx = if usd {
        positive(&quote["usdEurRate"]).ok_or("fx_missing")?
    } else {
        1.0
    };
    let spot = positive(&quote["rawPrice"]).ok_or("underlying_price_missing")? * fx;
    let derivative = row["assetClass"]
        .as_str()
        .unwrap_or("")
        .eq_ignore_ascii_case("DERIVATIVE")
        || item["product_type"].is_string();
    let product_type = if derivative {
        item["product_type"].as_str().unwrap_or("unknown")
    } else {
        "stock"
    };
    if !matches!(
        product_type,
        "stock" | "optionsschein" | "open_end_turbo" | "knock_out" | "factor_certificate"
    ) {
        return Err("unsupported_product");
    }
    // Explicit metadata wins; whole tokens avoid matching "Computer" as "put".
    let text = format!(
        "{} {}",
        row["name"].as_str().unwrap_or(""),
        row["instrument"].as_str().unwrap_or("")
    )
    .to_lowercase();
    let tokens: Vec<_> = text.split(|c: char| !c.is_alphabetic()).collect();
    let put = match item["option_type"].as_str() {
        Some("put") => true,
        Some("call") => false,
        _ if tokens
            .iter()
            .any(|t| ["put", "bear", "short", "turbop", "fakts"].contains(t)) =>
        {
            true
        }
        _ if product_type == "stock"
            || tokens
                .iter()
                .any(|t| ["call", "bull", "long", "turboc", "faktl"].contains(t)) =>
        {
            false
        }
        _ => return Err("direction_missing"),
    };
    let dte = expiry_days(item, now);
    let iv = volatility(&item["iv"]).filter(|v| (0.05..=3.0).contains(v));
    let history_valid = stats["stale"] == false
        && stats["asOf"]
            .as_str()
            .and_then(|s| NaiveDate::parse_from_str(s, "%Y-%m-%d").ok())
            .is_some_and(|d| (0..=7).contains(&(now.date_naive() - d).num_days()));
    let risk_volatility = [
        iv,
        if history_valid {
            positive(&stats["realizedVol20d"])
        } else {
            None
        },
        if history_valid {
            positive(&stats["realizedVol60d"])
        } else {
            None
        },
    ]
    .into_iter()
    .flatten()
    .reduce(f64::max);
    let mut model = ModelPosition {
        id: row["symbol"].as_str().unwrap_or("").into(),
        name: row["name"].as_str().unwrap_or("").into(),
        group: row["underlyingSymbol"].as_str().unwrap_or("").into(),
        product_type: product_type.into(),
        put,
        price,
        quantity,
        value,
        spot,
        raw_spot: spot / fx,
        fx,
        usd,
        strike: positive(&item["strike_price"]).map(|v| v * fx),
        barrier: positive(&item["knockout_price"]).map(|v| v * fx),
        ratio: positive(&item["ratio"]),
        leverage: positive(&item["leverage"])
            .or_else(|| number(&item["omega"]).map(f64::abs).filter(|v| *v > 0.0)),
        dte,
        volatility: iv,
        risk_volatility,
        rate: if usd { 0.04 } else { 0.02 },
        method: product_type.into(),
        provisional: row["marketAsOf"].is_null()
            || derivative
            || quote["fxRateSource"] != "frankfurter",
    };
    match product_type {
        "optionsschein" => {
            let strike = model.strike.ok_or("strike_missing")?;
            let ratio = model.ratio.ok_or("ratio_missing")?;
            let days = dte
                .filter(|v| *v > 0.0)
                .ok_or("expired_or_expiry_missing")?;
            let price_at = |vol| black_scholes(spot, strike, days / 365.0, vol, model.rate, put);
            let target = price / ratio;
            let mut calibrated = None;
            if target >= price_at(0.05) && target <= price_at(3.0) {
                let (mut low, mut high) = (0.05, 3.0);
                for _ in 0..60 {
                    let mid = (low + high) / 2.0;
                    if price_at(mid) < target {
                        low = mid;
                    } else {
                        high = mid;
                    }
                }
                let v = (low + high) / 2.0;
                if iv.is_none_or(|provider| v >= provider / 2.0 && v <= provider * 2.0) {
                    calibrated = Some(v);
                }
            }
            model.volatility = calibrated.or(iv);
            if model.volatility.is_none() {
                return Err("volatility_unavailable");
            }
            model.method = if calibrated.is_some() { "bs" } else { "bs_iv" }.into();
        }
        "factor_certificate" if model.leverage.is_none() => return Err("leverage_missing"),
        "open_end_turbo" | "knock_out"
            if model.strike.is_none() || model.ratio.is_none() || model.barrier.is_none() =>
        {
            return Err("turbo_terms_missing");
        }
        _ => {}
    }
    if row["issues"].as_array().is_some_and(|issues| {
        issues.iter().any(|issue| {
            matches!(
                issue.as_str(),
                Some(
                    "product_capture_stale"
                        | "product_capture_future"
                        | "product_underlying_time_gap_over_24h"
                        | "valuation_missing_or_invalid"
                )
            )
        })
    }) {
        return Err("product_data_unusable");
    }
    Ok(model)
}

/// Frozen-origin revaluation; path points are cumulative returns from origin.
pub fn project(
    m: &ModelPosition,
    move_pct: f64,
    days: f64,
    iv_move: f64,
    fx_move: f64,
    path: &[f64],
) -> f64 {
    let spot = (m.spot * (1.0 + move_pct / 100.0)).max(0.0);
    let sign = if m.put { -1.0 } else { 1.0 };
    let price = match m.product_type.as_str() {
        "stock" => m.price * (1.0 + move_pct / 100.0).max(0.0),
        "optionsschein" => {
            let strike = m.strike.unwrap_or(0.0);
            let ratio = m.ratio.unwrap_or(0.0);
            let dte = m.dte.unwrap_or(0.0);
            let vol = m.volatility.unwrap_or(0.0);
            if dte <= days {
                (sign * (spot - strike)).max(0.0) * ratio
            } else {
                let base = black_scholes(m.spot, strike, dte / 365.0, vol, m.rate, m.put);
                let next = black_scholes(
                    spot,
                    strike,
                    (dte - days) / 365.0,
                    (vol * (1.0 + iv_move / 100.0)).max(0.01),
                    m.rate,
                    m.put,
                );
                let anchor = if base * ratio > m.price {
                    m.price / (base * ratio)
                } else {
                    1.0
                };
                (m.price + (next - base) * ratio * anchor).max(0.0)
            }
        }
        "factor_certificate" => {
            let leverage = m.leverage.unwrap_or(1.0);
            let mut price = m.price;
            if path.is_empty() {
                price *= (1.0 + sign * leverage * move_pct / 100.0).max(0.0);
            } else {
                let mut previous = 100.0;
                for point in path {
                    let next = (100.0 + point).max(0.0);
                    let change = if previous > 0.0 {
                        next / previous - 1.0
                    } else {
                        0.0
                    };
                    price *= (1.0 + sign * leverage * change).max(0.0);
                    previous = next;
                }
            }
            let beta = sign * leverage;
            let financed = if m.put {
                leverage + 1.0
            } else {
                leverage - 1.0
            }
            .max(0.0);
            let financing = -sign * financed * (m.rate + if m.put { -0.03 } else { 0.03 });
            let vol = m.volatility.or(m.risk_volatility).unwrap_or(0.5);
            price
                * (financing * days / 360.0
                    - (0.01 + 0.5 * beta * (beta - 1.0) * vol * vol) * days / 365.0)
                    .exp()
        }
        _ => {
            let days = if m.product_type == "knock_out" {
                days.min(m.dte.unwrap_or(days))
            } else {
                days
            };
            let drift = (m.rate + if m.put { -0.03 } else { 0.03 }) * days / 360.0;
            let barrier = m.barrier.unwrap_or(0.0)
                * if m.product_type == "open_end_turbo" {
                    1.0 + drift
                } else {
                    1.0
                };
            let breached = std::iter::once(&move_pct).chain(path.iter()).any(|point| {
                let s = (m.spot * (1.0 + point / 100.0)).max(0.0);
                if m.put { s >= barrier } else { s <= barrier }
            });
            if breached {
                0.0
            } else {
                (m.price + sign * (spot - m.spot) * m.ratio.unwrap_or(0.0)
                    - sign * m.strike.unwrap_or(0.0) * m.ratio.unwrap_or(0.0) * drift)
                    .max(0.0)
            }
        }
    };
    (price
        * if m.usd {
            (1.0 + fx_move / 100.0).max(0.0)
        } else {
            1.0
        })
    .max(0.0)
}

fn knockout_probability(m: &ModelPosition) -> Option<f64> {
    let barrier = m.barrier?;
    if (m.put && m.spot >= barrier) || (!m.put && m.spot <= barrier) {
        return Some(100.0);
    }
    let vol = m.risk_volatility?;
    let drift_barrier = if m.product_type == "open_end_turbo" {
        barrier * (1.0 + (m.rate + if m.put { -0.03 } else { 0.03 }) * 7.0 / 360.0)
    } else {
        barrier
    };
    if (m.put && m.spot >= drift_barrier) || (!m.put && m.spot <= drift_barrier) {
        return Some(100.0);
    }
    let distance = (drift_barrier / m.spot).ln().abs();
    let drift = if drift_barrier < m.spot { 1.0 } else { -1.0 } * vol * vol / 2.0;
    let years: f64 = 7.0 / 365.0;
    let spread = vol * years.sqrt();
    Some(
        (normal_cdf((-distance + drift * years) / spread)
            + (2.0 * drift * distance / vol.powi(2)).exp()
                * normal_cdf((-distance - drift * years) / spread))
        .clamp(0.0, 1.0)
            * 100.0,
    )
}

pub fn evaluate(snapshot: &Value, settings: &RiskSettings, now: DateTime<Utc>) -> Value {
    let empty = Vec::new();
    let rows = snapshot["positions"].as_array().unwrap_or(&empty);
    let items = snapshot["inputs"]["enrichment"]["items"]
        .as_array()
        .unwrap_or(&empty);
    let stats = snapshot["inputs"]["dailyStats"]
        .as_array()
        .unwrap_or(&empty);
    let mut models = Vec::new();
    let mut excluded = Vec::new();
    let mut concentrations: BTreeMap<String, f64> = BTreeMap::new();
    for row in rows {
        let id = &row["symbol"];
        let item = items
            .iter()
            .find(|i| &i["isin"] == id)
            .unwrap_or(&Value::Null);
        let daily = stats
            .iter()
            .find(|s| s["symbol"] == row["underlyingSymbol"])
            .unwrap_or(&Value::Null);
        let group = row["underlyingSymbol"]
            .as_str()
            .unwrap_or_else(|| id.as_str().unwrap_or("unknown"));
        *concentrations.entry(group.into()).or_default() +=
            number(&row["marketValue"]).unwrap_or(0.0).abs();
        match prepare(row, item, daily, now) {
            Ok(m) => models.push(m),
            Err(reason) => excluded.push(
                json!({"id":id,"name":row["name"],"value":row["marketValue"],"reason":reason}),
            ),
        }
    }
    let gross = number(&snapshot["grossHoldingsValue"]).unwrap_or(0.0);
    let covered: f64 = models.iter().map(|m| m.value).sum();
    let mut vols: BTreeMap<String, Vec<f64>> = BTreeMap::new();
    for model in &models {
        if let Some(v) = model.risk_volatility {
            vols.entry(model.group.clone()).or_default().push(v);
        }
    }
    let group_vols: BTreeMap<_, _> = vols
        .into_iter()
        .filter_map(|(g, mut vs)| median(&mut vs).map(|v| (g, v)))
        .collect();
    let reference = median(&mut group_vols.values().copied().collect::<Vec<_>>());
    let scales: BTreeMap<_, _> = models
        .iter()
        .map(|m| {
            (
                m.group.clone(),
                if settings.volatility_scaled {
                    group_vols
                        .get(&m.group)
                        .zip(reference)
                        .map(|(v, r)| (v / r).clamp(0.4, 2.5))
                        .unwrap_or(1.0)
                } else {
                    1.0
                },
            )
        })
        .collect();
    let scenarios = [
        ("down", -1.0, false),
        ("half_down", -0.5, false),
        ("flat", 0.0, false),
        ("half_up", 0.5, false),
        ("up", 1.0, false),
        ("recovery", -1.0, true),
        ("roundtrip", 1.0, true),
    ];
    let mut results = Vec::new();
    for (id, factor, path) in scenarios {
        let mut contributions = Vec::new();
        for m in &models {
            let shock = factor * settings.shock_pct * scales.get(&m.group).copied().unwrap_or(1.0);
            let path_points = [shock, 0.0];
            let price = project(
                m,
                if path { 0.0 } else { shock },
                settings.horizon_days as f64,
                settings.iv_move_pct,
                settings.fx_move_pct,
                if path { &path_points } else { &[] },
            );
            contributions.push(json!({"id":m.id,"group":m.group,"pnl":(price-m.price)*m.quantity,"projectedPrice":price}));
        }
        let pnl: f64 = contributions.iter().filter_map(|c| number(&c["pnl"])).sum();
        results.push(json!({"id":id,"movePct":factor*settings.shock_pct,"path":path,"pnl":pnl,"contributions":contributions}));
    }
    let mut adverse = Vec::new();
    for group in concentrations.keys() {
        let candidates: Vec<_> = results
            .iter()
            .take(5)
            .map(|s| {
                let cs: Vec<_> = s["contributions"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(|c| c["group"] == *group)
                    .cloned()
                    .collect();
                (cs.iter().filter_map(|c| number(&c["pnl"])).sum::<f64>(), cs)
            })
            .collect();
        if let Some((_, cs)) = candidates.into_iter().min_by(|a, b| a.0.total_cmp(&b.0)) {
            adverse.extend(cs);
        }
    }
    results.push(json!({"id":"adverse","pnl":adverse.iter().filter_map(|c| number(&c["pnl"])).sum::<f64>(),"contributions":adverse}));
    let worst = results.iter().min_by(|a, b| {
        number(&a["pnl"])
            .unwrap_or(0.0)
            .total_cmp(&number(&b["pnl"]).unwrap_or(0.0))
    });
    let metrics: Vec<_> = models.iter().map(|m| json!({"id":m.id,"name":m.name,"group":m.group,"method":m.method,"provisional":m.provisional,
        "daysToExpiry":m.dte,"knockout7dPct":knockout_probability(m),"decay7dPct":(1.0-project(m,0.0,7.0,0.0,0.0,&[])/m.price)*100.0,
        "concentrationPct":if gross>0.0 { concentrations.get(&m.group).copied().unwrap_or(0.0)/gross*100.0 } else {0.0}})).collect();
    json!({"modelVersion":MODEL_VERSION,"settings":settings,"groupScales":scales,"coveredValue":covered,"uncoveredValue":(gross-covered).max(0.0),
        "coveragePct":if gross>0.0 {covered/gross*100.0} else {0.0},"hasModels":!models.is_empty(),
        "worstPnl":if models.is_empty(){None}else{worst.and_then(|w| number(&w["pnl"]))},"worstScenario":worst.map(|w| &w["id"]),
        "scenarios":results,"metrics":metrics,"excluded":excluded,"models":models,
        "concentrations":concentrations.into_iter().map(|(group,value)|json!({"group":group,"value":value,"pct":if gross>0.0{value/gross*100.0}else{0.0}})).collect::<Vec<_>>(),
        "assumptions":["确定性压力情景，不是行情预测；未覆盖持仓不计入模型损益","利率假设 USD 4% / EUR 2%，融资加点 3%，Factor 年费 1%","Factor 路径仅两次重置；Turbo 障碍仅检查情景路径点","产品与 Greeks 市场时间未知时结果仅供估算；不自动交易"]})
}

#[cfg(test)]
mod tests {
    use super::*;

    pub fn fixture() -> anyhow::Result<Value> {
        let cases: Value = serde_json::from_str(include_str!(
            "../../tests/fixtures/monitor-risk-parity.json"
        ))?;
        Ok(cases[0].clone())
    }

    #[test]
    fn matches_browser_goldens_for_bs_expiry_fx_iv_and_path_products() -> anyhow::Result<()> {
        let cases: Vec<Value> = serde_json::from_str(include_str!(
            "../../tests/fixtures/monitor-risk-parity.json"
        ))?;
        let now = "2026-11-10T00:00:00Z".parse()?;
        for case in cases {
            let m = prepare(&case["row"], &case["item"], &Value::Null, now)
                .map_err(anyhow::Error::msg)?;
            for result in case["results"].as_array().into_iter().flatten() {
                let s = &result["scenario"];
                let path: Vec<f64> = s["pathMoves"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(number)
                    .collect();
                let price = project(
                    &m,
                    number(&s["movePct"]).unwrap_or(0.0),
                    number(&s["days"]).unwrap_or(0.0),
                    number(&s["ivMovePct"]).unwrap_or(0.0),
                    number(&s["fxMovePct"]).unwrap_or(0.0),
                    &path,
                );
                let expected = number(&result["expected"])
                    .ok_or_else(|| anyhow::anyhow!("expected price missing"))?;
                assert!(
                    (price - expected).abs() < 0.000051,
                    "{} {s}: actual {price}, expected {expected}",
                    m.id
                );
            }
        }
        Ok(())
    }

    #[test]
    fn independent_bs_reference_and_put_call_parity() {
        let call = black_scholes(100.0, 100.0, 1.0, 0.2, 0.05, false);
        let put = black_scholes(100.0, 100.0, 1.0, 0.2, 0.05, true);
        assert!((call - 10.45058).abs() < 0.0001);
        assert!((call - put - (100.0 - 100.0 * (-0.05_f64).exp())).abs() < 1e-10);
        assert_eq!(black_scholes(0.0, 100.0, 0.0, 0.2, 0.05, true), 100.0);
    }

    #[test]
    fn stale_inputs_are_excluded_and_no_models_is_unknown_not_zero_risk() -> anyhow::Result<()> {
        let case = fixture()?;
        let mut row = case["row"].clone();
        row["underlyingQuality"] = json!("stale");
        let snapshot = json!({"positions":[row],"grossHoldingsValue":200,"inputs":{"enrichment":{"items":[case["item"]]}}});
        let result = evaluate(
            &snapshot,
            &RiskSettings::default(),
            "2026-11-10T00:00:00Z".parse()?,
        );
        assert_eq!(result["coveragePct"], 0.0);
        assert_eq!(result["uncoveredValue"], 200.0);
        assert!(result["worstPnl"].is_null());
        assert_eq!(result["excluded"][0]["reason"], "underlying_unusable");
        Ok(())
    }

    #[test]
    fn adverse_groups_preserve_same_underlying_hedges_but_not_cross_underlying_offsets()
    -> anyhow::Result<()> {
        let cases: Vec<Value> = serde_json::from_str(include_str!(
            "../../tests/fixtures/monitor-risk-parity.json"
        ))?;
        let a = &cases[0];
        let b = &cases[1];
        let mut row_b = b["row"].clone();
        row_b["underlyingSymbol"] = json!("OTHER");
        let settings = RiskSettings {
            horizon_days: 0,
            volatility_scaled: false,
            ..Default::default()
        };
        let snapshot = json!({"positions":[a["row"],row_b],"grossHoldingsValue":400,"inputs":{"enrichment":{"items":[a["item"],b["item"]]}}});
        let result = evaluate(&snapshot, &settings, "2026-11-10T00:00:00Z".parse()?);
        let values: Vec<f64> = result["scenarios"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|s| number(&s["pnl"]))
            .collect();
        assert!(values[7] < values[0] && values[7] < values[4]);
        let mut same = snapshot.clone();
        same["positions"][1]["underlyingSymbol"] = json!("TEST");
        let result = evaluate(&same, &settings, "2026-11-10T00:00:00Z".parse()?);
        let values: Vec<f64> = result["scenarios"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|s| number(&s["pnl"]))
            .collect();
        assert!(
            (values[7] - values[..5].iter().copied().fold(f64::INFINITY, f64::min)).abs() < 1e-9
        );
        Ok(())
    }

    #[test]
    fn limits_are_opt_in_and_validation_rejects_invalid_numbers() {
        let mut settings = RiskSettings::default();
        assert!(settings.max_loss_eur.is_none());
        assert!(settings.validate().is_ok());
        settings.shock_pct = f64::NAN;
        assert!(settings.validate().is_err());
        settings.shock_pct = 20.0;
        settings.max_loss_eur = Some(-1.0);
        assert!(settings.validate().is_err());
        settings.max_loss_eur = None;
        settings.max_knockout_7d_pct = Some(101.0);
        assert!(settings.validate().is_err());
    }
}
