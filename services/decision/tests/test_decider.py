"""Unit tests for decision.Decider state machine.

Mocks MQTT and HTTP so we exercise only the hysteresis + dwell logic.
"""
from __future__ import annotations

import asyncio
import sys
import time
from pathlib import Path
from unittest.mock import MagicMock

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import main as decision_main  # noqa: E402
from main import Decider  # noqa: E402


@pytest.fixture(autouse=True)
def _no_async_dispatch(monkeypatch):
    """Stub asyncio.run_coroutine_threadsafe so transitions don't need a running loop.

    Closes the coroutine so pytest doesn't emit a 'never awaited' warning.
    """
    def _stub(coro, _loop):
        if hasattr(coro, "close"):
            coro.close()
        return None
    monkeypatch.setattr(decision_main.asyncio, "run_coroutine_threadsafe", _stub)


def _make(enter: float = 10.0, exit_: float = 6.0, dwell_ms: int = 500) -> Decider:
    mq = MagicMock()
    http = MagicMock()
    loop = MagicMock(spec=asyncio.AbstractEventLoop)
    d = Decider(mq=mq, http=http, loop=loop)
    d.enter_th = enter
    d.exit_th = exit_
    d.dwell_ms = dwell_ms
    d.channels = [0, 1]
    return d


def _feed(d: Decider, value: float) -> None:
    d.on_alpha({"alpha": [value] * 4})


def test_starts_idle() -> None:
    d = _make()
    assert d.state == "idle"


def test_below_enter_stays_idle() -> None:
    d = _make()
    for _ in range(10):
        _feed(d, 5.0)
    assert d.state == "idle"


def test_above_enter_below_dwell_stays_idle() -> None:
    """Single high sample should not transition (dwell not yet elapsed)."""
    d = _make(dwell_ms=500)
    _feed(d, 20.0)
    assert d.state == "idle"


def test_above_enter_after_dwell_transitions_to_active(monkeypatch) -> None:
    d = _make(dwell_ms=100)
    t = [1000.0]
    monkeypatch.setattr(time, "monotonic", lambda: t[0])
    _feed(d, 20.0)
    assert d.state == "idle"
    t[0] = 1000.2  # 200 ms later
    _feed(d, 20.0)
    assert d.state == "active"


def test_drop_below_enter_resets_dwell(monkeypatch) -> None:
    d = _make(dwell_ms=200)
    t = [1000.0]
    monkeypatch.setattr(time, "monotonic", lambda: t[0])
    _feed(d, 20.0)
    t[0] = 1000.1
    _feed(d, 1.0)  # drop, resets last_cross_t
    t[0] = 1000.25  # original would have triggered
    _feed(d, 20.0)
    assert d.state == "idle"  # because last_cross_t was reset


def test_hysteresis_active_to_idle(monkeypatch) -> None:
    """Once active, must fall below exit_th (not enter_th) and dwell."""
    d = _make(enter=10.0, exit_=6.0, dwell_ms=100)
    t = [1000.0]
    monkeypatch.setattr(time, "monotonic", lambda: t[0])
    _feed(d, 20.0)
    t[0] = 1000.2
    _feed(d, 20.0)
    assert d.state == "active"

    # Value between exit and enter must NOT cause transition.
    _feed(d, 7.0)
    t[0] = 1001.0
    _feed(d, 7.0)
    assert d.state == "active"

    # Drop below exit, then dwell.
    _feed(d, 3.0)
    t[0] = 1001.2
    _feed(d, 3.0)
    assert d.state == "idle"


def test_empty_channels_is_noop() -> None:
    d = _make()
    d.channels = []
    d.on_alpha({"alpha": [100.0, 100.0]})
    assert d.state == "idle"


def test_invalid_channel_index_is_skipped() -> None:
    """Channel index past alpha length should not raise — just be ignored."""
    d = _make()
    d.channels = [0, 99]
    d.on_alpha({"alpha": [3.0]})  # ch0=3, ch99 missing
    # Mean over kept channels = 3 < enter, no transition.
    assert d.state == "idle"


def test_update_decision_mode_off_then_back() -> None:
    """control/decision_mode toggles dispatch_mode but ignores junk values."""
    d = _make()
    assert d.dispatch_mode == "forward_stop"
    d.update_decision_mode({"dispatch": "off"})
    assert d.dispatch_mode == "off"
    d.update_decision_mode({"dispatch": "garbage"})  # ignored
    assert d.dispatch_mode == "off"
    d.update_decision_mode({"dispatch": "forward_stop"})
    assert d.dispatch_mode == "forward_stop"


def test_dispatch_off_skips_http_call() -> None:
    """When the EEG-trigger owns the robot, decision must NOT hit roomba-api."""
    async def _run() -> None:
        d = _make()
        d.dispatch_mode = "off"
        await d._dispatch("active")
        d.http.post.assert_not_called()
        d.mq.publish.assert_not_called()

    asyncio.run(_run())
