"""Structured products enrichment package for Agent-Foundry."""

from .agent_foundry import AgentFoundryPortfolioAdapter, assign_enrichment_tiers, write_structured_product_rows_outputs, write_structured_products_outputs
from .enrichment import MetadataProviderProductAdapter, ProductData, enrich_structured_product_rows
from .models import Exposure, Greek, InstrumentMetadata, Position, Quote
from .storage import StructuredProductStore, initialize_schema

__all__ = [
    "AgentFoundryPortfolioAdapter",
    "assign_enrichment_tiers",
    "Exposure",
    "Greek",
    "InstrumentMetadata",
    "MetadataProviderProductAdapter",
    "Position",
    "ProductData",
    "Quote",
    "StructuredProductStore",
    "initialize_schema",
    "enrich_structured_product_rows",
    "write_structured_product_rows_outputs",
    "write_structured_products_outputs",
]
