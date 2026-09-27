use apca::api::v2::calendar::OpenClose;
use chrono::{DateTime, Datelike, NaiveDate, TimeDelta, Utc};
use serde::Serialize;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsSession {
    pub state: &'static str,
    pub last_close: Option<DateTime<Utc>>,
    pub open: Option<DateTime<Utc>>,
    pub next_open: Option<DateTime<Utc>>,
    pub source: &'static str,
}

// US DST rules since 2007. Calendar days come from Alpaca, including early closes.
fn ny_offset(date: NaiveDate) -> i64 {
    let sunday = |month: u32, nth: u32| {
        let first = NaiveDate::from_ymd_opt(date.year(), month, 1).unwrap_or(date);
        first
            + TimeDelta::days(
                ((7 - first.weekday().num_days_from_sunday()) % 7 + 7 * (nth - 1)) as i64,
            )
    };
    if date >= sunday(3, 2) && date < sunday(11, 1) {
        4
    } else {
        5
    }
}

pub fn us_session(now: DateTime<Utc>, calendar: Option<&[OpenClose]>) -> UsSession {
    let Some(calendar) = calendar.filter(|days| !days.is_empty()) else {
        return UsSession {
            state: "unknown",
            last_close: None,
            open: None,
            next_open: None,
            source: "unavailable",
        };
    };
    let mut session = UsSession {
        state: "closed",
        last_close: None,
        open: None,
        next_open: None,
        source: "alpaca_calendar",
    };
    for day in calendar {
        let open = day.date.and_time(day.open).and_utc() + TimeDelta::hours(ny_offset(day.date));
        let close = day.date.and_time(day.close).and_utc() + TimeDelta::hours(ny_offset(day.date));
        if now >= open && now < close {
            session.state = "open";
            session.open = Some(open);
        }
        if close <= now {
            session.last_close = Some(session.last_close.map_or(close, |v| v.max(close)));
        }
        if open > now {
            session.next_open = Some(session.next_open.map_or(open, |v| v.min(open)));
        }
    }
    if session.next_open.is_none() && session.state != "open" {
        session.state = "unknown";
    }
    session
}

pub fn quote_quality(
    timestamp: Option<&str>,
    now: DateTime<Utc>,
    session: &UsSession,
) -> &'static str {
    let Some(time) = timestamp
        .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
        .map(|v| v.with_timezone(&Utc))
    else {
        return "unknown_time";
    };
    if time > now + TimeDelta::minutes(2) {
        return "future_time";
    }
    if session.state == "unknown" {
        return "unknown_calendar";
    }
    let threshold = if session.state == "open" {
        // Opening grace: accept previous close only during the first ten minutes.
        if session
            .open
            .is_some_and(|open| now - open < TimeDelta::minutes(10))
        {
            session.last_close.map(|v| v - TimeDelta::minutes(15))
        } else {
            Some(now - TimeDelta::minutes(10))
        }
    } else {
        session.last_close.map(|v| v - TimeDelta::minutes(15))
    };
    match threshold {
        Some(threshold) if time >= threshold => {
            if session.state == "open" {
                "fresh"
            } else {
                "closed_last_session"
            }
        }
        Some(_) => "stale",
        None => "unknown_calendar",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn holidays_old_quotes_and_early_closes() -> anyhow::Result<()> {
        let days: Vec<OpenClose> = serde_json::from_value(serde_json::json!([
            {"date":"2026-09-04","open":"09:30","close":"16:00"},
            {"date":"2026-09-08","open":"09:30","close":"16:00"}
        ]))?;
        let now = "2026-09-07T16:00:00Z".parse()?;
        let s = us_session(now, Some(&days));
        assert_eq!(s.state, "closed"); // Labor Day, not a XETRA holiday.
        assert_eq!(
            quote_quality(Some("2026-09-04T20:00:00Z"), now, &s),
            "closed_last_session"
        );
        assert_eq!(
            quote_quality(Some("2026-08-25T20:00:00Z"), now, &s),
            "stale"
        );
        assert_eq!(quote_quality(None, now, &s), "unknown_time");
        assert_eq!(
            quote_quality(Some("2026-09-08T20:00:00Z"), now, &s),
            "future_time"
        );
        let days: Vec<OpenClose> = serde_json::from_value(serde_json::json!([
            {"date":"2026-11-27","open":"09:30","close":"13:00"},
            {"date":"2026-11-30","open":"09:30","close":"16:00"}
        ]))?;
        let now = "2026-11-27T18:05:00Z".parse()?;
        assert_eq!(us_session(now, Some(&days)).state, "closed");
        Ok(())
    }
    #[test]
    fn us_dst_is_independent_of_berlin() -> anyhow::Result<()> {
        assert_eq!(ny_offset("2026-03-06".parse()?), 5);
        assert_eq!(ny_offset("2026-03-09".parse()?), 4);
        assert_eq!(ny_offset("2026-11-02".parse()?), 5);
        Ok(())
    }
}
