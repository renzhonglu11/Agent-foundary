import sqlite3
from pathlib import Path

import pytest
from yoyo import read_migrations

import agent_foundry_python
from agent_foundry_python.structured_products import storage
from agent_foundry_python.structured_products.storage import MIGRATIONS_DIR, initialize_schema


def test_initialize_schema_creates_required_tables(tmp_path):
    db_path = tmp_path / "structured_products.sqlite3"

    initialize_schema(db_path)

    with sqlite3.connect(db_path) as conn:
        tables = {
            row[0]
            for row in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")
        }
        assert {"positions", "instrument_metadata", "quotes", "greeks"}.issubset(tables)

        quote_columns = {
            row[1]
            for row in conn.execute("PRAGMA table_info(quotes)")
        }
        assert {"isin", "timestamp", "price", "currency"}.issubset(quote_columns)


def test_initialize_schema_migrates_existing_instrument_metadata_table(tmp_path):
    db_path = tmp_path / "structured_products.sqlite3"
    with sqlite3.connect(db_path) as conn:
        conn.execute(
            """
            CREATE TABLE instrument_metadata (
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
            )
            """
        )
        conn.execute(
            """
            INSERT INTO instrument_metadata (
                isin, wkn, issuer, underlying, product_type, leverage,
                strike_price, knockout_price, break_even, ratio, expiry, last_updated
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "DE000OLD001",
                "OLD001",
                "Issuer",
                "Underlying",
                "optionsschein",
                2.0,
                100.0,
                None,
                120.0,
                0.1,
                "2026-12-18",
                "2026-06-12T00:00:00+00:00",
            ),
        )

    initialize_schema(db_path)

    with sqlite3.connect(db_path) as conn:
        columns = {
            row[1]
            for row in conn.execute("PRAGMA table_info(instrument_metadata)")
        }
        row = conn.execute(
            "SELECT option_type, reset_barrier FROM instrument_metadata WHERE isin = ?",
            ("DE000OLD001",),
        ).fetchone()

    assert {"option_type", "reset_barrier"}.issubset(columns)
    assert row == (None, None)


def test_migrations_ship_inside_the_package():
    # A path outside the package is absent from the wheel; yoyo would then apply nothing.
    package_dir = Path(agent_foundry_python.__file__).resolve().parent
    assert MIGRATIONS_DIR.is_relative_to(package_dir)
    assert len(read_migrations(str(MIGRATIONS_DIR))) >= 2


def test_initialize_schema_fails_without_migrations(tmp_path, monkeypatch):
    monkeypatch.setattr(storage, "MIGRATIONS_DIR", tmp_path / "missing")

    with pytest.raises(RuntimeError, match="No structured-products migrations"):
        initialize_schema(tmp_path / "structured_products.sqlite3")
