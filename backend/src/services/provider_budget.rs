//! Rolling request budgets; the equivalent Python reservation uses the same table.
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Clone, Debug, Deserialize)]
pub(super) struct Budget {
    pub hour: usize,
    pub day: usize,
    #[serde(default)]
    pub tier1_reserved_hour: usize,
    #[serde(default)]
    pub tier1_reserved_day: usize,
}

impl Budget {
    pub fn valid(&self) -> bool {
        self.hour > 0
            && self.day > 0
            && self.tier1_reserved_hour < self.hour
            && self.tier1_reserved_day < self.day
    }

    pub fn usage(&self, events: &[(f64, String)], now: f64) -> BudgetUsage {
        BudgetUsage {
            hour: Window::new(
                events,
                now - 3600.0,
                3600.0,
                self.hour,
                self.tier1_reserved_hour,
            ),
            day: Window::new(
                events,
                now - 86400.0,
                86400.0,
                self.day,
                self.tier1_reserved_day,
            ),
        }
    }
}

pub(super) struct BudgetUsage {
    hour: Window,
    day: Window,
}

impl BudgetUsage {
    pub fn blocked(&self, tier1: bool) -> bool {
        self.hour.blocked(tier1) || self.day.blocked(tier1)
    }

    pub fn retry_at(&self, tier1: bool) -> f64 {
        self.hour.retry_at(tier1).max(self.day.retry_at(tier1))
    }

    pub fn payload(&self) -> Value {
        json!({
            "hour": self.hour.payload(), "day": self.day.payload(),
            "limited": self.blocked(true), "backgroundLimited": self.blocked(false),
            "retryAt": super::provider_access::iso_time(self.retry_at(true)),
            "backgroundRetryAt": super::provider_access::iso_time(self.retry_at(false)),
        })
    }
}

struct Window {
    count: usize,
    background: usize,
    limit: usize,
    reserved: usize,
    total_retry: f64,
    background_retry: f64,
}

impl Window {
    fn new(
        events: &[(f64, String)],
        since: f64,
        seconds: f64,
        limit: usize,
        reserved: usize,
    ) -> Self {
        let all: Vec<f64> = events
            .iter()
            .filter(|(at, _)| *at > since)
            .map(|(at, _)| *at)
            .collect();
        let background: Vec<f64> = events
            .iter()
            .filter(|(at, p)| *at > since && p != "tier1")
            .map(|(at, _)| *at)
            .collect();
        // Sorted by requested_at. When policy is tightened below existing usage,
        // wait until enough reservations expire, not just the oldest one.
        let retry = |times: &[f64], cap: usize| {
            if cap == 0 {
                return since + seconds * 2.0;
            }
            if times.len() < cap {
                0.0
            } else {
                times[times.len() - cap] + seconds
            }
        };
        Self {
            count: all.len(),
            background: background.len(),
            limit,
            reserved,
            total_retry: retry(&all, limit),
            background_retry: retry(&background, limit - reserved),
        }
    }

    fn blocked(&self, tier1: bool) -> bool {
        self.count >= self.limit || (!tier1 && self.background >= self.limit - self.reserved)
    }

    fn retry_at(&self, tier1: bool) -> f64 {
        if tier1 {
            self.total_retry
        } else {
            self.total_retry.max(self.background_retry)
        }
    }

    fn payload(&self) -> Value {
        json!({ "used": self.count, "limit": self.limit, "tier1Reserved": self.reserved,
            "backgroundUsed": self.background, "remaining": self.limit.saturating_sub(self.count),
            "backgroundRemaining": (self.limit - self.reserved).saturating_sub(self.background).min(self.limit.saturating_sub(self.count)) })
    }
}
