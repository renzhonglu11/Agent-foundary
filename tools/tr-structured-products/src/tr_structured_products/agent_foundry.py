from __future__ import annotations

import csv
import json
from pathlib import Path
from typing import Any

from tr_structured_products.models import Greek, InstrumentMetadata, Position, Quote
from tr_structured_products.storage import StructuredProductStore

STRUCTURED_PRODUCT_KEYWORDS = (
    "optionsschein",
    "knock-out",
    "knock out",
    "open end turbo",
    "open-end turbo",
    "turbo",
    "faktor zertifikat",
    "faktor-zertifikat",
    "factor certificate",
)

CSV_FIELDS = [
    "isin",
    "display_name",
    "issuer",
    "instrument",
    "underlying",
    "asset_class",
    "product_type",
    "wkn",
    "quantity",
    "avg_cost",
    "cost_basis",
    "quote_price",
    "quote_currency",
    "quote_source",
    "quote_day_high",
    "quote_day_low",
    "quote_timestamp",
    "market_value",
    "leverage",
    "delta",
    "omega",
    "theta",
    "iv",
    "strike_price",
    "knockout_price",
    "ratio",
    "expiry",
    "metadata_source",
    "greeks_source",
    "metadata_url",
    "enrichment_tier",
    "live_enrichment_enabled",
    "last_trade_date",
    "source_generated_at",
]


class AgentFoundryPortfolioAdapter:
    """Adapter from Rust Agent-Foundry portfolio summary into enrichment rows.

    The Rust backend remains the ingestion source of truth for CSV/PDF parsing.
    This adapter only consumes the already-normalized `PortfolioSummaryResponse`
    shape and extracts structured-product positions for enrichment/output.
    """

    def __init__(self, summary: dict[str, Any]) -> None:
        self.summary = summary

    @classmethod
    def from_json_file(cls, path: str | Path) -> "AgentFoundryPortfolioAdapter":
        with Path(path).open(encoding="utf-8") as handle:
            return cls(json.load(handle))

    def structured_product_rows(self) -> list[dict[str, Any]]:
        generated_at = self.summary.get("generatedAt") or self.summary.get("generated_at")
        positions = self.summary.get("positions") if isinstance(self.summary, dict) else []
        if not isinstance(positions, list):
            return []

        rows: list[dict[str, Any]] = []
        for item in positions:
            if not isinstance(item, dict) or not _is_structured_product_position(item):
                continue
            rows.append(_position_to_row(item, generated_at=generated_at))
        return rows


def assign_enrichment_tiers(rows: list[dict[str, Any]], *, tier1_limit: int = 20) -> list[dict[str, Any]]:
    """Assign enrichment tiers and live-update eligibility.

    Tier policy:
    - tier1: first N live-eligible structured products; real-time quote/Greeks refresh.
    - tier2: remaining structured products; Rust summary/fallback data only by default.
    - tier3: ETF, bond, equity, cash, or any non-derivative/non-live-eligible row.
    """
    tiered_rows: list[dict[str, Any]] = []
    tier1_count = 0
    for row in rows:
        tiered = dict(row)
        if _is_live_enrichment_candidate(tiered) and tier1_count < tier1_limit:
            tiered["enrichment_tier"] = "tier1"
            tiered["live_enrichment_enabled"] = True
            tier1_count += 1
        elif _is_structured_product_row(tiered):
            tiered["enrichment_tier"] = "tier2"
            tiered["live_enrichment_enabled"] = False
        else:
            tiered["enrichment_tier"] = "tier3"
            tiered["live_enrichment_enabled"] = False
        tiered_rows.append(tiered)
    return tiered_rows


def _is_live_enrichment_candidate(row: dict[str, Any]) -> bool:
    return _is_structured_product_row(row) and str(row.get("product_type") or "").casefold() in {
        "optionsschein",
        "open_end_turbo",
        "knock_out",
        "factor_certificate",
    }


def _is_structured_product_row(row: dict[str, Any]) -> bool:
    asset_class = str(row.get("asset_class") or row.get("assetClass") or "").casefold()
    product_type = str(row.get("product_type") or "").casefold()
    return asset_class == "derivative" and product_type in {
        "optionsschein",
        "open_end_turbo",
        "knock_out",
        "factor_certificate",
    }


def write_structured_products_outputs(
    summary: dict[str, Any],
    *,
    csv_path: str | Path,
    json_path: str | Path,
    db_path: str | Path,
) -> list[dict[str, Any]]:
    """Write structured-product enrichment outputs from Rust summary data.

    Outputs are deliberately generated from Rust portfolio summary only; no CSV/PDF
    parsing is repeated in Python.
    """
    rows = AgentFoundryPortfolioAdapter(summary).structured_product_rows()
    write_structured_product_rows_outputs(rows, csv_path=csv_path, json_path=json_path, db_path=db_path)
    return rows


def write_structured_product_rows_outputs(
    rows: list[dict[str, Any]],
    *,
    csv_path: str | Path,
    json_path: str | Path,
    db_path: str | Path,
) -> None:
    _write_csv(rows, csv_path)
    _write_json(rows, json_path)
    _write_sqlite(rows, db_path)


