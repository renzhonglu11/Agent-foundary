use std::sync::Arc;

use axum::{
    Router,
    extract::DefaultBodyLimit,
    routing::{get, post},
};
use tower_http::{cors::CorsLayer, trace::TraceLayer};

use crate::{api::handlers, app_state::AppState};

pub fn build(state: Arc<AppState>) -> Router {
    Router::new()
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
        .with_state(state)
        .layer(CorsLayer::permissive())
        .layer(TraceLayer::new_for_http())
}
