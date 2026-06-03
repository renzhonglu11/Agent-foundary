from __future__ import annotations

import sqlite3
from pathlib import Path

from tr_structured_products.models import Greek, InstrumentMetadata, Position, Quote

SCHEMA_SQL = """
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
"""


def initialize_schema(db_path: str | Path) -> None:
    """Create the Phase 1 structured-products SQLite schema."""
    path = Path(db_path)
    if path.parent != Path(""):
        path.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(path) as conn:
        conn.executescript(SCHEMA_SQL)


class StructuredProductStore:
    """Small SQLite repository for normalized structured-product data."""

    def __init__(self, db_path: str | Path) -> None:
        self.db_path = Path(db_path)
        initialize_schema(self.db_path)

    def upsert_position(self, position: Position) -> None:
        with sqlite3.connect(self.db_path) as conn:
            conn.execute(
                """
                INSERT INTO positions (isin, quantity, avg_cost, source)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(isin) DO UPDATE SET
                    quantity = excluded.quantity,
                    avg_cost = excluded.avg_cost,
                    source = excluded.source
                """,
                (position.isin, position.quantity, position.avg_cost, position.source),
            )

    def upsert_metadata(self, metadata: InstrumentMetadata) -> None:
        with sqlite3.connect(self.db_path) as conn:
            conn.execute(
                """
                INSERT INTO instrument_metadata (
                    isin, wkn, issuer, underlying, product_type, leverage,
                    strike_price, knockout_price, break_even, ratio, expiry, last_updated
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(isin) DO UPDATE SET
                    wkn = excluded.wkn,
                    issuer = excluded.issuer,
                    underlying = excluded.underlying,
                    product_type = excluded.product_type,
                    leverage = excluded.leverage,
                    strike_price = excluded.strike_price,
                    knockout_price = excluded.knockout_price,
                    break_even = excluded.break_even,
                    ratio = excluded.ratio,
                    expiry = excluded.expiry,
                    last_updated = excluded.last_updated
                """,
                (
                    metadata.isin,
                    metadata.wkn,
                    metadata.issuer,
                    metadata.underlying,
                    metadata.product_type,
                    metadata.leverage,
                    metadata.strike_price,
                    metadata.knockout_price,
                    metadata.break_even,
                    metadata.ratio,
                    metadata.expiry,
                    metadata.last_updated.isoformat(),
                ),
            )

    def insert_quote(self, quote: Quote) -> None:
        with sqlite3.connect(self.db_path) as conn:
            conn.execute(
                """
                INSERT INTO quotes (isin, timestamp, price, currency)
                VALUES (?, ?, ?, ?)
                """,
                (quote.isin, quote.timestamp.isoformat(), quote.price, quote.currency),
            )

    def insert_greek(self, greek: Greek) -> None:
        with sqlite3.connect(self.db_path) as conn:
            conn.execute(
                """
                INSERT INTO greeks (isin, timestamp, delta, omega, theta, iv)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (greek.isin, greek.timestamp.isoformat(), greek.delta, greek.omega, greek.theta, greek.iv),
            )