def _is_structured_product_position(position: dict[str, Any]) -> bool:
    asset_class = str(position.get("assetClass") or position.get("asset_class") or "").casefold()
    haystack = " ".join(
        str(position.get(key) or "")
        for key in ("displayName", "display_name", "pdfName", "pdf_name", "issuer", "instrument", "name")
    ).casefold()
    return asset_class == "derivative" and any(keyword in haystack for keyword in STRUCTURED_PRODUCT_KEYWORDS)


def _position_to_row(position: dict[str, Any], *, generated_at: str | None) -> dict[str, Any]:
    quantity = _float_or_zero(position.get("quantity"))
    cost_basis = _float_or_zero(position.get("costBasis", position.get("cost_basis")))
    avg_cost = cost_basis / quantity if quantity else None
    quote_price = _float_or_zero(position.get("lastPrice", position.get("last_price")))
    market_value = _float_or_zero(position.get("marketValue", position.get("market_value")))
    display_name = _first_non_empty(
        position.get("displayName"),
        position.get("display_name"),
        position.get("name"),
        position.get("pdfName"),
        position.get("pdf_name"),
        position.get("symbol"),
    )

    return {
        "isin": str(position.get("symbol") or ""),
        "display_name": display_name,
        "issuer": _first_non_empty(position.get("issuer")),
        "instrument": _first_non_empty(position.get("instrument")),
        "underlying": "",
        "asset_class": _first_non_empty(position.get("assetClass"), position.get("asset_class")),
        "product_type": _detect_product_type(position),
        "wkn": "",
        "quantity": quantity,
        "avg_cost": avg_cost,
        "cost_basis": cost_basis,
        "quote_price": quote_price,
        "quote_currency": str(position.get("currency") or "EUR"),
        "quote_source": "rust_portfolio_summary",
        "quote_day_high": None,
        "quote_day_low": None,
        "quote_timestamp": None,
        "market_value": market_value,
        "leverage": None,
        "delta": None,
        "omega": None,
        "theta": None,
        "iv": None,
        "strike_price": None,
        "knockout_price": None,
        "ratio": None,
        "expiry": None,
        "metadata_source": None,
        "greeks_source": None,
        "metadata_url": None,
        "enrichment_tier": None,
        "live_enrichment_enabled": False,
        "last_trade_date": _first_non_empty(position.get("lastTradeDate"), position.get("last_trade_date")),
        "source_generated_at": generated_at,
    }


def _detect_product_type(position: dict[str, Any]) -> str | None:
    text = " ".join(str(position.get(key) or "") for key in ("displayName", "pdfName", "issuer", "instrument", "name")).casefold()
    if "optionsschein" in text or "call " in text or "put " in text:
        return "optionsschein"
    if "faktor zertifikat" in text or "faktor-zertifikat" in text or "factor certificate" in text:
        return "factor_certificate"
    if "knock-out" in text or "knock out" in text:
        return "knock_out"
    if "open end turbo" in text or "open-end turbo" in text or "turbo" in text:
        return "open_end_turbo"
    return None


def _write_csv(rows: list[dict[str, Any]], path: str | Path) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=CSV_FIELDS)
        writer.writeheader()
        for row in rows:
            writer.writerow({field: row.get(field) for field in CSV_FIELDS})


def _write_json(rows: list[dict[str, Any]], path: str | Path) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "source": "rust_portfolio_summary",
        "count": len(rows),
        "items": rows,
    }
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def _write_sqlite(rows: list[dict[str, Any]], path: str | Path) -> None:
    path = Path(path)
    if path.exists():
        path.unlink()
    store = StructuredProductStore(path)
    for row in rows:
        store.upsert_position(
            Position(
                isin=row["isin"],
                quantity=row["quantity"],
                avg_cost=row["avg_cost"],
                source="rust_portfolio_summary",
            )
        )
        store.upsert_metadata(
            InstrumentMetadata(
                isin=row["isin"],
                wkn=row.get("wkn") or None,
                issuer=row.get("issuer") or None,
                underlying=row.get("underlying") or row.get("instrument") or row.get("display_name") or None,
                product_type=row.get("product_type"),
                leverage=_optional_float(row.get("leverage")),
                strike_price=_optional_float(row.get("strike_price")),
                knockout_price=_optional_float(row.get("knockout_price")),
                ratio=_optional_float(row.get("ratio")),
                expiry=row.get("expiry") or None,
            )
        )
        if row["quote_price"]:
            store.insert_quote(
                Quote(
                    isin=row["isin"],
                    price=row["quote_price"],
                    currency=row["quote_currency"],
                )
            )
        if any(row.get(field) is not None and row.get(field) != "" for field in ("delta", "omega", "theta", "iv")):
            store.insert_greek(
                Greek(
                    isin=row["isin"],
                    delta=_optional_float(row.get("delta")),
                    omega=_optional_float(row.get("omega")),
                    theta=_optional_float(row.get("theta")),
                    iv=_optional_float(row.get("iv")),
                )
            )


def _float_or_zero(value: Any) -> float:
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0.0


def _optional_float(value: Any) -> float | None:
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _first_non_empty(*values: Any) -> str:
    for value in values:
        text = str(value or "").strip()
        if text:
            return text
    return ""
