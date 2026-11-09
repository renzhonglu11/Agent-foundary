mod fred;
mod health;
mod hermes_cron;
mod macro_analysis;
mod pnl_snapshots;
mod portfolio;
mod portfolio_monitor;
mod portfolio_stress;
mod product_candidates;
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
pub use portfolio_monitor::{
    portfolio_monitor_history, portfolio_monitor_snapshot, portfolio_monitor_status,
};
pub use portfolio_stress::{portfolio_stress_hermes_review, portfolio_stress_hermes_status};
pub use product_candidates::{
    product_watchlist, remove_product_watchlist, save_product_watchlist, search_product_candidates,
};
pub use stock_analysis::{stock_analysis_alpaca_daily_stats, stock_analysis_alpaca_quotes};
pub use structured_products::{
    persisted_structured_products_enrichment, persisted_structured_products_risk,
    refresh_structured_products_enrichment, structured_products_enrichment_status,
    structured_products_iv_history,
};
pub use systemd::systemd_units;
pub use upload::upload_data;
