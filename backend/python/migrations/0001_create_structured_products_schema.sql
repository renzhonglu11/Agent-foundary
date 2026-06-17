CREATE TABLE IF NOT EXISTS positions (
    isin TEXT PRIMARY KEY,
    quantity REAL,
    avg_cost REAL,
    source TEXT
);

CREATE TABLE IF NOT EXISTS instrument_metadata (
    isin TEXT PRIMARY KEY,
    wkn TEXT,
    issuer TEXT,
    underlying TEXT,
    product_type TEXT,
    leverage REAL,
    strike_price REAL,
    knockout_price REAL,
    break_even REAL,
    ratio REAL,
    expiry TEXT,
    option_type TEXT,
    reset_barrier REAL,
    last_updated TIMESTAMP
);

CREATE TABLE IF NOT EXISTS quotes (
    isin TEXT,
    timestamp TIMESTAMP,
    price REAL,
    currency TEXT
);

CREATE INDEX IF NOT EXISTS idx_quotes_isin_timestamp
    ON quotes (isin, timestamp DESC);

CREATE TABLE IF NOT EXISTS greeks (
    isin TEXT,
    timestamp TIMESTAMP,
    delta REAL,
    omega REAL,
    theta REAL,
    iv REAL
);

CREATE INDEX IF NOT EXISTS idx_greeks_isin_timestamp
    ON greeks (isin, timestamp DESC);
