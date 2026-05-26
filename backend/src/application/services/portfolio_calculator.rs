use std::{
    collections::{HashMap, HashSet},
    path::Path,
};

use chrono::Utc;
use regex::Regex;

use crate::domain::{
    portfolio::{
        AllocationSlice, Dividend, DividendBySymbol, DividendMonthly, DividendRecord,
        DividendSummary, MonthlyActivity, PortfolioSummaryResponse, Position, RecentTransaction,
        SourceInfo, Summary,
    },
    transaction::Transaction,
};

#[derive(Debug, Clone, Default)]
pub struct CalculatorInput {
    pub csv_source: String,
    pub pdf_source: String,
    pub pdf_text_source: Option<String>,
    pub isin_names: HashMap<String, PdfSecurityInfo>,
    pub price_overrides: HashMap<String, PriceOverride>,
}

#[derive(Debug, Clone, Default)]
pub struct PdfSecurityInfo {
    pub display_name: String,
    pub pdf_name: String,
    pub issuer: String,
    pub instrument: String,
    pub quantity: Option<f64>,
    pub quote_price: Option<f64>,
    pub market_value: Option<f64>,
}

#[derive(Debug, Clone)]
pub struct PriceOverride {
    pub price: f64,
    pub source: String,
}

pub fn calculate_portfolio(
    transactions: &[Transaction],
    input: CalculatorInput,
) -> PortfolioSummaryResponse {
    let dividend_types = HashSet::from([
        "DIVIDEND",
        "DISTRIBUTION",
        "DIVIDEND_EQUIVALENT_PAYMENT",
        "INTEREST_PAYMENT",
    ]);
    let trading_types = HashSet::from([
        "BUY",
        "SELL",
        "DIVIDEND",
        "DISTRIBUTION",
        "REDEMPTION",
        "TILG",
        "INTEREST_PAYMENT",
        "DIVIDEND_EQUIVALENT_PAYMENT",
    ]);

    let issuer_by_symbol = issuer_by_symbol(transactions);
    let mut positions_by_symbol: HashMap<String, Position> = HashMap::new();
    let mut monthly: HashMap<String, MonthlyActivity> = HashMap::new();
    let mut dividend_monthly: HashMap<String, DividendMonthly> = HashMap::new();
    let mut dividend_by_symbol: HashMap<String, DividendBySymbol> = HashMap::new();
    let mut dividend_records = Vec::new();

    let mut summary = Summary::default();

    for tx in transactions {
        let amount = tx.amount.amount();
        let fee = tx.fee.amount();
        let tax = tx.tax.amount();
        let shares = tx.shares;
        let price = tx.price.amount();
        let tx_type = tx.transaction_type.as_str();

        summary.fees += fee;
        summary.taxes += tax;
        if fee != 0.0 {
            add_monthly(&mut monthly, tx, |bucket| bucket.fees += fee);
        }
        if tax != 0.0 {
            add_monthly(&mut monthly, tx, |bucket| bucket.taxes += tax);
        }

        if dividend_types.contains(tx_type) {
            let net_income = amount + tax;
            DividendAccumulator {
                isin_names: &input.isin_names,
                issuer_by_symbol: &issuer_by_symbol,
                records: &mut dividend_records,
                monthly: &mut dividend_monthly,
                by_symbol: &mut dividend_by_symbol,
            }
            .add_record(tx, amount, tax);
            summary.income += net_income;
            if !tx.symbol.is_empty() {
                ensure_position(
                    &mut positions_by_symbol,
                    tx,
                    &input.isin_names,
                    &issuer_by_symbol,
                )
                .income += net_income;
            }
            add_monthly(&mut monthly, tx, |bucket| bucket.income += net_income);
            continue;
        }

        if tx.category == "CASH" {
            if amount > 0.0 {
                summary.total_deposits += amount;
                add_monthly(&mut monthly, tx, |bucket| bucket.deposits += amount);
            } else if amount < 0.0 {
                summary.total_withdrawals += amount;
                add_monthly(&mut monthly, tx, |bucket| bucket.withdrawals += amount);
            }
            continue;
        }

        if tx.symbol.is_empty() && !trading_types.contains(tx_type) {
            continue;
        }

        if tx.symbol.is_empty() {
            continue;
        }

        let position = ensure_position(
            &mut positions_by_symbol,
            tx,
            &input.isin_names,
            &issuer_by_symbol,
        );
        if tx_type == "BUY" {
            let qty = shares.abs();
            let cost = (-(amount + fee + tax)).max(0.0);
            position.quantity += qty;
            position.cost_basis += cost;
            position.fees += fee;
            position.taxes += tax;
            position.last_price = non_zero(price, position.last_price);
            position.buys += 1;
            summary.trading_cashflow += amount + fee + tax;
            add_monthly(&mut monthly, tx, |bucket| bucket.buys += cost);
        } else if tx_type == "SELL" || tx_type == "REDEMPTION" {
            let qty = shares.abs();
            let avg_cost = if position.quantity > 0.0 {
                position.cost_basis / position.quantity
            } else {
                0.0
            };
            let removed_cost = position.cost_basis.min(avg_cost * qty);
            let proceeds = amount + fee + tax;
            let pnl = proceeds - removed_cost;
            position.quantity -= qty;
            if position.quantity.abs() < 1e-8 {
                position.quantity = 0.0;
            }
            position.cost_basis = (position.cost_basis - removed_cost).max(0.0);
            position.realized_pnl += pnl;
            position.fees += fee;
            position.taxes += tax;
            position.last_price = non_zero(price, position.last_price);
            position.sells += 1;
            summary.realized_pnl += pnl;
            summary.trading_cashflow += proceeds;
            add_monthly(&mut monthly, tx, |bucket| bucket.sells += proceeds);
        } else if [
            "DIVIDEND",
            "DISTRIBUTION",
            "INTEREST_PAYMENT",
            "TILG",
            "DIVIDEND_EQUIVALENT_PAYMENT",
        ]
        .contains(&tx_type)
        {
            let income = amount + tax;
            summary.income += income;
            position.income += income;
            add_monthly(&mut monthly, tx, |bucket| bucket.income += income);
        } else if shares != 0.0 {
            position.quantity += shares;
            position.last_price = non_zero(price, position.last_price);
        }
    }

    let mut positions = positions_by_symbol
        .into_values()
        .filter(|position| position.quantity.abs() > 1e-6)
        .map(|mut position| {
            if let Some(price) = price_for_position(&position, &input) {
                position.last_price = price;
            }
            position.market_value = market_value_for_position(&position, &input)
                .unwrap_or(position.quantity * position.last_price);
            position.unrealized_pnl = position.market_value - position.cost_basis;
            position.unrealized_pct = if position.cost_basis > 0.0 {
                (position.unrealized_pnl / position.cost_basis) * 100.0
            } else {
                0.0
            };
            position
        })
        .collect::<Vec<_>>();
    positions.sort_by(|a, b| b.market_value.total_cmp(&a.market_value));

    let mut allocation_by_class: HashMap<String, f64> = HashMap::new();
    for position in &positions {
        *allocation_by_class
            .entry(position.asset_class.clone())
            .or_default() += position.market_value;
    }

    summary.total_market_value = positions.iter().map(|position| position.market_value).sum();
    summary.total_cost_basis = positions.iter().map(|position| position.cost_basis).sum();
    summary.unrealized_pnl = summary.total_market_value - summary.total_cost_basis;
    summary.unrealized_pct = if summary.total_cost_basis > 0.0 {
        (summary.unrealized_pnl / summary.total_cost_basis) * 100.0
    } else {
        0.0
    };
    summary.open_positions = positions.len();
    summary.winners = positions
        .iter()
        .filter(|position| position.unrealized_pnl > 0.0)
        .count();
    summary.losers = positions
        .iter()
        .filter(|position| position.unrealized_pnl < 0.0)
        .count();

    let mut allocation = allocation_by_class
        .into_iter()
        .map(|(name, value)| AllocationSlice { name, value })
        .collect::<Vec<_>>();
    allocation.sort_by(|a, b| b.value.total_cmp(&a.value));

    let mut monthly_rows = monthly.into_values().collect::<Vec<_>>();
    monthly_rows.sort_by(|a, b| a.month.cmp(&b.month));

    let mut dividend_monthly_rows = dividend_monthly.into_values().collect::<Vec<_>>();
    dividend_monthly_rows.sort_by(|a, b| a.month.cmp(&b.month));

    let mut dividend_top_symbols = dividend_by_symbol.into_values().collect::<Vec<_>>();
    dividend_top_symbols.sort_by(|a, b| b.net_amount.total_cmp(&a.net_amount));

    let dividend_summary = DividendSummary {
        records: dividend_records.len(),
        gross_amount: dividend_records.iter().map(|item| item.gross_amount).sum(),
        tax: dividend_records.iter().map(|item| item.tax).sum(),
        net_amount: dividend_records.iter().map(|item| item.net_amount).sum(),
        symbols: dividend_top_symbols.len(),
        first_date: dividend_records.first().map(|item| item.date.clone()),
        last_date: dividend_records.last().map(|item| item.date.clone()),
    };

    let mut recent_transactions = transactions
        .iter()
        .rev()
        .take(20)
        .map(|tx| RecentTransaction {
            date: tx.date.clone(),
            transaction_type: tx.transaction_type.clone(),
            category: tx.category.clone(),
            asset_class: tx.asset_class.0.clone(),
            name: first_non_empty([tx.name.as_str(), tx.description.as_str(), "-"]),
            symbol: tx.symbol.0.clone(),
            amount: tx.amount.amount(),
            fee: tx.fee.amount(),
            tax: tx.tax.amount(),
            currency: tx.currency.clone(),
        })
        .collect::<Vec<_>>();
    recent_transactions.shrink_to_fit();

    dividend_records.reverse();

    PortfolioSummaryResponse {
        generated_at: Utc::now().to_rfc3339(),
        source: SourceInfo {
            csv: input.csv_source,
            pdf: input.pdf_source,
            pdf_text: input.pdf_text_source,
            isin_name_matches: input.isin_names.len(),
            rows: transactions.len(),
            first_date: transactions.first().map(|tx| tx.date.clone()),
            last_date: transactions.last().map(|tx| tx.date.clone()),
        },
        summary,
        allocation,
        positions,
        monthly: monthly_rows,
        dividend: Dividend {
            summary: dividend_summary,
            monthly: dividend_monthly_rows,
            top_symbols: dividend_top_symbols,
            records: dividend_records,
        },
        recent_transactions,
    }
}

