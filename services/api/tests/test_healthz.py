"""Smoke test for the api `/healthz` endpoint.

Mocks the lifespan dependencies (asyncpg pool, paho MQTT client, httpx client
and environment variables) so the FastAPI TestClient can boot without an
external DB / broker. Catches import/syntax errors and basic route wiring.
"""
from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest


@pytest.fixture
def client(monkeypatch):
    # _dsn() reads these unconditionally.
    monkeypatch.setenv("POSTGRES_USER", "test")
    monkeypatch.setenv("POSTGRES_PASSWORD", "test")
    monkeypatch.setenv("POSTGRES_HOST", "localhost")
    monkeypatch.setenv("POSTGRES_PORT", "5432")
    monkeypatch.setenv("POSTGRES_DB", "test")

    # Replace heavy I/O constructors before importing main.
    import asyncpg  # type: ignore
    import httpx  # type: ignore
    import paho.mqtt.client as mqtt_mod  # type: ignore

    async def _fake_pool(*_a, **_kw):
        # AsyncMock so .close() returns an awaitable.
        return AsyncMock()
    monkeypatch.setattr(asyncpg, "create_pool", _fake_pool)
    # google.genai imports `class AsyncHttpxClient(httpx.AsyncClient)` at
    # module load, so the replacement has to *be a class*. Subclassing the
    # real AsyncClient gives us that for free, then we override the methods
    # main actually awaits (post, aclose) with AsyncMocks.
    class _StubAsyncClient(httpx.AsyncClient):
        def __init__(self, *_a, **_kw):
            super().__init__()
            self.post = AsyncMock(return_value=MagicMock(status_code=200, raise_for_status=lambda: None))
            self.aclose = AsyncMock()
    monkeypatch.setattr(httpx, "AsyncClient", _StubAsyncClient)
    monkeypatch.setattr(mqtt_mod, "Client", MagicMock)

    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    # Force a fresh import so the patches take effect.
    sys.modules.pop("main", None)
    from main import app  # noqa: E402

    from fastapi.testclient import TestClient
    with TestClient(app) as c:
        yield c


def test_healthz_returns_ok(client):
    r = client.get("/healthz")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}


def test_unknown_route_404(client):
    r = client.get("/no-such-thing")
    assert r.status_code == 404
