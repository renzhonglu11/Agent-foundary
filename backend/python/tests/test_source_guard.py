import asyncio
import sqlite3

import httpx
import pytest

from agent_foundry_python.structured_products.providers import refusal
from agent_foundry_python.structured_products.providers.refusal import SourceGuard


@pytest.mark.asyncio
async def test_refusal_survives_new_workers_and_other_source_keeps_working(tmp_path, monkeypatch):
    clock = [1000.0]
    monkeypatch.setattr(refusal.time, "time", lambda: clock[0])
    path = tmp_path / "enrichment.db"
    calls = []
    async def handler(request):
        calls.append(str(request.url))
        return httpx.Response(403 if len(calls) == 1 else 200)
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        first = SourceGuard("a", db_path=path, interval=0)
        assert (await first.get(client, "https://a/product/1")).status_code == 403
        first.close()
        second = SourceGuard("a", db_path=path, interval=0)
        assert await second.get(client, "https://a/product/2") is None
        assert len(calls) == 1
        other = SourceGuard("b", db_path=path, interval=0)
        assert (await other.get(client, "https://b/product/1")).status_code == 200
        clock[0] += 86401
        third = SourceGuard("a", db_path=path, interval=0)
        assert (await third.get(client, "https://a/product/2")).status_code == 200
        for guard in (second, other, third): guard.close()


@pytest.mark.asyncio
async def test_waiting_requests_recheck_a_refusal_before_sending(tmp_path):
    calls = []
    async def handler(request):
        calls.append(str(request.url))
        await asyncio.sleep(0)
        return httpx.Response(429, headers={"Retry-After": "7200"})
    guard = SourceGuard("a", db_path=tmp_path / "db", interval=0)
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        results = await asyncio.gather(*(guard.get(client, f"https://a/{i}") for i in range(5)))
    assert len(calls) == 1
    assert sum(result is not None for result in results) == 1
    until = guard._db.execute("SELECT blocked_until FROM provider_access").fetchone()[0]
    assert until >= refusal.time.time() + 7190
    guard.close()


@pytest.mark.asyncio
async def test_missing_product_is_cached_but_not_confused_with_source_refusal(tmp_path, monkeypatch):
    clock = [1000.0]
    monkeypatch.setattr(refusal.time, "time", lambda: clock[0])
    path = tmp_path / "db"
    calls = []
    async def handler(request):
        calls.append(str(request.url))
        return httpx.Response(404 if request.url.path == "/missing" else 200)
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        first = SourceGuard("a", db_path=path, interval=0)
        await first.get(client, "https://a/missing")
        first.close()
        second = SourceGuard("a", db_path=path, interval=0)
        assert await second.get(client, "https://a/missing") is None
        assert (await second.get(client, "https://a/known")).status_code == 200
        assert len(calls) == 2 and not second.refused
        clock[0] += 86401
        await second.get(client, "https://a/missing")
        assert len(calls) == 3
        second.close()


def test_slot_spacing_and_backoff_are_shared_and_success_cannot_erase_refusal(tmp_path, monkeypatch):
    clock = [1000.0]
    monkeypatch.setattr(refusal.time, "time", lambda: clock[0])
    path = tmp_path / "db"
    a = SourceGuard("a", db_path=path, interval=2)
    b = SourceGuard("a", db_path=path, interval=2)
    assert a._reserve("one") == 0
    assert b._reserve("two") == 2
    clock[0] += 2
    assert b._reserve("two") == 0
    a._record(429)
    b._record(200)
    with sqlite3.connect(path) as db:
        assert db.execute("SELECT failures, blocked_until, last_status FROM provider_access").fetchone() == (1, 4602.0, 429)
    clock[0] = 4603.0
    c = SourceGuard("a", db_path=path, interval=2)
    assert c._reserve("retry") == 0
    c._record(429)
    assert c._db.execute("SELECT blocked_until FROM provider_access").fetchone()[0] == 11803.0
    for guard in (a, b, c): guard.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("status", [401, 403, 429, 503, 0])
async def test_errors_pause_the_whole_source_without_retrying(status, monkeypatch):
    monkeypatch.setattr(refusal.time, "time", lambda: 1000.0)
    calls = []
    async def handler(request):
        calls.append(request)
        if status == 0: raise httpx.ReadTimeout("timeout", request=request)
        return httpx.Response(status)
    guard = SourceGuard("a", interval=0)
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        await guard.get(client, "https://a/one")
        assert await guard.get(client, "https://a/two") is None
    assert len(calls) == 1
    assert guard._db.execute("SELECT blocked_until FROM provider_access").fetchone()[0] > 1000
    guard.close()


def test_retry_after_accepts_seconds_and_http_date_without_shortening_server_delay():
    assert refusal.retry_after_seconds("7200", 0) == 7200
    assert refusal.retry_after_seconds("Thu, 01 Jan 1970 02:00:00 GMT", 0) == 7200
    for value in (None, "", "tomorrow", "-10", "inf", "Thu, 01 Jan 1970 00:00:00 GMT"):
        assert refusal.retry_after_seconds(value, 100) == 0
