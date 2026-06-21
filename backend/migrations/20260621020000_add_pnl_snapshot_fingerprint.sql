ALTER TABLE pnl_snapshots
ADD COLUMN fingerprint TEXT;

UPDATE pnl_snapshots
SET fingerprint = id
WHERE fingerprint IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_pnl_snapshots_fingerprint
    ON pnl_snapshots (fingerprint);
