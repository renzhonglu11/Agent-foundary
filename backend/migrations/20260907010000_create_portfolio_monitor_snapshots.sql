-- latest plus the last observation in each UTC hour. These are valuation/data-quality
-- snapshots, not cash-flow-adjusted performance or investment advice.
CREATE TABLE portfolio_monitor_snapshots (
    snapshot_key TEXT PRIMARY KEY,
    captured_at TEXT NOT NULL,
    payload_json TEXT NOT NULL
);
