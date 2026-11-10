-- Step 5 follows the product-watchlist migration; no existing tables change.
CREATE TABLE IF NOT EXISTS portfolio_monitor_settings (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    revision INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    settings_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS portfolio_monitor_alerts (
    alert_key TEXT PRIMARY KEY,
    updated_at TEXT NOT NULL,
    state_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS portfolio_monitor_alert_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    alert_key TEXT NOT NULL,
    happened_at TEXT NOT NULL,
    snapshot_key TEXT,
    event_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_monitor_alert_events_key ON portfolio_monitor_alert_events(alert_key, id);

CREATE TABLE IF NOT EXISTS portfolio_monitor_calibrations (
    origin_key TEXT NOT NULL,
    target_key TEXT NOT NULL,
    calculated_at TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    PRIMARY KEY (origin_key, target_key)
);
