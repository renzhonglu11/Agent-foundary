from concurrent.futures import ThreadPoolExecutor
import sqlite3

from agent_foundry_python.structured_products.providers import refusal
from agent_foundry_python.structured_products.providers.refusal import SourceGuard, REQUEST_PRIORITY
from agent_foundry_python.structured_products.storage import StructuredProductStore


def reserve(guard, tier1=False):
    token = REQUEST_PRIORITY.set("tier1" if tier1 else "background")
    try:
        return guard._reserve("public-product")
    finally:
        REQUEST_PRIORITY.reset(token)


def test_rolling_budgets_reserve_tier1_capacity_and_survive_restarts(tmp_path, monkeypatch):
    clock = [100_000.0]
    monkeypatch.setattr(refusal.time, "time", lambda: clock[0])
    monkeypatch.setitem(refusal.POLICY, "budget", {"hour": 4, "day": 5, "tier1_reserved_hour": 2, "tier1_reserved_day": 2})
    path = tmp_path / "access.db"
    first = SourceGuard("test", db_path=path, interval=0)
    assert reserve(first) == reserve(first) == 0
    assert reserve(first) is None and not first.refused
    assert first.budget_retry_at == 103_600
    assert reserve(first, tier1=True) == reserve(first, tier1=True) == 0
    assert reserve(first, tier1=True) is None
    first.close()

    second = SourceGuard("test", db_path=path, interval=0)
    assert reserve(second, tier1=True) is None
    clock[0] += 3601
    assert reserve(second) == 0  # rolling hour frees, day usage is still four
    assert reserve(second, tier1=True) is None  # fifth reservation exhausts day
    assert second.budget_retry_at == 186_400
    # A success does not clear quota; HTTP failures and quota are separate state.
    second._record(200)
    assert reserve(second, tier1=True) is None
    clock[0] = 186_400
    assert reserve(second, tier1=True) == 0
    assert second._db.execute("SELECT COUNT(*) FROM provider_request_events").fetchone()[0] == 2
    second.close()


def test_parallel_connections_cannot_overspend_the_last_slots(tmp_path, monkeypatch):
    monkeypatch.setitem(refusal.POLICY, "budget", {"hour": 7, "day": 20})
    path = tmp_path / "shared.db"
    SourceGuard("test", db_path=path, interval=0).close()

    def call(_):
        guard = SourceGuard("test", db_path=path, interval=0)
        try:
            return reserve(guard) == 0
        finally:
            guard.close()

    with ThreadPoolExecutor(max_workers=6) as pool:
        assert sum(pool.map(call, range(30))) == 7
    with sqlite3.connect(path) as db:
        assert db.execute("SELECT COUNT(*) FROM provider_request_events").fetchone()[0] == 7


def test_cache_misses_refusals_and_waits_do_not_charge_extra_requests(tmp_path, monkeypatch):
    monkeypatch.setattr(refusal.time, "time", lambda: 100_000.0)
    guard = SourceGuard("test", db_path=tmp_path / "db", interval=2)
    assert reserve(guard) == 0
    assert reserve(guard) == 2
    guard._record(404, resource="missing")
    assert guard._reserve("missing") is None
    guard._record(429)
    assert reserve(guard) is None
    assert guard._db.execute("SELECT COUNT(*) FROM provider_request_events").fetchone()[0] == 1
    guard.close()


def test_lowered_budget_waits_for_enough_expired_reservations():
    events = [(100.0, "background"), (200.0, "tier1"), (300.0, "background")]
    policy = {"hour": 2, "day": 10, "tier1_reserved_hour": 1}
    assert refusal.budget_retry_at(events, policy, 400.0, "tier1") == 3800.0
    assert refusal.budget_retry_at(events, policy, 400.0, "background") == 3900.0


def test_upgrade_from_existing_access_schema_preserves_cooldown_and_runtime_created_tables(tmp_path, monkeypatch):
    path = tmp_path / "upgrade.db"
    monkeypatch.setattr(refusal.time, "time", lambda: 100_000.0)
    with sqlite3.connect(path) as db:
        db.executescript(refusal.SCHEMA.read_text())
        db.execute("INSERT INTO provider_access(source,blocked_until,last_status) VALUES ('old',200000,403)")
    guard = SourceGuard("old", db_path=path, interval=0)
    assert reserve(guard) is None
    other = SourceGuard("other", db_path=path, interval=0)
    assert reserve(other) == 0
    # Like server startup: Rust/SourceGuard creates tables before yoyo records
    # the migration. The Python helper can still apply its migration safely.
    StructuredProductStore(path)
    assert other._db.execute("SELECT COUNT(*) FROM provider_request_events").fetchone()[0] == 1
    assert other._db.execute("SELECT blocked_until,last_status FROM provider_access WHERE source='old'").fetchone() == (200000, 403)
    guard.close()
    other.close()
