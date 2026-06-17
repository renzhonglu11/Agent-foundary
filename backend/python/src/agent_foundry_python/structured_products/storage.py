from __future__ import annotations

import sqlite3
from pathlib import Path

from yoyo import get_backend, read_migrations

from agent_foundry_python.structured_products.models import Greek, InstrumentMetadata, Position, Quote

MIGRATIONS_DIR = Path(__file__).resolve().parents[3] / "migrations"


def initialize_schema(db_path: str | Path) -> None:
    """Apply structured-products SQLite migrations."""
    path = Path(db_path)
    if path.parent != Path(""):
        path.parent.mkdir(parents=True, exist_ok=True)
    backend = get_backend(_sqlite_url(path))
    migrations = read_migrations(str(MIGRATIONS_DIR))
    with backend.lock():
        backend.apply_migrations(backend.to_apply(migrations))


def _sqlite_url(path: Path) -> str:
    absolute_path = path if path.is_absolute() else path.absolute()
    return f"sqlite:///{absolute_path.as_posix()}"


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
                    strike_price, knockout_price, break_even, ratio, expiry,
                    option_type, reset_barrier, last_updated
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
                    option_type = excluded.option_type,
                    reset_barrier = excluded.reset_barrier,
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
                    metadata.option_type,
                    metadata.reset_barrier,
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

    def get_metadata(self, isin: str) -> InstrumentMetadata | None:
        from datetime import datetime, timezone
        with sqlite3.connect(self.db_path) as conn:
            conn.row_factory = sqlite3.Row
            cursor = conn.execute(
                "SELECT * FROM instrument_metadata WHERE isin = ?", (isin,)
            )
            row = cursor.fetchone()
            if row is None:
                return None
            
            last_updated_str = row["last_updated"]
            if last_updated_str:
                last_updated = datetime.fromisoformat(last_updated_str)
            else:
                last_updated = datetime.now(timezone.utc)
                
            return InstrumentMetadata(
                isin=row["isin"],
                wkn=row["wkn"],
                issuer=row["issuer"],
                underlying=row["underlying"],
                product_type=row["product_type"],
                leverage=row["leverage"],
                strike_price=row["strike_price"],
                knockout_price=row["knockout_price"],
                break_even=row["break_even"],
                ratio=row["ratio"],
                expiry=row["expiry"],
                option_type=row["option_type"],
                reset_barrier=row["reset_barrier"],
                last_updated=last_updated,
            )

    def get_latest_greek(self, isin: str) -> Greek | None:
        from datetime import datetime, timezone
        with sqlite3.connect(self.db_path) as conn:
            conn.row_factory = sqlite3.Row
            cursor = conn.execute(
                "SELECT * FROM greeks WHERE isin = ? ORDER BY timestamp DESC LIMIT 1",
                (isin,),
            )
            row = cursor.fetchone()
            if row is None:
                return None
                
            timestamp_str = row["timestamp"]
            if timestamp_str:
                timestamp = datetime.fromisoformat(timestamp_str)
            else:
                timestamp = datetime.now(timezone.utc)
                
            return Greek(
                isin=row["isin"],
                timestamp=timestamp,
                delta=row["delta"],
                omega=row["omega"],
                theta=row["theta"],
                iv=row["iv"],
            )