pub fn build_isin_name_map(
    path: Option<&Path>,
) -> anyhow::Result<HashMap<String, PdfSecurityInfo>> {
    let Some(path) = path else {
        return Ok(HashMap::new());
    };
    if !path.exists() {
        return Ok(HashMap::new());
    }

    let content = std::fs::read_to_string(path)?;
    Ok(parse_isin_name_map(&content))
}

fn parse_isin_name_map(content: &str) -> HashMap<String, PdfSecurityInfo> {
    let isin_pattern =
        Regex::new(r"\b[A-Z]{2}[A-Z0-9]{9}[0-9]\b").unwrap_or_else(|_| unreachable!());
    let quantity_pattern =
        Regex::new(r"^\d+(?:[,.]\d+)?\s+Stk\.$").unwrap_or_else(|_| unreachable!());
    let date_pattern = Regex::new(r"^\d{2}\.\d{2}\.\d{4}$").unwrap_or_else(|_| unreachable!());
    let amount_pattern = Regex::new(
        r"(?i)^\d{1,3}(?:\.\d{3})*,\d{2,6}(?:\s+(?:EUR|USD))?$|^\d+[,]\d+(?:\s+(?:EUR|USD))?$",
    )
    .unwrap_or_else(|_| unreachable!());
    let section_header_pattern = Regex::new(r"(?i)^(ANZAHL POSITIONEN|AKTIEN|DERIVATE|ZINSPRODUKTE|CASH|Aufstellung|STK\. / NOMINALE|WERTPAPIERBEZEICHNUNG|KURS PRO STÜCK|KURSWERT IN EUR|PRODUKT|SALDO)").unwrap_or_else(|_| unreachable!());
    let metadata_pattern = Regex::new(
        r"(?i)^(ISIN:|Lagerland:|Wertpapierrechnung|TRADE REPUBLIC BANK GMBH|30\.04\.2026)",
    )
    .unwrap_or_else(|_| unreachable!());
    let derivative_issuer_pattern = Regex::new(r"(?i)(GmbH|AG|Société Générale|HSBC|UBS|Morgan Stanley|J\.P\. Morgan|Goldman Sachs|Citigroup|BNP|Vontobel|UniCredit|DZ BANK|Deutsche Bank)").unwrap_or_else(|_| unreachable!());

    let lines = content
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>();
    let mut map = HashMap::new();

    for (index, line) in lines.iter().enumerate() {
        let Some(isin) = isin_pattern
            .find(line)
            .map(|match_| match_.as_str().to_owned())
        else {
            continue;
        };

        let mut name_lines = Vec::new();
        for candidate in lines[..index].iter().rev().take(4) {
            if isin_pattern.is_match(candidate)
                || quantity_pattern.is_match(candidate)
                || amount_pattern.is_match(candidate)
                || metadata_pattern.is_match(candidate)
                || section_header_pattern.is_match(candidate)
            {
                break;
            }
            name_lines.push((*candidate).to_owned());
        }
        name_lines.reverse();
        if name_lines.is_empty() {
            continue;
        }

        let first = name_lines.first().cloned().unwrap_or_default();
        let rest = name_lines.iter().skip(1).cloned().collect::<Vec<_>>();
        let is_derivative = derivative_issuer_pattern.is_match(&first) && !rest.is_empty();
        let display_name = if is_derivative {
            format!("{} · {}", rest.join(" "), first)
        } else {
            name_lines.join(" · ")
        };
        let quantity = lines[..index]
            .iter()
            .rev()
            .take(8)
            .find_map(|candidate| parse_quantity(candidate, &quantity_pattern));
        let (quote_price, market_value) =
            parse_pdf_quote_after_isin(&lines, index, &isin_pattern, &date_pattern);

        map.insert(
            isin,
            PdfSecurityInfo {
                display_name,
                pdf_name: name_lines.join(" · "),
                issuer: if is_derivative { first } else { String::new() },
                instrument: if is_derivative {
                    rest.join(" ")
                } else {
                    name_lines.first().cloned().unwrap_or_default()
                },
                quantity,
                quote_price,
                market_value,
            },
        );
    }

    map
}

