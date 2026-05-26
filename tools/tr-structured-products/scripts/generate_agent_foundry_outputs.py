#!/usr/bin/env python3
from __future__ import annotations

import argparse
import asyncio
import json
import sys
import urllib.request
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
SRC_DIR = PROJECT_ROOT / "src"
if str(SRC_DIR) not in sys.path:
    sys.path.insert(0, str(SRC_DIR))

from tr_structured_products.agent_foundry import (
    AgentFoundryPortfolioAdapter,
    assign_enrichment_tiers,
    write_structured_product_rows_outputs,
)
from tr_structured_products.enrichment import enrich_structured_product_rows
from tr_structured_products.providers.boerse_frankfurt import BoerseFrankfurtQuoteProvider
from tr_structured_products.providers.onvista import OnvistaProductProvider


def load_summary(*, summary_json: Path | None, summary_url: str | None) -> dict:
    if summary_json is not None:
        return json.loads(summary_json.read_text(encoding="utf-8"))
    if summary_url is None:
        summary_url = "http://127.0.0.1:8080/data/portfolio-summary.json"
    with urllib.request.urlopen(summary_url, timeout=20) as response:
        return json.loads(response.read().decode("utf-8"))


async def generate_outputs(args: argparse.Namespace) -> list[dict]:
    summary = load_summary(summary_json=args.summary_json, summary_url=args.summary_url)
    rows = AgentFoundryPortfolioAdapter(summary).structured_product_rows()
    rows = assign_enrichment_tiers(rows, tier1_limit=args.tier1_limit)
    if args.limit is not None:
        rows = rows[: args.limit]

    if not args.no_live_enrichment:
        quote_provider = BoerseFrankfurtQuoteProvider(timeout=args.provider_timeout)
        onvista_provider = OnvistaProductProvider(timeout=args.provider_timeout)
        product_providers = [onvista_provider]
        try:
            rows = await enrich_structured_product_rows(
                rows,
                quote_provider=quote_provider,
                product_providers=product_providers,
                request_delay_seconds=args.request_delay,
                live_enrichment_tier=args.live_enrichment_tier,
                progress_callback=emit_progress if args.emit_progress else None,
            )
        finally:
            await quote_provider.aclose()
            await onvista_provider.aclose()

    write_structured_product_rows_outputs(rows, csv_path=args.csv, json_path=args.json, db_path=args.db)
    return rows


def emit_progress(event: dict) -> None:
    print(json.dumps(event, ensure_ascii=False), flush=True)


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate structured-products enrichment outputs from Rust Agent-Foundry portfolio summary.")
    parser.add_argument("--summary-json", type=Path, help="Path to a Rust portfolio-summary.json file. If omitted, --summary-url is used.")
    parser.add_argument("--summary-url", default="http://127.0.0.1:8080/data/portfolio-summary.json", help="Rust backend portfolio summary URL.")
    parser.add_argument("--csv", type=Path, default=Path("../../data/structured-products-enrichment.csv"), help="Output CSV path.")
    parser.add_argument("--json", type=Path, default=Path("../../web/public/data/structured-products-enrichment.json"), help="Output JSON path for frontend.")
    parser.add_argument("--db", type=Path, default=Path("../../data/structured-products-enrichment.sqlite3"), help="Output SQLite path.")
    parser.add_argument("--provider-timeout", type=float, default=10.0, help="Per-request provider timeout in seconds.")
    parser.add_argument("--tier1-limit", type=int, default=20, help="Maximum number of underlying groups eligible for live quote/Greeks enrichment.")
    parser.add_argument("--live-enrichment-tier", default="tier1", help="Only rows in this enrichment tier call live providers. Use empty string to enrich all tiers.")
    parser.add_argument("--limit", type=int, help="Only process the first N structured products; useful for low-frequency smoke runs.")
    parser.add_argument("--request-delay", type=float, default=2.0, help="Delay between product enrichment requests in seconds.")
    parser.add_argument("--no-live-enrichment", action="store_true", help="Only write Rust summary rows; skip Onvista/Börse Frankfurt enrichment.")
    parser.add_argument("--emit-progress", action="store_true", help="Print JSON lines with live enrichment progress.")
    args = parser.parse_args()
    if args.live_enrichment_tier == "":
        args.live_enrichment_tier = None

    rows = asyncio.run(generate_outputs(args))
    print(json.dumps({"count": len(rows), "csv": str(args.csv), "json": str(args.json), "db": str(args.db)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
