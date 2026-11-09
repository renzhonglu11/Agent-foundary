//! Where a product's implied volatility stands within its own recorded history.
//!
//! A single warrant's IV also drifts with moneyness and remaining life, so the
//! rank is a rough gauge of cheap or expensive optionality, not a forecast.

use std::collections::BTreeMap;

use serde::Serialize;

use crate::{
    application::ports::market_data_repository::IvObservation,
    services::daily_bars::percentile_rank,
};

/// Fewer observations than this say too little about a product's range.
pub const MIN_OBSERVATIONS_FOR_PERCENTILE: usize = 20;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IvHistoryStats {
    pub isin: String,
    pub observations: usize,
    pub first_observed_on: String,
    pub last_observed_on: String,
    /// Volatilities are decimals: 0.45 is 45%.
    pub latest_iv: f64,
    pub min_iv: f64,
    pub max_iv: f64,
    /// Share of earlier observations below the latest one, 0 to 100.
    pub percentile: Option<f64>,
}

/// Providers report IV as a fraction or as a percentage; above 1 is read as a
/// percentage, matching the frontend.
fn as_fraction(iv: f64) -> f64 {
    if iv > 1.0 { iv / 100.0 } else { iv }
}

/// `observations` may arrive in any order; each product is ranked by date.
pub fn summarize(observations: &[IvObservation]) -> Vec<IvHistoryStats> {
    let mut by_isin: BTreeMap<&str, Vec<(&str, f64)>> = BTreeMap::new();
    for observation in observations {
        if observation.iv.is_finite() && observation.iv > 0.0 {
            by_isin.entry(observation.isin.as_str()).or_default().push((
                observation.observed_on.as_str(),
                as_fraction(observation.iv),
            ));
        }
    }

    by_isin
        .into_iter()
        .filter_map(|(isin, mut series)| {
            series.sort_by(|left, right| left.0.cmp(right.0));
            let (first_observed_on, _) = *series.first()?;
            let (last_observed_on, latest_iv) = *series.last()?;
            let values: Vec<f64> = series.iter().map(|(_, iv)| *iv).collect();
            Some(IvHistoryStats {
                isin: isin.to_owned(),
                observations: values.len(),
                first_observed_on: first_observed_on.to_owned(),
                last_observed_on: last_observed_on.to_owned(),
                latest_iv,
                min_iv: values.iter().copied().fold(f64::INFINITY, f64::min),
                max_iv: values.iter().copied().fold(f64::NEG_INFINITY, f64::max),
                percentile: (values.len() >= MIN_OBSERVATIONS_FOR_PERCENTILE)
                    .then(|| percentile_rank(&values))
                    .flatten(),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn observation(isin: &str, day: usize, iv: f64) -> IvObservation {
        IvObservation {
            isin: isin.to_owned(),
            observed_on: format!("2026-01-{day:02}"),
            iv,
        }
    }

    #[test]
    fn ranks_the_latest_observation_once_enough_history_exists() {
        // Twenty days rising from 30% to 49%, then a fall back to 34.5%.
        let mut observations: Vec<_> = (1..=20)
            .map(|day| observation("LONG", day, 0.29 + day as f64 * 0.01))
            .collect();
        observations.push(observation("LONG", 21, 0.345));
        observations.push(observation("SHORT", 2, 55.0));
        observations.push(observation("SHORT", 1, 0.5));
        observations.push(observation("SHORT", 3, f64::NAN));
        observations.reverse();

        let stats = summarize(&observations);
        assert_eq!(stats.len(), 2);
        let long = &stats[0];
        assert_eq!((long.isin.as_str(), long.observations), ("LONG", 21));
        assert_eq!(long.first_observed_on, "2026-01-01");
        assert_eq!(long.last_observed_on, "2026-01-21");
        // Five of the twenty earlier values (30% to 34%) lie below 34.5%.
        assert_eq!(long.percentile, Some(25.0));
        assert!((long.min_iv - 0.30).abs() < 1e-9 && (long.max_iv - 0.49).abs() < 1e-9);

        // Too short for a rank; 55 is read as 55%.
        let short = &stats[1];
        assert_eq!((short.observations, short.percentile), (2, None));
        assert!((short.latest_iv - 0.55).abs() < 1e-9);
    }
}