fn ensure_position<'a>(
    positions: &'a mut HashMap<String, Position>,
    tx: &Transaction,
    isin_names: &HashMap<String, PdfSecurityInfo>,
    issuer_by_symbol: &HashMap<String, String>,
) -> &'a mut Position {
    let symbol = tx.symbol.as_str().to_owned();
    let pdf_info = isin_names.get(&symbol);
    let issuer =
        extract_issuer_from_description(tx).or_else(|| issuer_by_symbol.get(&symbol).cloned());

    let position = positions.entry(symbol.clone()).or_insert_with(|| Position {
        symbol: symbol.clone(),
        name: first_non_empty([tx.name.as_str(), "Unknown"]),
        display_name: build_display_name(tx, pdf_info, issuer.as_deref()),
        pdf_name: pdf_info
            .map(|info| info.pdf_name.clone())
            .unwrap_or_default(),
        issuer: issuer
            .clone()
            .or_else(|| pdf_info.map(|info| info.issuer.clone()))
            .unwrap_or_default(),
        instrument: pdf_info
            .map(|info| info.instrument.clone())
            .unwrap_or_default(),
        asset_class: tx.asset_class.0.clone(),
        last_trade_date: tx.date.clone(),
        ..Position::default()
    });

    position.name = first_non_empty([tx.name.as_str(), position.name.as_str()]);
    position.display_name = build_display_name(tx, pdf_info, issuer.as_deref());
    position.pdf_name = pdf_info
        .map(|info| info.pdf_name.clone())
        .unwrap_or_else(|| position.pdf_name.clone());
    position.issuer = issuer
        .or_else(|| pdf_info.map(|info| info.issuer.clone()))
        .unwrap_or_else(|| position.issuer.clone());
    position.instrument = pdf_info
        .map(|info| info.instrument.clone())
        .unwrap_or_else(|| position.instrument.clone());
    position.asset_class = tx.asset_class.0.clone();
    position.last_trade_date =
        first_non_empty([tx.date.as_str(), position.last_trade_date.as_str()]);
    position
}

