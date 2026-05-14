"""Tests for the α-power → autopilot trigger plumbing in the api service.

Covers:
  • `GET /eeg-trigger` returns sane defaults.
  • `POST /eeg-trigger` validates input and republishes `control/decision_mode`
    retained so decision_svc knows whether to stand down.
  • `_handle_decision_state` only acts on real edges and only when the
    trigger is enabled (autopilot start/stop hooks are stubbed so the test
    doesn't need Gemini or a roomba-api stand-in).
"""
from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("POSTGRES_USER", "test")
    monkeypatch.setenv("POSTGRES_PASSWORD", "test")
    monkeypatch.setenv("POSTGRES_HOST", "localhost")
    monkeypatch.setenv("POSTGRES_PORT", "5432")
    monkeypatch.setenv("POSTGRES_DB", "test")

    import asyncpg
    import httpx
    import paho.mqtt.client as mqtt_mod

    async def _fake_pool(*_a, **_kw):
        return AsyncMock()
    monkeypatch.setattr(asyncpg, "create_pool", _fake_pool)
    # google.genai builds `class AsyncHttpxClient(httpx.AsyncClient)` at
    # import time, so the patch must remain class-shaped. We subclass and
    # then override the awaited methods so test code doesn't need real I/O.
    class _StubAsyncClient(httpx.AsyncClient):
        def __init__(self, *_a, **_kw):
            super().__init__()
            self.post = AsyncMock(return_value=MagicMock(status_code=200, raise_for_status=lambda: None))
            self.aclose = AsyncMock()
    monkeypatch.setattr(httpx, "AsyncClient", _StubAsyncClient)
    monkeypatch.setattr(mqtt_mod, "Client", MagicMock)

    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    sys.modules.pop("main", None)
    import main  # noqa: E402

    from fastapi.testclient import TestClient
    with TestClient(main.app) as c:
        yield c, main


def test_get_eeg_trigger_defaults(client):
    c, _ = client
    r = c.get("/eeg-trigger")
    assert r.status_code == 200
    j = r.json()
    assert j["enabled"] is False
    assert j["mode"] == "goal"
    assert "human leg" in j["goal"] or "足元" in j["goal"]
    assert j["interval"] == pytest.approx(3.0)


def test_post_eeg_trigger_enables_and_publishes_off(client):
    c, main = client
    main.app.state.mq.publish.reset_mock()
    r = c.post("/eeg-trigger", json={"enabled": True, "goal": "the red chair"})
    assert r.status_code == 200
    j = r.json()
    assert j["enabled"] is True
    assert j["goal"] == "the red chair"

    # control/decision_mode = "off" must have been republished retained.
    calls = [args for args, _ in main.app.state.mq.publish.call_args_list]
    matching = [a for a in calls if a and a[0] == "control/decision_mode"]
    assert matching, "control/decision_mode was not published"
    payload = json.loads(matching[-1][1])
    assert payload == {"dispatch": "off"}


def test_post_eeg_trigger_disables_publishes_forward_stop(client):
    c, main = client
    c.post("/eeg-trigger", json={"enabled": True})
    main.app.state.mq.publish.reset_mock()
    r = c.post("/eeg-trigger", json={"enabled": False})
    assert r.status_code == 200
    assert r.json()["enabled"] is False
    calls = [args for args, _ in main.app.state.mq.publish.call_args_list]
    matching = [a for a in calls if a and a[0] == "control/decision_mode"]
    assert matching
    payload = json.loads(matching[-1][1])
    assert payload == {"dispatch": "forward_stop"}


def test_post_eeg_trigger_rejects_bad_mode(client):
    c, _ = client
    r = c.post("/eeg-trigger", json={"mode": "wander"})
    assert r.status_code == 400


def test_post_eeg_trigger_rejects_non_numeric_interval(client):
    c, _ = client
    r = c.post("/eeg-trigger", json={"interval": "fast"})
    assert r.status_code == 400


def test_post_eeg_trigger_clamps_interval(client):
    c, _ = client
    r = c.post("/eeg-trigger", json={"interval": 9999})
    assert r.status_code == 200
    assert r.json()["interval"] == pytest.approx(30.0)
    r = c.post("/eeg-trigger", json={"interval": 0.01})
    assert r.status_code == 200
    assert r.json()["interval"] == pytest.approx(1.0)


def test_handle_decision_state_only_acts_on_edges(client):
    """Same-state repeats (e.g., retained republish) must not fire start/stop."""
    _, main = client
    main.app.state.eeg_trigger["enabled"] = True
    started: list[dict] = []
    stopped: list[str] = []

    async def fake_start(body, *, src):
        started.append({"body": body, "src": src})
        return {"status": "started"}

    async def fake_stop(*, src):
        stopped.append(src)
        return {"status": "stopped"}

    main._autopilot_start_internal = fake_start  # type: ignore[attr-defined]
    main._autopilot_stop_internal = fake_stop  # type: ignore[attr-defined]

    async def _run():
        # First idle → no edge from default "idle" baseline.
        await main._handle_decision_state(json.dumps({"state": "idle"}))
        # idle → active: fires start.
        await main._handle_decision_state(json.dumps({"state": "active"}))
        # active → active: no-op.
        await main._handle_decision_state(json.dumps({"state": "active"}))
        # active → idle: fires stop.
        await main._handle_decision_state(json.dumps({"state": "idle"}))
        # Garbage payload: no-op, no crash.
        await main._handle_decision_state("not-json")
        await main._handle_decision_state(json.dumps({"state": "weird"}))

    asyncio.run(_run())
    assert len(started) == 1
    assert started[0]["src"] == "eeg"
    assert started[0]["body"]["mode"] == "goal"
    assert "足元" in started[0]["body"]["goal"] or "human leg" in started[0]["body"]["goal"]
    assert stopped == ["eeg"]


def test_handle_decision_state_disabled_does_nothing(client):
    """With the trigger off, edges must NOT start the autopilot."""
    _, main = client
    main.app.state.eeg_trigger["enabled"] = False
    started: list[dict] = []

    async def fake_start(body, *, src):
        started.append({"body": body, "src": src})

    main._autopilot_start_internal = fake_start  # type: ignore[attr-defined]

    async def _run():
        await main._handle_decision_state(json.dumps({"state": "active"}))
        await main._handle_decision_state(json.dumps({"state": "idle"}))

    asyncio.run(_run())
    assert started == []
