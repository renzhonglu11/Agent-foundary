CREATE TABLE IF NOT EXISTS pnl_snapshot_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    snapshot_id TEXT NOT NULL,
    record_id TEXT NOT NULL,
    record_type TEXT NOT NULL,
    product_name TEXT NOT NULL,
    pnl REAL NOT NULL,
    underlying_move_pct REAL,
    recorded_at INTEGER,
    position INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (snapshot_id) REFERENCES pnl_snapshots(id) ON DELETE CASCADE
);

INSERT INTO pnl_snapshot_records (
    snapshot_id,
    record_id,
    record_type,
    product_name,
    pnl,
    underlying_move_pct,
    recorded_at,
    position
)
SELECT
    snapshots.id,
    COALESCE(json_extract(records.value, '$.id'), ''),
    COALESCE(json_extract(records.value, '$.type'), ''),
    COALESCE(json_extract(records.value, '$.productName'), ''),
    COALESCE(json_extract(records.value, '$.pnl'), 0),
    json_extract(records.value, '$.underlyingMovePct'),
    json_extract(records.value, '$.recordedAt'),
    CAST(records.key AS INTEGER)
FROM pnl_snapshots AS snapshots,
     json_each(snapshots.records_json) AS records
WHERE EXISTS (
    SELECT 1
    FROM pragma_table_info('pnl_snapshots')
    WHERE name = 'records_json'
);

PRAGMA foreign_keys = OFF;

CREATE TABLE pnl_snapshots_normalized (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    expiry_total REAL NOT NULL DEFAULT 0,
    drawdown_total REAL NOT NULL DEFAULT 0,
    record_count INTEGER NOT NULL DEFAULT 0,
    fingerprint TEXT
);

INSERT INTO pnl_snapshots_normalized (
    id,
    created_at,
    expiry_total,
    drawdown_total,
    record_count,
    fingerprint
)
SELECT
    id,
    created_at,
    expiry_total,
    drawdown_total,
    record_count,
    fingerprint
FROM pnl_snapshots;

DROP TABLE pnl_snapshots;

ALTER TABLE pnl_snapshots_normalized RENAME TO pnl_snapshots;

PRAGMA foreign_keys = ON;

CREATE INDEX IF NOT EXISTS idx_pnl_snapshots_created_at
    ON pnl_snapshots (created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_pnl_snapshots_fingerprint
    ON pnl_snapshots (fingerprint);

CREATE INDEX IF NOT EXISTS idx_pnl_snapshot_records_snapshot_id
    ON pnl_snapshot_records (snapshot_id, position);

CREATE INDEX IF NOT EXISTS idx_pnl_snapshot_records_type
    ON pnl_snapshot_records (record_type);

CREATE INDEX IF NOT EXISTS idx_pnl_snapshot_records_product_name
    ON pnl_snapshot_records (product_name);
