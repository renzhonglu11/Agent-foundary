//! Loopback-only fixtures: resilience tests never contact a market-data vendor.
use axum::{
    Router,
    body::Body,
    http::{Request, Response},
    routing::any,
};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicU16, AtomicUsize, Ordering},
};

pub struct MockHttp {
    pub url: String,
    pub calls: Arc<AtomicUsize>,
    pub status: Arc<AtomicU16>,
    pub body: Arc<Mutex<String>>,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for MockHttp {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl MockHttp {
    pub async fn start(status: u16, body: &str, retry_after: Option<&str>) -> anyhow::Result<Self> {
        let calls = Arc::new(AtomicUsize::new(0));
        let status = Arc::new(AtomicU16::new(status));
        let body = Arc::new(Mutex::new(body.to_owned()));
        let retry = retry_after.map(str::to_owned);
        let app = Router::new().fallback(any({
            let (calls, status, body) = (calls.clone(), status.clone(), body.clone());
            move |request: Request<Body>| {
                let (calls, status, body, retry) =
                    (calls.clone(), status.clone(), body.clone(), retry.clone());
                async move {
                    calls.fetch_add(1, Ordering::SeqCst);
                    if request.uri().path() == "/slow" {
                        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                    }
                    let mut response = Response::new(Body::from(
                        body.lock().map(|b| b.clone()).unwrap_or_default(),
                    ));
                    *response.status_mut() =
                        axum::http::StatusCode::from_u16(status.load(Ordering::SeqCst))
                            .unwrap_or(axum::http::StatusCode::INTERNAL_SERVER_ERROR);
                    response.headers_mut().insert(
                        "content-type",
                        axum::http::HeaderValue::from_static("application/json"),
                    );
                    response.headers_mut().insert(
                        "location",
                        axum::http::HeaderValue::from_static("/redirect-target"),
                    );
                    if let Some(retry) = retry.and_then(|r| r.parse().ok()) {
                        response.headers_mut().insert("retry-after", retry);
                    }
                    response
                }
            }
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let url = format!("http://{}", listener.local_addr()?);
        let task = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        Ok(Self {
            url,
            calls,
            status,
            body,
            task,
        })
    }

    pub fn hits(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }
}

pub async fn database() -> anyhow::Result<sqlx::SqlitePool> {
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await?;
    crate::infrastructure::db::migrations::run_migrations(&pool).await?;
    Ok(pool)
}
