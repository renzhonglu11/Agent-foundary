-- Research candidates are independent of transactions and portfolio valuation.
CREATE TABLE product_watchlist (
    isin TEXT PRIMARY KEY,
    added_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    product_json TEXT NOT NULL
);
