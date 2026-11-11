//! Market calendar — trading-day detection for XETRA (Frankfurt) and NYSE.
//!
//! Hybrid approach: queries the free [FinCal API](https://fincalapi.com) first,
//! falls back to a hardcoded holiday table (2025–2030) when the API is unreachable.

use super::provider_access::ProviderAccess;
use std::collections::HashSet;
use std::sync::Arc;
use tokio::sync::Mutex;

use chrono::{Datelike, NaiveDate, TimeDelta, Timelike, Utc, Weekday};
use tracing::warn;

// ---------------------------------------------------------------------------
// Cache – avoid hitting the API more than once per calendar day
// ---------------------------------------------------------------------------
#[derive(Clone)]
pub struct MarketCalendar {
    access: ProviderAccess,
    cache: Arc<Mutex<Option<(NaiveDate, bool)>>>,
    endpoint: String,
}

impl MarketCalendar {
    pub fn new(access: ProviderAccess) -> Self {
        Self {
            access,
            cache: Arc::new(Mutex::new(None)),
            endpoint: "https://fincalapi.com/v1/day_status".into(),
        }
    }

    pub async fn is_xetra_trading_day(&self, date: NaiveDate) -> bool {
        // Hold across the request so simultaneous scheduler/status callers coalesce.
        let mut cache = self.cache.lock().await;
        if let Some((cached, result)) = *cache {
            if cached == date {
                return result;
            }
        }
        let resource = format!("XETRA:{date}");
        let key = std::env::var("FINCAL_API_KEY")
            .ok()
            .filter(|k| !k.is_empty());
        let response: anyhow::Result<serde_json::Value> = self
            .access
            .json("fincalapi.com", &resource, |client| {
                let request = client
                    .get(&self.endpoint)
                    .query(&[("calendar", "XETRA"), ("date", &date.to_string())]);
                match key {
                    Some(key) => request.bearer_auth(key),
                    None => request,
                }
            })
            .await;
        let result = match response {
            Ok(json) => match (json["is_holiday"].as_bool(), json["is_weekend"].as_bool()) {
                (Some(holiday), Some(weekend)) => !holiday && !weekend,
                _ => {
                    if let Err(error) = self
                        .access
                        .record("fincalapi.com", &resource, 0, None)
                        .await
                    {
                        warn!(%error, "cannot record calendar failure");
                    }
                    hardcoded_is_xetra_trading_day(date)
                }
            },
            Err(error) => {
                warn!(%error, "FinCal unavailable; using local calendar");
                hardcoded_is_xetra_trading_day(date)
            }
        };
        *cache = Some((date, result));
        result
    }
}

// ---------------------------------------------------------------------------
// Hardcoded fallback: XETRA holidays 2025–2030
// ---------------------------------------------------------------------------

/// Easter Sundays 2025–2030 (western calendar).
const EASTER_SUNDAYS: &[(i32, u32, u32)] = &[
    (2025, 4, 20),
    (2026, 4, 5),
    (2027, 3, 28),
    (2028, 4, 16),
    (2029, 4, 1),
    (2030, 4, 21),
];

/// Construct a `NaiveDate` from year-month-day without `unwrap`.
/// All call-sites in this module use compile-time-valid constants.
fn ymd(year: i32, month: u32, day: u32) -> NaiveDate {
    match NaiveDate::from_ymd_opt(year, month, day) {
        Some(d) => d,
        None => panic!("invalid calendar date {year}-{month:02}-{day:02}"),
    }
}

fn easter_sunday(year: i32) -> Option<NaiveDate> {
    EASTER_SUNDAYS
        .iter()
        .find(|(y, _, _)| *y == year)
        .map(|(_, m, d)| ymd(year, *m, *d))
}

/// XETRA / Börse Frankfurt non-trading days.
/// Fixed-date holidays always fall on the exact date (no "observed" rule).
fn xetra_holidays_for_year(year: i32) -> Vec<NaiveDate> {
    let easter = easter_sunday(year);
    let mut days = vec![
        ymd(year, 1, 1),   // New Year
        ymd(year, 5, 1),   // Labour Day
        ymd(year, 12, 24), // Christmas Eve
        ymd(year, 12, 25), // Christmas
        ymd(year, 12, 26), // Boxing Day
        ymd(year, 12, 31), // New Year's Eve
    ];
    if let Some(e) = easter {
        days.push(e - TimeDelta::days(2)); // Good Friday
        days.push(e + TimeDelta::days(1)); // Easter Monday
    }
    days
}

fn is_weekend(date: NaiveDate) -> bool {
    matches!(date.weekday(), Weekday::Sat | Weekday::Sun)
}

