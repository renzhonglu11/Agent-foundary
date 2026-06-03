import sqlite3

from tr_structured_products.storage import initialize_schema


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
