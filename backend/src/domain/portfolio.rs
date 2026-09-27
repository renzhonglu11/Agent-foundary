use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortfolioSummaryResponse {
    pub generated_at: String,
    pub source: SourceInfo,
    pub summary: Summary,
    pub allocation: Vec<AllocationSlice>,
    pub positions: Vec<Position>,
    pub monthly: Vec<MonthlyActivity>,
    pub dividend: Dividend,
    pub recent_transactions: Vec<RecentTransaction>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceInfo {
    pub csv: String,
    pub pdf: String,
    pub pdf_text: Option<String>,
    pub isin_name_matches: usize,
    pub rows: usize,
    pub first_date: Option<String>,
    pub last_date: Option<String>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub total_market_value: f64,
    pub total_cost_basis: f64,
    pub unrealized_pnl: f64,
    pub unrealized_pct: f64,
    pub realized_pnl: f64,
    pub income: f64,
    pub fees: f64,
    pub taxes: f64,
    pub total_deposits: f64,
    pub total_withdrawals: f64,
    pub trading_cashflow: f64,
    pub open_positions: usize,
    pub winners: usize,
    pub losers: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct AllocationSlice {
    pub name: String,
    pub value: f64,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Position {
    pub valuation_source: String,
    pub price_as_of: Option<String>,
    pub price_fetched_at: Option<String>,
    pub valuation_currency: String,
    pub symbol: String,
    pub name: String,
    pub display_name: String,
    pub pdf_name: String,
    pub issuer: String,
    pub instrument: String,
    pub asset_class: String,
    pub quantity: f64,
    pub cost_basis: f64,
    pub realized_pnl: f64,
    pub income: f64,
    pub fees: f64,
    pub taxes: f64,
    pub last_price: f64,
    pub last_trade_date: String,
    pub buys: usize,
    pub sells: usize,
    pub market_value: f64,
    pub unrealized_pnl: f64,
    pub unrealized_pct: f64,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct MonthlyActivity {
    pub month: String,
    pub deposits: f64,
    pub withdrawals: f64,
    pub buys: f64,
    pub sells: f64,
    pub income: f64,
    pub fees: f64,
    pub taxes: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Dividend {
    pub summary: DividendSummary,
    pub monthly: Vec<DividendMonthly>,
    pub top_symbols: Vec<DividendBySymbol>,
    pub records: Vec<DividendRecord>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DividendSummary {
    pub records: usize,
    pub gross_amount: f64,
    pub tax: f64,
    pub net_amount: f64,
    pub symbols: usize,
    pub first_date: Option<String>,
    pub last_date: Option<String>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DividendMonthly {
    pub month: String,
    pub gross_amount: f64,
    pub tax: f64,
    pub net_amount: f64,
    pub count: usize,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DividendBySymbol {
    pub symbol: String,
    pub name: String,
    pub display_name: String,
    pub asset_class: String,
    pub gross_amount: f64,
    pub tax: f64,
    pub net_amount: f64,
    pub count: usize,
    pub last_date: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DividendRecord {
    pub id: String,
    pub date: String,
    pub month: String,
    pub year: String,
    #[serde(rename = "type")]
    pub transaction_type: String,
    pub asset_class: String,
    pub name: String,
    pub display_name: String,
    pub pdf_name: String,
    pub issuer: String,
    pub symbol: String,
    pub gross_amount: f64,
    pub tax: f64,
    pub net_amount: f64,
    pub currency: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentTransaction {
    pub date: String,
    #[serde(rename = "type")]
    pub transaction_type: String,
    pub category: String,
    pub asset_class: String,
    pub name: String,
    pub symbol: String,
    pub amount: f64,
    pub fee: f64,
    pub tax: f64,
    pub currency: String,
}
