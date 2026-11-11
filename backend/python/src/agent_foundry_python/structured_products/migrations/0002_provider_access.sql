-- Shared by the Python enrichment worker and Rust candidate search.
CREATE TABLE IF NOT EXISTS provider_access (
    source TEXT PRIMARY KEY,
    next_request_at REAL NOT NULL DEFAULT 0,
    blocked_until REAL NOT NULL DEFAULT 0,
    failures INTEGER NOT NULL DEFAULT 0,
    last_status INTEGER,
    updated_at REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS provider_missing_products (
    source TEXT NOT NULL,
    resource TEXT NOT NULL,
    retry_at REAL NOT NULL,
    PRIMARY KEY (source, resource)
);
