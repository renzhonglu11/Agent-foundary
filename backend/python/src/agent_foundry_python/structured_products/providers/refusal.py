"""Persistent request spacing and cooldown shared with Rust candidate search."""

from __future__ import annotations

import asyncio
import logging
import json
import math
import sqlite3
import time
from contextvars import ContextVar
from datetime import timezone
from email.utils import parsedate_to_datetime
from pathlib import Path

import httpx

logger = logging.getLogger(__name__)

REFUSAL_STATUS_CODES = frozenset({401, 403, 429})
SCHEMA = Path(__file__).parents[1] / "migrations/0002_provider_access.sql"
POLICY = json.loads((Path(__file__).parents[1] / "provider_policy.json").read_text())
BUDGET_SCHEMA = Path(__file__).parents[1] / "migrations/0003_provider_budgets.sql"
# Context-local: concurrent Tier 1 and background tasks cannot overwrite each
# other's priority, even when they share a provider instance.
REQUEST_PRIORITY = ContextVar("provider_request_priority", default="background")


def budget_retry_at(events: list[tuple[float, str]], policy: dict, now: float, priority: str) -> float:
    retry_at = 0.0
    for window, seconds in (("hour", 3600), ("day", 86400)):
        times = [at for at, _ in events if at > now - seconds]
        limit = policy[window]
        if len(times) >= limit:
            retry_at = max(retry_at, times[len(times) - limit] + seconds)
        if priority != "tier1":
            times = [at for at, p in events if at > now - seconds and p != "tier1"]
            limit -= policy.get("tier1_reserved_" + window, 0)
            if len(times) >= limit:
                retry_at = max(retry_at, times[len(times) - limit] + seconds if limit else now + seconds)
    return retry_at


def retry_after_seconds(value: str | None, now: float) -> float:
    if not value:
        return 0
    if value.strip().isascii() and value.strip().isdigit():
        seconds = float(value.strip())
        return seconds if math.isfinite(seconds) else 0
    try:
        date = parsedate_to_datetime(value)
        if date.tzinfo is None:
            date = date.replace(tzinfo=timezone.utc)
        return max(0, date.timestamp() - now)
    except (ValueError, TypeError, OverflowError):
        return 0


class SourceGuard:
    def __init__(self, source: str, *, db_path: Path | None = None, interval: float | None = None) -> None:
        self.source = source
        self.refused = False
        self.interval = max(0, interval if interval is not None else POLICY["sources"].get(source, {}).get("interval_seconds", POLICY["interval_seconds"]))
        self._lock = asyncio.Lock()
        # Standalone callers use memory; the CLI always supplies its persistent DB.
        self._db = sqlite3.connect(str(db_path) if db_path else ":memory:", timeout=5)
        self._db.executescript(SCHEMA.read_text())
        self._db.executescript(BUDGET_SCHEMA.read_text())
        self.budget = POLICY["sources"].get(source, {}).get("budget", POLICY["budget"])
        for window in ("hour", "day"):
            if not 0 <= self.budget.get("tier1_reserved_" + window, 0) < self.budget[window]:
                raise ValueError("invalid provider budget")
        self.budget_retry_at = 0.0

    def _reserve(self, resource: str) -> float | None:
        now = time.time()
        with self._db:
            self._db.execute("BEGIN IMMEDIATE")
            self._db.execute("INSERT OR IGNORE INTO provider_access(source) VALUES (?)", (self.source,))
            next_at, blocked = self._db.execute(
                "SELECT next_request_at, blocked_until FROM provider_access WHERE source=?", (self.source,)
            ).fetchone()
            if blocked > now:
                self.refused = True
                return None
            missing = self._db.execute(
                "SELECT retry_at FROM provider_missing_products WHERE source=? AND resource=?",
                (self.source, resource),
            ).fetchone()
            if missing and missing[0] > now:
                return None
            events = self._db.execute(
                "SELECT requested_at,priority FROM provider_request_events WHERE source=? AND requested_at>? ORDER BY requested_at",
                (self.source, now - 86400),
            ).fetchall()
            priority = REQUEST_PRIORITY.get()
            self.budget_retry_at = budget_retry_at(events, self.budget, now, priority)
            if self.budget_retry_at > now:
                # Budget exhaustion is not an HTTP refusal and must not block
                # another priority or write a fabricated HTTP status.
                return None
            if next_at > now:
                return next_at - now
            self._db.execute(
                "UPDATE provider_access SET next_request_at=? WHERE source=?", (now + self.interval, self.source)
            )
            self._db.execute(
                "INSERT INTO provider_request_events(source,requested_at,priority) VALUES (?,?,?)",
                (self.source, now, priority),
            )
            self._db.execute("DELETE FROM provider_request_events WHERE requested_at<=?", (now - 86400,))
        return 0

    def check(self, response: httpx.Response) -> None:
        self._record(response.status_code, response.headers.get("Retry-After"), str(response.request.url))

    def _record(self, status: int, retry_after: str | None = None, resource: str = "") -> None:
        now = time.time()
        with self._db:
            self._db.execute("BEGIN IMMEDIATE")
            self._db.execute("INSERT OR IGNORE INTO provider_access(source) VALUES (?)", (self.source,))
            failures, blocked = self._db.execute(
                "SELECT failures, blocked_until FROM provider_access WHERE source=?", (self.source,)
            ).fetchone()
            if status in REFUSAL_STATUS_CODES or status == 0 or status >= 500:
                failures = min(failures + 1, 8)
                policy = POLICY["refused" if status in (401, 403) else "limited" if status == 429 else "unavailable"]
                base, cap = policy["initial_seconds"], policy["max_seconds"]
                delay = max(min(base * 2 ** (failures - 1), cap), retry_after_seconds(retry_after, now))
                self._db.execute(
                    "UPDATE provider_access SET failures=?, blocked_until=?, last_status=?, updated_at=? WHERE source=?",
                    (failures, max(blocked, now + delay), status, now, self.source),
                )
                if not self.refused:
                    logger.warning("%s refused/unavailable HTTP %s; pausing source for at least %.0f seconds (persisted)", self.source, status or "transport error", delay)
                self.refused = True
            else:
                # An in-flight success must not clear another client's refusal.
                self._db.execute(
                    "UPDATE provider_access SET failures=0, last_status=?, updated_at=? WHERE source=? AND blocked_until<=?",
                    (status, now, self.source, now),
                )
                if status == 404:
                    self._db.execute(
                        "INSERT OR REPLACE INTO provider_missing_products VALUES (?, ?, ?)",
                        (self.source, resource, now + POLICY["missing_seconds"]),
                    )
            self._db.execute("DELETE FROM provider_missing_products WHERE retry_at<=?", (now,))

    async def get(self, client: httpx.AsyncClient, url: str, **kwargs) -> httpx.Response | None:
        resource = str(client.build_request("GET", url, **kwargs).url)
        async with self._lock:
            while not self.refused:
                wait = self._reserve(resource)
                if wait is None:
                    return None
                if wait > 0:
                    await asyncio.sleep(wait)
                    continue
                try:
                    response = await client.get(url, **kwargs)
                except httpx.HTTPError:
                    self._record(0)
                    return None
                self.check(response)
                return response
        return None

    def close(self) -> None:
        self._db.close()
