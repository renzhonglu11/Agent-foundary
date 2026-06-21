CREATE TABLE IF NOT EXISTS pnl_snapshots (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    records_json TEXT NOT NULL,
    expiry_total REAL NOT NULL DEFAULT 0,
    drawdown_total REAL NOT NULL DEFAULT 0,
    record_count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_pnl_snapshots_created_at
    ON pnl_snapshots (created_at DESC);
