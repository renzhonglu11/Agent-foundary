CREATE TABLE IF NOT EXISTS upload_batches (
    batch_id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS uploaded_files (
    file_id TEXT PRIMARY KEY,
    batch_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    original_filename TEXT NOT NULL,
    stored_path TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    imported_rows INTEGER,
    extracted_text_path TEXT,
    extracted_text TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (batch_id) REFERENCES upload_batches(batch_id)
);

CREATE INDEX IF NOT EXISTS idx_uploaded_files_batch_id ON uploaded_files(batch_id);
CREATE INDEX IF NOT EXISTS idx_uploaded_files_kind_created_at ON uploaded_files(kind, created_at);
