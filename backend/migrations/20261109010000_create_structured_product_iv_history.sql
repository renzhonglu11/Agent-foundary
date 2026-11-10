-- One implied-volatility observation per product and UTC day; the last refresh
-- of the day wins. Greeks served from a stale cache are not recorded, so a
-- repeated old value cannot pass for a new observation.
CREATE TABLE IF NOT EXISTS structured_product_iv_history (
    isin TEXT NOT NULL,
    observed_on TEXT NOT NULL,
    iv REAL NOT NULL,
    quote_price REAL,
    underlying TEXT,
    greeks_source TEXT,
    observed_at TEXT NOT NULL,
    PRIMARY KEY (isin, observed_on)
);
