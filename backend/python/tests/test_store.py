import sqlite3

from agent_foundry_python.structured_products.models import Greek, InstrumentMetadata, Position, Quote
from agent_foundry_python.structured_products.storage import StructuredProductStore, initialize_schema


def test_store_upserts_positions_metadata_and_quotes(tmp_path):
    db_path = tmp_path / "structured_products.sqlite3"
    initialize_schema(db_path)
    store = StructuredProductStore(db_path)

    store.upsert_position(Position(isin="DE000HM0T297", quantity=12, avg_cost=3.9, source="trade_republic"))
    store.upsert_metadata(
        InstrumentMetadata(
            isin="DE000HM0T297",
            wkn="HM0T29",
            issuer="HSBC",
            underlying="Micron Technology",
            product_type="open_end_turbo",
            leverage=1.55,
            strike_price=256.757,
            knockout_price=256.757,
            break_even=270.0,
            ratio=0.01,
        )
    )
    store.insert_quote(Quote(isin="DE000HM0T297", price=4.24, currency="EUR"))
    store.insert_greek(Greek(isin="DE000HM0T297", delta=0.92, omega=1.6, theta=-0.01, iv=0.42))

    with sqlite3.connect(db_path) as conn:
        position = conn.execute("SELECT quantity, avg_cost, source FROM positions WHERE isin = ?", ("DE000HM0T297",)).fetchone()
        metadata = conn.execute("SELECT wkn, issuer, product_type, leverage, break_even FROM instrument_metadata WHERE isin = ?", ("DE000HM0T297",)).fetchone()
        quote = conn.execute("SELECT price, currency FROM quotes WHERE isin = ?", ("DE000HM0T297",)).fetchone()
        greek = conn.execute("SELECT delta, omega, theta, iv FROM greeks WHERE isin = ?", ("DE000HM0T297",)).fetchone()

    assert position == (12.0, 3.9, "trade_republic")
    assert metadata == ("HM0T29", "HSBC", "open_end_turbo", 1.55, 270.0)
    assert quote == (4.24, "EUR")
    assert greek == (0.92, 1.6, -0.01, 0.42)


def test_store_reads_metadata_and_greek(tmp_path):
    db_path = tmp_path / "structured_products.sqlite3"
    store = StructuredProductStore(db_path)

    # Initially None
    assert store.get_metadata("DE000HM0T297") is None
    assert store.get_latest_greek("DE000HM0T297") is None

    meta = InstrumentMetadata(
        isin="DE000HM0T297",
        wkn="HM0T29",
        issuer="HSBC",
        underlying="Micron Technology",
        product_type="open_end_turbo",
        leverage=1.55,
        strike_price=256.757,
        knockout_price=256.757,
        break_even=270.0,
        ratio=0.01,
    )
    store.upsert_metadata(meta)

    greek = Greek(isin="DE000HM0T297", delta=0.92, omega=1.6, theta=-0.01, iv=0.42)
    store.insert_greek(greek)

    read_meta = store.get_metadata("DE000HM0T297")
    assert read_meta is not None
    assert read_meta.wkn == "HM0T29"
    assert read_meta.leverage == 1.55
    assert read_meta.ratio == 0.01

    read_greek = store.get_latest_greek("DE000HM0T297")
    assert read_greek is not None
    assert read_greek.delta == 0.92
    assert read_greek.omega == 1.6
    assert read_greek.iv == 0.42