fn add_monthly(
    monthly: &mut HashMap<String, MonthlyActivity>,
    tx: &Transaction,
    update: impl FnOnce(&mut MonthlyActivity),
) {
    let month = format_month(&tx.date);
    if month.is_empty() {
        return;
    }
    let bucket = monthly
        .entry(month.clone())
        .or_insert_with(|| MonthlyActivity {
            month,
            ..MonthlyActivity::default()
        });
    update(bucket);
}

struct DividendAccumulator<'a> {
    isin_names: &'a HashMap<String, PdfSecurityInfo>,
    issuer_by_symbol: &'a HashMap<String, String>,
    records: &'a mut Vec<DividendRecord>,
    monthly: &'a mut HashMap<String, DividendMonthly>,
    by_symbol: &'a mut HashMap<String, DividendBySymbol>,
}

impl DividendAccumulator<'_> {
    fn add_record(&mut self, tx: &Transaction, amount: f64, tax: f64) {
        let month = format_month(&tx.date);
        let symbol = first_non_empty([tx.symbol.as_str(), tx.name.as_str(), "Unknown"]);
        let pdf_info = self.isin_names.get(&symbol);
        let name = first_non_empty([tx.name.as_str(), tx.description.as_str(), symbol.as_str()]);
        let issuer = extract_issuer_from_description(tx)
            .or_else(|| self.issuer_by_symbol.get(&symbol).cloned())
            .or_else(|| pdf_info.map(|info| info.issuer.clone()))
            .unwrap_or_default();
        let display_name = build_display_name(tx, pdf_info, Some(&issuer));
        let net_amount = amount + tax;

        self.records.push(DividendRecord {
            id: first_non_empty([
                tx.transaction_id.as_str(),
                format!(
                    "{}-{}-{}-{}",
                    tx.date,
                    tx.transaction_type,
                    symbol,
                    self.records.len()
                )
                .as_str(),
            ]),
            date: tx.date.clone(),
            month: month.clone(),
            year: tx.date.chars().take(4).collect(),
            transaction_type: tx.transaction_type.clone(),
            asset_class: tx.asset_class.0.clone(),
            name: name.clone(),
            display_name: display_name.clone(),
            pdf_name: pdf_info
                .map(|info| info.pdf_name.clone())
                .unwrap_or_default(),
            issuer,
            symbol: symbol.clone(),
            gross_amount: amount,
            tax,
            net_amount,
            currency: tx.currency.clone(),
        });

        let month_bucket = self
            .monthly
            .entry(month.clone())
            .or_insert_with(|| DividendMonthly {
                month,
                ..DividendMonthly::default()
            });
        month_bucket.gross_amount += amount;
        month_bucket.tax += tax;
        month_bucket.net_amount += net_amount;
        month_bucket.count += 1;

        let symbol_bucket =
            self.by_symbol
                .entry(symbol.clone())
                .or_insert_with(|| DividendBySymbol {
                    symbol: symbol.clone(),
                    name: name.clone(),
                    display_name: display_name.clone(),
                    asset_class: tx.asset_class.0.clone(),
                    last_date: tx.date.clone(),
                    ..DividendBySymbol::default()
                });
        symbol_bucket.name = name;
        symbol_bucket.display_name = display_name;
        symbol_bucket.asset_class = tx.asset_class.0.clone();
        symbol_bucket.gross_amount += amount;
        symbol_bucket.tax += tax;
        symbol_bucket.net_amount += net_amount;
        symbol_bucket.count += 1;
        symbol_bucket.last_date =
            first_non_empty([tx.date.as_str(), symbol_bucket.last_date.as_str()]);
    }
}

