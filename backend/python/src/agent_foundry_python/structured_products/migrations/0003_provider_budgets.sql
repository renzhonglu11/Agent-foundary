-- Rolling windows shared by every Rust/Python caller. Reservations count even
-- if a process dies before sending; cache hits and refused reservations do not.
CREATE TABLE IF NOT EXISTS provider_request_events (
    id INTEGER PRIMARY KEY,
    source TEXT NOT NULL,
    requested_at REAL NOT NULL,
    priority TEXT NOT NULL CHECK (priority IN ('tier1', 'background'))
);
CREATE INDEX IF NOT EXISTS provider_requests_source_time
    ON provider_request_events(source, requested_at);
CREATE INDEX IF NOT EXISTS provider_requests_time
    ON provider_request_events(requested_at);

CREATE TABLE IF NOT EXISTS product_refresh_schedule (
    isin TEXT PRIMARY KEY,
    last_attempt_at REAL NOT NULL DEFAULT 0,
    quote_json TEXT
);
