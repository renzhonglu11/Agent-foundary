use std::sync::LazyLock;

use regex::Regex;
use serde_json::Value;

use crate::domain::portfolio::Position;

// One registry shared with browser grouping; never infer a US ticker from an ISIN prefix.
static SYMBOLS: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../../web/src/utils/marketSymbols.json"))
        .unwrap_or(Value::Null)
});
static WORDS: LazyLock<Regex> = LazyLock::new(|| {
    constant_regex(
        r"(?i)\b(registered|bearer|ordinary|common|preferred|shares?|aktien|adr|adrs|gdrs|ads|ord|class|dl|eur|usd|corporation|corp|inc|incorporated|company|co|ltd|limited|plc|llc|holdings?|ag|se|sa|nv)\b",
    )
});
static PREFIX: LazyLock<Regex> = LazyLock::new(|| {
    constant_regex(
        r"(?i)^(call|put)\s+\d{2}\.\d{2}\.\d{2}\s+|^(turboc|turbop|turbo|faktl|fakts)\s+o\.end\s+",
    )
});
static TRAILING: LazyLock<Regex> = LazyLock::new(|| constant_regex(r"\s+\d+[\d.,]*\s*$"));

fn constant_regex(pattern: &str) -> Regex {
    Regex::new(pattern).unwrap_or_else(|error| panic!("invalid constant regex: {error}"))
}

fn lookup(value: &str, ticker_allowed: bool) -> Option<String> {
    let raw = value.trim().to_ascii_uppercase();
    if let Some(symbol) = SYMBOLS["isin"][&raw].as_str() {
        return Some(symbol.to_owned());
    }
    let cleaned = PREFIX.replace(value.split('·').next().unwrap_or(value).trim(), "");
    let cleaned = TRAILING.replace(&cleaned, "");
    let cleaned = WORDS.replace_all(&cleaned, " ");
    let cleaned = cleaned
        .replace(['-', ',', '.', ';', '(', ')', '/'], " ")
        .to_lowercase();
    let key = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    let key = SYMBOLS["canonical"][&key].as_str().unwrap_or(&key);
    if let Some(symbol) = SYMBOLS["alias"][key].as_str() {
        return Some(symbol.to_owned());
    }
    // Only explicit all-caps ticker fields and known tickers may pass through.
    let known = SYMBOLS["isin"]
        .as_object()
        .into_iter()
        .flat_map(|m| m.values())
        .chain(
            SYMBOLS["alias"]
                .as_object()
                .into_iter()
                .flat_map(|m| m.values()),
        )
        .any(|v| v.as_str() == Some(raw.as_str()));
    if known
        || (ticker_allowed
            && value.trim() == raw
            && raw.len() <= 5
            && raw.chars().all(|c| c.is_ascii_uppercase() || c == '.')
            && !raw.is_empty())
    {
        return Some(raw);
    }
    None
}

pub fn underlying_symbol(position: &Position, item: &Value) -> Option<String> {
    let derivative = position.asset_class.to_uppercase().contains("DERIVATIVE")
        || item["product_type"].is_string();
    if position.asset_class == "BOND" {
        return None;
    }
    if !derivative {
        if let Some(symbol) = lookup(&position.symbol, true) {
            return Some(symbol);
        }
    }
    for value in [
        item["underlying"].as_str().unwrap_or(""),
        position.instrument.as_str(),
        position.name.as_str(),
        position.display_name.as_str(),
        position.pdf_name.as_str(),
    ] {
        if let Some(symbol) = lookup(
            value,
            derivative && value == item["underlying"].as_str().unwrap_or(""),
        ) {
            return Some(symbol);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn resolves_derivatives_and_keeps_unknowns_explicit() {
        let p = Position {
            asset_class: "DERIVATIVE".into(),
            instrument: "Call 15.01.27 DellTech 160".into(),
            ..Default::default()
        };
        assert_eq!(underlying_symbol(&p, &Value::Null).as_deref(), Some("DELL"));
        assert_eq!(
            underlying_symbol(&p, &serde_json::json!({"underlying":"NIO"})).as_deref(),
            Some("NIO")
        );
        let p = Position {
            symbol: "DE000UNKNOWN".into(),
            name: "Unknown company".into(),
            ..Default::default()
        };
        assert_eq!(underlying_symbol(&p, &Value::Null), None);
    }

    #[test]
    fn resolves_broker_truncated_company_names_to_real_tickers() {
        for (underlying, expected) in [
            ("salesfor", "CRM"),
            ("SALESFORCE.COM", "CRM"),
            ("Netflix", "NFLX"),
            ("ServiceN", "NOW"),
            ("SERVICENOW INC.", "NOW"),
        ] {
            let position = Position {
                asset_class: "DERIVATIVE".into(),
                ..Default::default()
            };
            let item = serde_json::json!({"product_type":"optionsschein","underlying":underlying});
            assert_eq!(
                underlying_symbol(&position, &item).as_deref(),
                Some(expected),
                "failed to resolve {underlying}"
            );
        }
    }
}
