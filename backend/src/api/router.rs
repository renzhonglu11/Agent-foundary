use std::sync::Arc;

use anyhow::Context;
use axum::{
    Router,
    extract::DefaultBodyLimit,
    http::{HeaderValue, Method, header},
    routing::{delete, get, post},
};
use tower_http::{cors::CorsLayer, trace::TraceLayer};

use crate::{api::handlers, app_state::AppState};

pub fn build(state: Arc<AppState>, frontend_origin: &str) -> anyhow::Result<Router> {
    let cors = CorsLayer::new()
        .allow_origin(
            frontend_origin
                .parse::<HeaderValue>()
                .context("FRONTEND_ORIGIN must be a valid HTTP header value")?,
        )
        .allow_methods([Method::GET, Method::POST, Method::DELETE])
        .allow_headers([header::CONTENT_TYPE, header::AUTHORIZATION]);

    Ok(Router::new()
        .route("/health", get(handlers::health))
        .route("/api/portfolio/summary", get(handlers::portfolio_summary))
        .route(
            "/api/portfolio-monitor/status",
            get(handlers::portfolio_monitor_status),
        )
        .route(
            "/api/portfolio-monitor/history",
            get(handlers::portfolio_monitor_history),
        )
        .route(
            "/api/portfolio-monitor/snapshots/{key}",
            get(handlers::portfolio_monitor_snapshot),
        )
        .route(
            "/api/upload-data",
            post(handlers::upload_data).layer(DefaultBodyLimit::max(50 * 1024 * 1024)),
        )
        .route(
            "/data/portfolio-summary.json",
            get(handlers::portfolio_summary),
        )
        .route(
            "/data/hermes-cron-status.json",
            get(handlers::hermes_cron_status),
        )
        .route(
            "/api/structured-products-enrichment/refresh",
            post(handlers::refresh_structured_products_enrichment),
        )
        .route(
            "/api/structured-products-enrichment",
            get(handlers::persisted_structured_products_enrichment),
        )
        .route(
            "/api/structured-products-risk",
            get(handlers::persisted_structured_products_risk),
        )
        .route(
            "/api/structured-products-enrichment/status",
            get(handlers::structured_products_enrichment_status),
        )
        .route(
            "/api/stock-analysis/alpaca-quotes",
            get(handlers::stock_analysis_alpaca_quotes),
        )
        .route(
            "/api/pnl-snapshots",
            get(handlers::list_pnl_snapshots).post(handlers::create_pnl_snapshot),
        )
        .route(
            "/api/pnl-snapshots/{id}",
            delete(handlers::delete_pnl_snapshot),
        )
        .route(
            "/api/portfolio-stress/hermes-review",
            get(handlers::portfolio_stress_hermes_status)
                .post(handlers::portfolio_stress_hermes_review),
        )
        .route("/api/systemd/units", get(handlers::systemd_units))
        .route("/api/fred/macro-data", get(handlers::fred_macro_data))
        .route(
            "/data/macro-analysis.json",
            get(handlers::get_macro_analysis),
        )
        .route(
            "/api/macro-analysis/refresh",
            post(handlers::refresh_macro_analysis),
        )
        .with_state(state)
        .layer(cors)
        .layer(TraceLayer::new_for_http()))
}
