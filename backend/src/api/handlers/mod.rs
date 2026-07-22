mod fred;
mod health;
mod hermes_cron;
mod macro_analysis;
mod pnl_snapshots;
mod portfolio;
mod portfolio_stress;
mod stock_analysis;
mod structured_products;
mod systemd;
mod upload;

pub use fred::fred_macro_data;
pub use health::health;
pub use hermes_cron::hermes_cron_status;
pub use macro_analysis::{get_macro_analysis, refresh_macro_analysis};
pub use pnl_snapshots::{create_pnl_snapshot, delete_pnl_snapshot, list_pnl_snapshots};
pub use portfolio::portfolio_summary;
pub use portfolio_stress::{portfolio_stress_hermes_review, portfolio_stress_hermes_status};
pub use stock_analysis::stock_analysis_alpaca_quotes;
pub use structured_products::{
    persisted_structured_products_enrichment, persisted_structured_products_risk,
    refresh_structured_products_enrichment, structured_products_enrichment_status,
};
pub use systemd::systemd_units;
pub use upload::upload_data;