fn issuer_by_symbol(transactions: &[Transaction]) -> HashMap<String, String> {
    let mut issuers = HashMap::new();
    for tx in transactions {
        if tx.symbol.is_empty() || issuers.contains_key(tx.symbol.as_str()) {
            continue;
        }
        if let Some(issuer) = extract_issuer_from_description(tx) {
            issuers.insert(tx.symbol.0.clone(), issuer);
        }
    }
    issuers
}

fn extract_issuer_from_description(tx: &Transaction) -> Option<String> {
    if tx.symbol.is_empty() || !tx.description.contains(tx.symbol.as_str()) {
        return None;
    }

    let pattern = format!(
        r"{}\s+(.+?)(?:,\s*quantity|$)",
        regex::escape(tx.symbol.as_str())
    );
    let regex = Regex::new(&pattern).ok()?;
    regex
        .captures(&tx.description)
        .and_then(|captures| captures.get(1))
        .map(|match_| match_.as_str().trim().to_owned())
        .filter(|issuer| !issuer.is_empty())
}

fn build_display_name(
    tx: &Transaction,
    pdf_info: Option<&PdfSecurityInfo>,
    issuer_from_csv: Option<&str>,
) -> String {
    let csv_name = first_non_empty([
        tx.name.as_str(),
        tx.description.as_str(),
        tx.symbol.as_str(),
        "Unknown",
    ]);
    if tx.asset_class.0 == "BOND" {
        if let Some(issuer) = issuer_from_csv.filter(|issuer| !issuer.is_empty()) {
            return format!("{issuer} · {csv_name}");
        }
    }

    pdf_info
        .map(|info| info.display_name.clone())
        .filter(|name| !name.is_empty())
        .unwrap_or(csv_name)
}