fn hardcoded_is_xetra_trading_day(date: NaiveDate) -> bool {
    if is_weekend(date) {
        return false;
    }
    let holidays: HashSet<NaiveDate> = (2025..=2030).flat_map(xetra_holidays_for_year).collect();
    !holidays.contains(&date)
}

// ---------------------------------------------------------------------------
// CET / CEST helpers (Europe/Berlin timezone without chrono-tz)
// ---------------------------------------------------------------------------

/// Last Sunday of a given month (used for DST transitions).
fn last_sunday_of_month(year: i32, month: u32) -> NaiveDate {
    // Start from the last day of the month, walk back to Sunday.
    let last_day = if month == 12 {
        ymd(year + 1, 1, 1) - TimeDelta::days(1)
    } else {
        ymd(year, month + 1, 1) - TimeDelta::days(1)
    };
    let offset = last_day.weekday().num_days_from_sunday();
    last_day - TimeDelta::days(offset as i64)
}

/// UTC offset in hours for Europe/Berlin on a given date.
/// CET = +1 (winter), CEST = +2 (summer, last Sun Mar – last Sun Oct).
fn cet_utc_offset_hours(date: NaiveDate) -> i64 {
    let dst_start = last_sunday_of_month(date.year(), 3);
    let dst_end = last_sunday_of_month(date.year(), 10);
    if date >= dst_start && date < dst_end {
        2 // CEST
    } else {
        1 // CET
    }
}

/// Current hour in Europe/Berlin time (0–23).
pub fn current_cet_hour() -> u32 {
    berlin_now().hour()
}

pub fn berlin_now() -> chrono::DateTime<Utc> {
    let now = Utc::now();
    let today = now.date_naive();
    let offset = cet_utc_offset_hours(today);
    now + TimeDelta::hours(offset)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn refused_calendar_keeps_local_fallback_across_client_restart() -> anyhow::Result<()> {
        use crate::services::provider_test_support::{MockHttp, database};
        let server = MockHttp::start(403, "{}", None).await?;
        let access = ProviderAccess::from_pool(database().await?, 0.0).await?;
        let mut first = MarketCalendar::new(access.clone());
        first.endpoint = server.url.clone();
        let day = ymd(2026, 11, 11);
        let (one, two) = tokio::join!(
            first.is_xetra_trading_day(day),
            first.is_xetra_trading_day(day)
        );
        assert_eq!((one, two), (true, true));
        let mut restarted = MarketCalendar::new(access);
        restarted.endpoint = server.url.clone();
        assert!(restarted.is_xetra_trading_day(day).await);
        assert_eq!(server.hits(), 1);
        Ok(())
    }

    #[test]
    fn test_weekend_detection() {
        // 2026-06-20 is a Saturday
        assert!(is_weekend(ymd(2026, 6, 20)));
        // 2026-06-22 is a Monday
        assert!(!is_weekend(ymd(2026, 6, 22)));
    }

    #[test]
    fn test_hardcoded_xetra_2026() {
        // Good Friday 2026
        assert!(!hardcoded_is_xetra_trading_day(ymd(2026, 4, 3)));
        // Easter Monday 2026
        assert!(!hardcoded_is_xetra_trading_day(ymd(2026, 4, 6)));
        // Labour Day 2026
        assert!(!hardcoded_is_xetra_trading_day(ymd(2026, 5, 1)));
        // Regular Tuesday (2026-06-23)
        assert!(hardcoded_is_xetra_trading_day(ymd(2026, 6, 23)));
        // XETRA trades on Ascension Day
        assert!(hardcoded_is_xetra_trading_day(ymd(2026, 5, 14)));
    }

    #[test]
    fn test_easter_sunday() {
        assert_eq!(easter_sunday(2026), Some(ymd(2026, 4, 5)));
        assert_eq!(easter_sunday(2027), Some(ymd(2027, 3, 28)));
    }

    #[test]
    fn test_last_sunday_of_month() {
        // March 2026 – last Sunday is March 29
        assert_eq!(last_sunday_of_month(2026, 3), ymd(2026, 3, 29));
        // October 2026 – last Sunday is October 25
        assert_eq!(last_sunday_of_month(2026, 10), ymd(2026, 10, 25));
    }

    #[test]
    fn test_cet_offset_winter() {
        // January is CET (UTC+1)
        assert_eq!(cet_utc_offset_hours(ymd(2026, 1, 15)), 1);
    }

    #[test]
    fn test_cet_offset_summer() {
        // July is CEST (UTC+2)
        assert_eq!(cet_utc_offset_hours(ymd(2026, 7, 15)), 2);
    }
}
