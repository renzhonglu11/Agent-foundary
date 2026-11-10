//! Daily price history of an underlying and the statistics derived from it.
//!
//! The statistics describe what the underlying has done; they are inputs to
//! exit signals, not forecasts.

use chrono::NaiveDate;
use serde::{Deserialize, Serialize};

const TRADING_DAYS_PER_YEAR: f64 = 252.0;
const YEAR_WINDOW: usize = 252;

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct DailyBar {
    pub date: NaiveDate,
    pub open: f64,
    pub high: f64,
    pub low: f64,
    pub close: f64,
}

/// Cached history of one symbol, oldest bar first.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StoredDailyBars {
    pub symbol: String,
    pub feed: String,
    pub adjustment: String,
    pub bars: Vec<DailyBar>,
}

/// Prices are in the listing currency. Volatilities are annualized decimals
/// and returns are percentages; a field is `None` when the history is too
/// short for it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DailyBarStats {
    pub symbol: String,
    pub as_of: Option<NaiveDate>,
    pub bar_count: usize,
    pub last_close: Option<f64>,
    pub realized_vol_20d: Option<f64>,
    pub realized_vol_60d: Option<f64>,
    /// Share of the earlier rolling 20-day volatilities below the current one, 0 to 100.
    pub realized_vol_20d_percentile: Option<f64>,
    pub sma_20: Option<f64>,
    pub sma_50: Option<f64>,
    pub sma_200: Option<f64>,
    pub high_52w: Option<f64>,
    pub low_52w: Option<f64>,
    pub return_5d_pct: Option<f64>,
    pub return_20d_pct: Option<f64>,
    pub return_60d_pct: Option<f64>,
    /// Largest one-day close-to-close fall and rise in the last year.
    pub worst_day_pct: Option<f64>,
    pub best_day_pct: Option<f64>,
    pub fetched_at: String,
    /// The cache is older than the refresh interval and could not be renewed.
    pub stale: bool,
}

pub fn summarize(symbol: &str, bars: &[DailyBar], fetched_at: &str, stale: bool) -> DailyBarStats {
    let closes: Vec<f64> = bars
        .iter()
        .map(|bar| bar.close)
        .filter(|close| close.is_finite() && *close > 0.0)
        .collect();
    let log_returns: Vec<f64> = closes
        .windows(2)
        .map(|pair| (pair[1] / pair[0]).ln())
        .collect();
    let year = &bars[bars.len().saturating_sub(YEAR_WINDOW)..];
    let year_returns = &log_returns[log_returns.len().saturating_sub(YEAR_WINDOW)..];
    let extreme = |pick: fn(f64, f64) -> f64| {
        year_returns
            .iter()
            .copied()
            .reduce(pick)
            .map(|value| (value.exp() - 1.0) * 100.0)
    };

    DailyBarStats {
        symbol: symbol.to_owned(),
        as_of: bars.last().map(|bar| bar.date),
        bar_count: bars.len(),
        last_close: closes.last().copied(),
        realized_vol_20d: realized_volatility(&log_returns, 20),
        realized_vol_60d: realized_volatility(&log_returns, 60),
        realized_vol_20d_percentile: rolling_volatility_percentile(&log_returns, 20),
        sma_20: moving_average(&closes, 20),
        sma_50: moving_average(&closes, 50),
        sma_200: moving_average(&closes, 200),
        high_52w: year.iter().map(|bar| bar.high).reduce(f64::max),
        low_52w: year.iter().map(|bar| bar.low).reduce(f64::min),
        return_5d_pct: trailing_return_pct(&closes, 5),
        return_20d_pct: trailing_return_pct(&closes, 20),
        return_60d_pct: trailing_return_pct(&closes, 60),
        worst_day_pct: extreme(f64::min),
        best_day_pct: extreme(f64::max),
        fetched_at: fetched_at.to_owned(),
        stale,
    }
}

/// Sample standard deviation of the last `window` daily log returns, annualized.
fn realized_volatility(log_returns: &[f64], window: usize) -> Option<f64> {
    if window < 2 || log_returns.len() < window {
        return None;
    }
    let sample = &log_returns[log_returns.len() - window..];
    let mean = sample.iter().sum::<f64>() / window as f64;
    let variance = sample
        .iter()
        .map(|value| (value - mean).powi(2))
        .sum::<f64>()
        / (window - 1) as f64;
    Some((variance * TRADING_DAYS_PER_YEAR).sqrt())
}

/// Rank of the last value among the ones before it: the percentage of earlier
/// values that are lower. `None` without any earlier value.
pub(crate) fn percentile_rank(values: &[f64]) -> Option<f64> {
    let (latest, earlier) = values.split_last()?;
    if earlier.is_empty() {
        return None;
    }
    let below = earlier.iter().filter(|value| *value < latest).count();
    Some(below as f64 / earlier.len() as f64 * 100.0)
}

/// Needs at least 60 rolling windows, so about four months of history.
fn rolling_volatility_percentile(log_returns: &[f64], window: usize) -> Option<f64> {
    const MIN_WINDOWS: usize = 60;
    if window < 2 || log_returns.len() < window + MIN_WINDOWS - 1 {
        return None;
    }
    let series: Vec<f64> = (window..=log_returns.len())
        .filter_map(|end| realized_volatility(&log_returns[..end], window))
        .collect();
    percentile_rank(&series)
}

fn moving_average(closes: &[f64], window: usize) -> Option<f64> {
    if window == 0 || closes.len() < window {
        return None;
    }
    Some(closes[closes.len() - window..].iter().sum::<f64>() / window as f64)
}

