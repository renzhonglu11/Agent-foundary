use axum::{Router, routing::get};
use tower_http::{cors::CorsLayer, trace::TraceLayer};

use crate::{api::handlers, services::portfolio_service::PortfolioService};

pub fn build(portfolio_service: PortfolioService) -> Router {
    Router::new()
        .route("/health", get(handlers::health))
        .route("/api/portfolio/summary", get(handlers::portfolio_summary))
        .route(
            "/data/portfolio-summary.json",
            get(handlers::portfolio_summary),
        )
        .with_state(portfolio_service)
        .layer(CorsLayer::permissive())
        .layer(TraceLayer::new_for_http())
}
