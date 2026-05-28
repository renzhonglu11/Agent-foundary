CREATE TABLE IF NOT EXISTS market_data_quotes (
    provider TEXT NOT NULL,
    feed TEXT NOT NULL,
    symbol TEXT NOT NULL,
    price REAL NOT NULL,
    currency TEXT NOT NULL,
    bid_price REAL NOT NULL,
    ask_price REAL NOT NULL,
    raw_price REAL NOT NULL,
    raw_bid_price REAL NOT NULL,
    raw_ask_price REAL NOT NULL,
    raw_currency TEXT NOT NULL,
    usd_eur_rate REAL NOT NULL,
    fx_rate_source TEXT NOT NULL,
    bid_size INTEGER NOT NULL,
    ask_size INTEGER NOT NULL,
    price_source TEXT NOT NULL,
    price_as_of TEXT NOT NULL,
    fetched_at TEXT NOT NULL,
    PRIMARY KEY (provider, feed, symbol)
);

CREATE TABLE IF NOT EXISTS realtime_payloads (
    key TEXT PRIMARY KEY,
    payload_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