fn trailing_return_pct(closes: &[f64], sessions: usize) -> Option<f64> {
    let last = *closes.last()?;
    let base = *closes.get(closes.len().checked_sub(sessions + 1)?)?;
    Some((last / base - 1.0) * 100.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bars(closes: &[f64]) -> anyhow::Result<Vec<DailyBar>> {
        let start = NaiveDate::from_ymd_opt(2026, 1, 1)
            .ok_or_else(|| anyhow::anyhow!("invalid start date"))?;
        Ok(closes
            .iter()
            .enumerate()
            .map(|(index, close)| DailyBar {
                date: start + chrono::Days::new(index as u64),
                open: *close,
                high: close * 1.01,
                low: close * 0.99,
                close: *close,
            })
            .collect())
    }

    fn close_to(actual: Option<f64>, expected: f64) -> bool {
        actual.is_some_and(|value| (value - expected).abs() < 1e-9)
    }

    #[test]
    fn alternating_returns_give_the_expected_annualized_volatility() -> anyhow::Result<()> {
        // 21 closes alternating +1% / -1% in log terms: 20 returns, mean zero.
        let step = 0.01_f64;
        let mut closes = vec![100.0];
        for index in 0..20 {
            let sign = if index % 2 == 0 { 1.0 } else { -1.0 };
            let previous = closes[closes.len() - 1];
            closes.push(previous * (sign * step).exp());
        }
        let stats = summarize("TEST", &bars(&closes)?, "2026-01-22T00:00:00Z", false);

        // Sample variance of ten +s and ten -s is s² × 20 / 19.
        let expected = (step.powi(2) * 20.0 / 19.0 * 252.0).sqrt();
        assert!(close_to(stats.realized_vol_20d, expected));
        assert_eq!(stats.realized_vol_60d, None);
        assert_eq!(stats.realized_vol_20d_percentile, None);
        assert!(close_to(stats.worst_day_pct, ((-step).exp() - 1.0) * 100.0));
        assert!(close_to(stats.best_day_pct, (step.exp() - 1.0) * 100.0));
        Ok(())
    }

    #[test]
    fn averages_returns_and_range_use_the_most_recent_sessions() -> anyhow::Result<()> {
        let closes: Vec<f64> = (1..=60).map(f64::from).collect();
        let stats = summarize("TEST", &bars(&closes)?, "fetched", true);

        assert_eq!(stats.bar_count, 60);
        assert_eq!(stats.last_close, Some(60.0));
        assert!(close_to(stats.sma_20, 50.5));
        assert!(close_to(stats.sma_50, 35.5));
        assert_eq!(stats.sma_200, None);
        assert!(close_to(stats.return_5d_pct, (60.0 / 55.0 - 1.0) * 100.0));
        assert!(close_to(stats.return_20d_pct, 50.0));
        assert_eq!(stats.return_60d_pct, None);
        assert!(close_to(stats.high_52w, 60.6));
        assert!(close_to(stats.low_52w, 0.99));
        assert!(stats.stale);
        assert_eq!(stats.as_of, NaiveDate::from_ymd_opt(2026, 3, 1));
        Ok(())
    }

    #[test]
    fn volatility_percentile_ranks_the_current_window_against_the_past() -> anyhow::Result<()> {
        // Daily moves that keep growing, and ones that keep shrinking, so every
        // rolling window differs from the one before it.
        let series = |growing: bool| {
            let mut closes = vec![100.0_f64];
            for index in 0..120 {
                let position = if growing { index } else { 119 - index };
                let step = 0.004 + f64::from(position) * 0.0002;
                let sign = if index % 2 == 0 { 1.0 } else { -1.0 };
                let previous = closes[closes.len() - 1];
                closes.push(previous * (sign * step).exp());
            }
            closes
        };
        let rising = summarize("UP", &bars(&series(true))?, "fetched", false);
        assert_eq!(rising.realized_vol_20d_percentile, Some(100.0));
        let calming = summarize("DOWN", &bars(&series(false))?, "fetched", false);
        assert_eq!(calming.realized_vol_20d_percentile, Some(0.0));
        assert_eq!(percentile_rank(&[1.0]), None);
        assert_eq!(percentile_rank(&[1.0, 3.0, 2.0]), Some(50.0));
        Ok(())
    }

    #[test]
    fn empty_history_yields_no_statistics() {
        let stats = summarize("NONE", &[], "never", true);
        assert_eq!(stats.bar_count, 0);
        assert_eq!(stats.as_of, None);
        assert_eq!(stats.last_close, None);
        assert_eq!(stats.realized_vol_20d, None);
        assert_eq!(stats.high_52w, None);
        assert_eq!(stats.worst_day_pct, None);
    }

    #[test]
    fn serializes_with_the_frontend_field_names() -> anyhow::Result<()> {
        let json = serde_json::to_value(summarize("X", &[], "never", false))?;
        for field in [
            "asOf",
            "barCount",
            "lastClose",
            "realizedVol20d",
            "realizedVol60d",
            "realizedVol20dPercentile",
            "sma20",
            "sma50",
            "sma200",
            "high52w",
            "low52w",
            "return5dPct",
            "return20dPct",
            "return60dPct",
            "worstDayPct",
            "bestDayPct",
            "fetchedAt",
        ] {
            anyhow::ensure!(json.get(field).is_some(), "missing field {field}");
        }
        Ok(())
    }
}
