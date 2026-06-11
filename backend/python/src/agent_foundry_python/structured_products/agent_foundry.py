from __future__ import annotations

import csv
import json
import re
from pathlib import Path
from typing import Any

from agent_foundry_python.structured_products.models import Greek, InstrumentMetadata, Position, Quote
from agent_foundry_python.structured_products.storage import StructuredProductStore

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
    "break_even",
    "ratio",
    "expiry",
    "option_type",
    "reset_barrier",
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
    - tier1: structured products whose underlying group is in the first N live-eligible
      groups by total group market value; real-time quote/Greeks refresh.
    - tier2: remaining structured products; Rust summary/fallback data only by default.
    - tier3: ETF, bond, equity, cash, or any non-derivative/non-live-eligible row.
    """
    tier1_group_keys = _tier1_group_keys(rows, tier1_limit=tier1_limit)
    tiered_rows: list[dict[str, Any]] = []
    for row in rows:
        tiered = dict(row)
        if _is_live_enrichment_candidate(tiered) and _structured_product_group_key(tiered) in tier1_group_keys:
            tiered["enrichment_tier"] = "tier1"
            tiered["live_enrichment_enabled"] = True
        elif _is_structured_product_row(tiered):
            tiered["enrichment_tier"] = "tier2"
            tiered["live_enrichment_enabled"] = False
        else:
            tiered["enrichment_tier"] = "tier3"
            tiered["live_enrichment_enabled"] = False
        tiered_rows.append(tiered)
    return tiered_rows


def _tier1_group_keys(rows: list[dict[str, Any]], *, tier1_limit: int) -> set[str]:
    group_values: dict[str, float] = {}
    group_order: dict[str, int] = {}

    for index, row in enumerate(rows):
        if not _is_live_enrichment_candidate(row):
            continue
        key = _structured_product_group_key(row)
        group_values[key] = group_values.get(key, 0.0) + _float_or_zero(row.get("market_value"))
        group_order.setdefault(key, index)

    ranked_keys = sorted(
        group_values,
        key=lambda key: (-group_values[key], group_order[key]),
    )
    return set(ranked_keys[:tier1_limit])


def _structured_product_group_key(row: dict[str, Any]) -> str:
    value = _first_non_empty(
        row.get("underlying"),
        _infer_underlying(row.get("instrument")),
        _infer_underlying(row.get("display_name")),
        _infer_underlying(row.get("issuer")),
        row.get("isin"),
    )
    return _canonical_group_key(value)


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


def _infer_underlying(value: Any) -> str:
    text = str(value or "").split("·")[0].strip()
    text = re.sub(r"^(call|put)\s+\d{2}\.\d{2}\.\d{2}\s+", "", text, flags=re.IGNORECASE)
    text = re.sub(r"^(turboc|turbop|turbo|faktl|fakts)\s+o\.end\s+", "", text, flags=re.IGNORECASE)
    text = re.sub(r"^(optionsschein|open end turbo|faktor optionsschein)\s+auf\s+", "", text, flags=re.IGNORECASE)
    text = re.sub(r"\s+\d+[\d.,]*\s*$", "", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text


def _canonical_group_key(value: Any) -> str:
    text = _select_company_name_segment(value)
    text = re.sub(r"\b(registered|bearer|ordinary|common|preferred|reg\.?|inhaber|namens|stamm)\s*-?\s*(shares?|aktien|shs)?\b", " ", text, flags=re.IGNORECASE)
    text = re.sub(r"\b(shares?|aktien|adr|adrs|gdrs|ads|ord|stk|cap\.?stk|class|klasse|cl\.?|dl|eur|usd|eo|ta|sw|o\.n\.|sp\.?|spons\.?|aandelen|naam|toonder|new)\b", " ", text, flags=re.IGNORECASE)
    text = re.sub(r"\b(corporation|corp\.?|inc\.?|incorporated|company|co\.?|ltd\.?|limited|plc|llc|holdings?|hldgs|manufact\.?|ag|se|sa|nv|spa|s\.a\.?|n\.v\.?)\b", " ", text, flags=re.IGNORECASE)
    text = re.sub(r"[-,.;()/]", " ", text)
    text = re.sub(r"\b\d+[\d.,]*\b", " ", text)
    normalized = _normalize_key(text or value)
    aliases = {
        "alphab c": "alphabet",
        "alphabet c": "alphabet",
        "asmlhold": "asml",
        "arm": "arm",
        "arm hldgs": "arm",
        "micron": "micron technology",
        "microso": "microsoft",
        "nvidia": "nvidia",
        "taiwansm": "taiwan semiconduct",
        "texasin": "texas instruments",
        "texas in": "texas instruments",
    }
    return aliases.get(normalized, normalized)


def _select_company_name_segment(value: Any) -> str:
    parts = [part.strip() for part in str(value or "unknown").split("·") if part.strip()]
    if len(parts) < 2:
        return parts[0] if parts else str(value or "unknown").strip()
    descriptor_pattern = re.compile(r"\b(aktien|shares?|aandelen|stammaktien|inhaber|namens|registered|reg\.?|ord|adr|gdr|o\.n\.)\b", re.IGNORECASE)
    if descriptor_pattern.search(parts[0]) and not descriptor_pattern.search(parts[1]):
        return parts[1]
    return parts[0]


def _normalize_key(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "unknown").strip().lower())


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

    # Determine option direction
    dir_text = display_name + " " + _first_non_empty(position.get("instrument"), position.get("issuer"), position.get("name"))
    option_type = _detect_direction(dir_text)

    return {
        "isin": str(position.get("symbol") or ""),
        "display_name": display_name,
        "issuer": _first_non_empty(position.get("issuer")),
        "instrument": _first_non_empty(position.get("instrument")),
        "underlying": _infer_underlying(
            _first_non_empty(
                position.get("instrument"),
                display_name,
                position.get("symbol")
            )
        ),
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
        "break_even": None,
        "ratio": None,
        "expiry": None,
        "option_type": option_type,
        "reset_barrier": None,
        "metadata_source": None,
        "greeks_source": None,
        "metadata_url": None,
        "enrichment_tier": None,
        "live_enrichment_enabled": False,
        "last_trade_date": _first_non_empty(position.get("lastTradeDate"), position.get("last_trade_date")),
        "source_generated_at": generated_at,
    }


def _detect_direction(text: str) -> str:
    text_lower = str(text or "").lower()
    if any(k in text_lower for k in ("put", "bear", "short", "turbop", "fakts")):
        return "put"
    if any(k in text_lower for k in ("call", "bull", "long", "turboc", "faktl")):
        return "call"
    return "call"


def _detect_product_type(position: dict[str, Any]) -> str | None:
    text = " ".join(str(position.get(key) or "") for key in ("displayName", "pdfName", "issuer", "instrument", "name")).casefold()
    if any(k in text for k in ("faktor zertifikat", "faktor-zertifikat", "factor certificate", "faktor optionsschein", "faktor-optionsschein", "faktl", "fakts")):
        return "factor_certificate"
    if any(k in text for k in ("open end turbo", "open-end turbo", "turbo", "knock-out", "knock out", "turboc", "turbop")):
        return "open_end_turbo"
    if "optionsschein" in text or "call " in text or "put " in text:
        return "optionsschein"
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
    store = StructuredProductStore(path)
    import sqlite3
    with sqlite3.connect(path) as conn:
        conn.execute("DELETE FROM positions")
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
                underlying=row.get("underlying") or None,
                product_type=row.get("product_type"),
                leverage=_optional_float(row.get("leverage")),
                strike_price=_optional_float(row.get("strike_price")),
                knockout_price=_optional_float(row.get("knockout_price")),
                break_even=_optional_float(row.get("break_even")),
                ratio=_optional_float(row.get("ratio")),
                expiry=row.get("expiry") or None,
                option_type=row.get("option_type") or None,
                reset_barrier=_optional_float(row.get("reset_barrier")),
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