fn format_month(date: &str) -> String {
    date.chars().take(7).collect()
}

fn non_zero(value: f64, fallback: f64) -> f64 {
    if value == 0.0 { fallback } else { value }
}

fn price_for_position(position: &Position, input: &CalculatorInput) -> Option<f64> {
    if let Some(override_) = input.price_overrides.get(&position.symbol) {
        if override_.price > 0.0 {
            return Some(override_.price);
        }
    }

    input
        .isin_names
        .get(&position.symbol)?
        .quote_price
        .filter(|value| *value > 0.0)
}

fn market_value_for_position(position: &Position, input: &CalculatorInput) -> Option<f64> {
    if position.asset_class != "BOND" {
        return None;
    }

    input
        .isin_names
        .get(&position.symbol)?
        .market_value
        .filter(|value| *value > 0.0)
}

fn parse_quantity(value: &str, quantity_pattern: &Regex) -> Option<f64> {
    if !quantity_pattern.is_match(value) {
        return None;
    }

    parse_german_decimal(value.trim_end_matches(" Stk."))
}

fn parse_pdf_quote_after_isin(
    lines: &[&str],
    isin_index: usize,
    isin_pattern: &Regex,
    date_pattern: &Regex,
) -> (Option<f64>, Option<f64>) {
    let mut quote_price = None;
    let mut saw_quote_date = false;

    for candidate in lines.iter().skip(isin_index + 1).take(12) {
        if isin_pattern.is_match(candidate) {
            break;
        }
        if date_pattern.is_match(candidate) {
            saw_quote_date = quote_price.is_some();
            continue;
        }

        let Some(value) = parse_german_decimal(candidate) else {
            continue;
        };
        if quote_price.is_none() {
            quote_price = Some(value);
        } else if saw_quote_date {
            return (quote_price, Some(value));
        }
    }

    (quote_price, None)
}

