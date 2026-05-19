import csv
import json
import sqlite3

from tr_structured_products.agent_foundry import (
    AgentFoundryPortfolioAdapter,
    write_structured_products_outputs,
)


SUMMARY = {
    "generatedAt": "2026-05-18T12:00:00Z",
    "positions": [
        {
            "symbol": "DE000HS75VL7",
            "displayName": "Call 15.01.27 Intel 30 · HSBC Trinkaus & Burkhardt GmbH",
            "pdfName": "HSBC Trinkaus & Burkhardt GmbH · Call 15.01.27 Intel 30",
            "issuer": "Optionsschein auf INTEL CORP. DL-,001",
            "instrument": "Call 15.01.27 Intel 30",
            "assetClass": "DERIVATIVE",
            "quantity": 544,
            "costBasis": 2100.0,
            "lastPrice": 6.86,
            "marketValue": 3731.84,
            "lastTradeDate": "2026-05-15",
        },
        {
            "symbol": "DE000TTURBO1",
            "displayName": "Open End Turbo Long auf NVIDIA · Vontobel",
            "pdfName": "Vontobel · Open End Turbo Long auf NVIDIA",
            "issuer": "Vontobel",
            "instrument": "Open End Turbo Long auf NVIDIA",
            "assetClass": "DERIVATIVE",
            "quantity": 10,
            "costBasis": 50.0,
            "lastPrice": 7.0,
            "marketValue": 70.0,
        },
        {
            "symbol": "US5949181045",
            "displayName": "Microsoft Corp",
            "assetClass": "STOCK",
            "quantity": 2,
            "lastPrice": 500,
            "marketValue": 1000,
        },
    ],
}


def test_adapter_loads_structured_products_from_rust_portfolio_summary_only():
    rows = AgentFoundryPortfolioAdapter(SUMMARY).structured_product_rows()

    assert [row["isin"] for row in rows] == ["DE000HS75VL7", "DE000TTURBO1"]
    assert rows[0]["product_type"] == "optionsschein"
    assert rows[0]["quote_price"] == 6.86
    assert rows[0]["quote_source"] == "rust_portfolio_summary"
    assert rows[0]["avg_cost"] == 2100.0 / 544
    assert rows[1]["product_type"] == "open_end_turbo"


def test_adapter_reads_summary_json_file(tmp_path):
    path = tmp_path / "portfolio-summary.json"
    path.write_text(json.dumps(SUMMARY), encoding="utf-8")

    rows = AgentFoundryPortfolioAdapter.from_json_file(path).structured_product_rows()

    assert len(rows) == 2
    assert rows[0]["source_generated_at"] == "2026-05-18T12:00:00Z"


def test_write_structured_products_outputs_creates_csv_json_and_sqlite(tmp_path):
    csv_path = tmp_path / "structured-products.csv"
    json_path = tmp_path / "structured-products.json"
    db_path = tmp_path / "structured-products.sqlite3"

    rows = write_structured_products_outputs(
        SUMMARY,
        csv_path=csv_path,
        json_path=json_path,
        db_path=db_path,
    )

    assert len(rows) == 2
    with csv_path.open(newline="", encoding="utf-8") as handle:
        csv_rows = list(csv.DictReader(handle))
    assert csv_rows[0]["isin"] == "DE000HS75VL7"
    assert csv_rows[0]["product_type"] == "optionsschein"

    payload = json.loads(json_path.read_text(encoding="utf-8"))
    assert payload["source"] == "rust_portfolio_summary"
    assert payload["count"] == 2
    assert payload["items"][1]["isin"] == "DE000TTURBO1"

    with sqlite3.connect(db_path) as conn:
        position = conn.execute("SELECT quantity, avg_cost, source FROM positions WHERE isin = ?", ("DE000HS75VL7",)).fetchone()
        metadata = conn.execute("SELECT issuer, product_type FROM instrument_metadata WHERE isin = ?", ("DE000HS75VL7",)).fetchone()
        quote = conn.execute("SELECT price, currency FROM quotes WHERE isin = ?", ("DE000HS75VL7",)).fetchone()

    assert position == (544.0, 2100.0 / 544, "rust_portfolio_summary")
    assert metadata == ("Optionsschein auf INTEL CORP. DL-,001", "optionsschein")
    assert quote == (6.86, "EUR")
