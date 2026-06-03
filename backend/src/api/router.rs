use std::sync::Arc;

use anyhow::Context;
use axum::{
    Router,
    extract::DefaultBodyLimit,
    http::{HeaderValue, Method, header},
    routing::{get, post},
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
        .allow_methods([Method::GET, Method::POST])
        .allow_headers([header::CONTENT_TYPE, header::AUTHORIZATION]);

    Ok(Router::new()
        .route("/health", get(handlers::health))
        .route("/api/portfolio/summary", get(handlers::portfolio_summary))
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
            "/data/structured-products-enrichment.json",
            get(handlers::structured_products_enrichment),
        )
        .route(
            "/api/structured-products-enrichment/refresh",
            post(handlers::refresh_structured_products_enrichment),
        )
        .route(
            "/api/structured-products-enrichment/status",
            get(handlers::structured_products_enrichment_status),
        )
        .route(
            "/api/stock-analysis/alpaca-quotes",
            get(handlers::stock_analysis_alpaca_quotes),
        )
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