fn parse_german_decimal(value: &str) -> Option<f64> {
    let normalized = value
        .trim()
        .trim_end_matches(" EUR")
        .trim_end_matches(" USD")
        .replace('.', "")
        .replace(',', ".");
    normalized.parse::<f64>().ok()
}

fn first_non_empty<const N: usize>(values: [&str; N]) -> String {
    values
        .into_iter()
        .find(|value| !value.is_empty())
        .unwrap_or_default()
        .to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{
        money::Money,
        transaction::{AssetClass, Symbol, Transaction},
    };

    #[test]
    fn calculates_average_cost_realized_and_unrealized_pnl() {
        let transactions = vec![
            TestTx::new("1", "BUY")
                .date("2026-01-01")
                .amount(-100.0)
                .shares(10.0)
                .price(10.0)
                .build(),
            TestTx::new("2", "SELL")
                .date("2026-02-01")
                .amount(75.0)
                .shares(5.0)
                .price(15.0)
                .build(),
        ];

        let output = calculate_portfolio(&transactions, CalculatorInput::default());

        assert_eq!(output.positions.len(), 1);
        assert_eq!(output.positions[0].quantity, 5.0);
        assert_eq!(output.positions[0].cost_basis, 50.0);
        assert_eq!(output.summary.realized_pnl, 25.0);
        assert_eq!(output.summary.unrealized_pnl, 25.0);
    }

    #[test]
    fn records_dividend_income_net_of_tax_like_legacy_generator() {
        let transactions = vec![
            TestTx::new("1", "DIVIDEND")
                .date("2026-03-01")
                .amount(10.0)
                .tax(-2.0)
                .build(),
        ];

        let output = calculate_portfolio(&transactions, CalculatorInput::default());

        assert_eq!(output.summary.income, 8.0);
        assert_eq!(output.dividend.summary.gross_amount, 10.0);
        assert_eq!(output.dividend.summary.tax, -2.0);
        assert_eq!(output.dividend.summary.net_amount, 8.0);
    }

    #[test]
    fn uses_live_price_override_before_transaction_price() {
        let transactions = vec![
            TestTx::new("1", "BUY")
                .amount(-100.0)
                .shares(10.0)
                .price(10.0)
                .build(),
        ];
        let mut price_overrides = HashMap::new();
        price_overrides.insert(
            "US0000000001".to_owned(),
            PriceOverride {
                price: 12.0,
                source: "boerse_frankfurt".to_owned(),
            },
        );

        let output = calculate_portfolio(
            &transactions,
            CalculatorInput {
                price_overrides,
                ..CalculatorInput::default()
            },
        );

        assert_eq!(output.positions[0].last_price, 12.0);
        assert_eq!(output.positions[0].market_value, 120.0);
        assert_eq!(output.summary.unrealized_pnl, 20.0);
    }

    #[test]
    fn uses_pdf_quote_price_as_fallback_price() {
        let transactions = vec![
            TestTx::new("1", "BUY")
                .symbol("US0000000001")
                .amount(-100.0)
                .shares(10.0)
                .price(10.0)
                .build(),
        ];
        let mut isin_names = HashMap::new();
        isin_names.insert(
            "US0000000001".to_owned(),
            PdfSecurityInfo {
                quantity: Some(8.0),
                market_value: Some(160.0),
                quote_price: Some(19.99),
                ..PdfSecurityInfo::default()
            },
        );

        let output = calculate_portfolio(
            &transactions,
            CalculatorInput {
                isin_names,
                ..CalculatorInput::default()
            },
        );

        assert_eq!(output.positions[0].last_price, 19.99);
        assert_eq!(output.positions[0].market_value, 199.89999999999998);
        assert_eq!(output.summary.unrealized_pnl, 99.89999999999998);
    }

    #[test]
    fn uses_pdf_market_value_for_bonds() {
        let transactions = vec![
            TestTx::new("1", "BUY")
                .symbol("US731011AV42")
                .asset_class("BOND")
                .amount(-2000.0)
                .shares(2000.0)
                .price(1.0)
                .build(),
        ];
        let mut isin_names = HashMap::new();
        isin_names.insert(
            "US731011AV42".to_owned(),
            PdfSecurityInfo {
                market_value: Some(1800.0),
                quote_price: Some(0.95),
                ..PdfSecurityInfo::default()
            },
        );

        let output = calculate_portfolio(
            &transactions,
            CalculatorInput {
                isin_names,
                ..CalculatorInput::default()
            },
        );

        assert_eq!(output.positions[0].last_price, 0.95);
        assert_eq!(output.positions[0].market_value, 1800.0);
        assert_eq!(output.summary.unrealized_pnl, -200.0);
    }

    #[test]
    fn parses_pdf_position_values_by_isin() -> anyhow::Result<()> {
        let map = parse_isin_name_map(
            r#"
10 Stk.
NVIDIA Corp.
Registered Shares DL-,001
ISIN: US67066G1040
183,94
26.05.2026
1.839,40
"#,
        );

        let info = map
            .get("US67066G1040")
            .ok_or_else(|| anyhow::anyhow!("PDF ISIN should parse"))?;
        assert_eq!(info.quantity, Some(10.0));
        assert_eq!(info.quote_price, Some(183.94));
        assert_eq!(info.market_value, Some(1839.40));
        Ok(())
    }

    struct TestTx {
        transaction: Transaction,
    }

    impl TestTx {
        fn new(id: &str, transaction_type: &str) -> Self {
            Self {
                transaction: Transaction {
                    transaction_id: id.to_owned(),
                    date: "2026-01-01".to_owned(),
                    transaction_type: transaction_type.to_owned(),
                    category: "TRADE".to_owned(),
                    asset_class: AssetClass("STOCK".to_owned()),
                    name: "Acme".to_owned(),
                    symbol: Symbol("US0000000001".to_owned()),
                    description: String::new(),
                    amount: Money(0.0),
                    fee: Money(0.0),
                    tax: Money(0.0),
                    shares: 0.0,
                    price: Money(0.0),
                    currency: "EUR".to_owned(),
                },
            }
        }

        fn date(mut self, date: &str) -> Self {
            self.transaction.date = date.to_owned();
            self
        }

        fn amount(mut self, amount: f64) -> Self {
            self.transaction.amount = Money(amount);
            self
        }

        fn tax(mut self, tax: f64) -> Self {
            self.transaction.tax = Money(tax);
            self
        }

        fn shares(mut self, shares: f64) -> Self {
            self.transaction.shares = shares;
            self
        }

        fn symbol(mut self, symbol: &str) -> Self {
            self.transaction.symbol = Symbol(symbol.to_owned());
            self
        }

        fn asset_class(mut self, asset_class: &str) -> Self {
            self.transaction.asset_class = AssetClass(asset_class.to_owned());
            self
        }

        fn price(mut self, price: f64) -> Self {
            self.transaction.price = Money(price);
            self
        }

        fn build(self) -> Transaction {
            self.transaction
        }
    }
}
