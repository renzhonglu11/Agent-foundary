CREATE TABLE IF NOT EXISTS fred_macro_data_cache (
    cache_key TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    fetched_at TEXT NOT NULL
);
