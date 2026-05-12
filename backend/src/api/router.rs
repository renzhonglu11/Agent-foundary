use axum::{
    Router,
    extract::DefaultBodyLimit,
    routing::{get, post},
};
use tower_http::{cors::CorsLayer, trace::TraceLayer};

use crate::{api::handlers, services::portfolio_service::PortfolioService};

pub fn build(portfolio_service: PortfolioService) -> Router {
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
        .with_state(portfolio_service)
        .layer(CorsLayer::permissive())
        .layer(TraceLayer::new_for_http())
}
