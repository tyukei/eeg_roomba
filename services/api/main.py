"""WebUI backend: FastAPI + WebSocket proxy to MQTT, REST for history & control."""
from __future__ import annotations

import asyncio
import base64
import binascii
import json
import logging
import math
import os
import re
import time
from contextlib import asynccontextmanager
from typing import Any

import asyncpg
import httpx
import paho.mqtt.client as mqtt
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from google import genai
from google.genai import types as gtypes

log = logging.getLogger("api")

MQTT_HOST = os.environ.get("MQTT_HOST", "localhost")
MQTT_PORT = int(os.environ.get("MQTT_PORT", "1883"))
ROOMBA_BASE = os.environ.get("ROOMBA_HTTP_BASE", "http://localhost:8000").rstrip("/")
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-3.1-flash-lite")
GEMINI_ROBOTICS_MODEL = os.environ.get(
    "GEMINI_ROBOTICS_MODEL", "gemini-robotics-er-1.6-preview"
)

# Topic -> set of websockets to fan out to.
SUBS: dict[str, set[WebSocket]] = {
    "eeg/live": set(),
    "eeg/alpha": set(),
    "control/state": set(),
    "control/threshold": set(),
    "pieeg/health": set(),
    "roomba/state": set(),
    "roomba/cmd": set(),
}


def _dsn() -> str:
    return (
        f"postgres://{os.environ['POSTGRES_USER']}:{os.environ['POSTGRES_PASSWORD']}"
        f"@{os.environ['POSTGRES_HOST']}:{os.environ['POSTGRES_PORT']}/{os.environ['POSTGRES_DB']}"
    )


@asynccontextmanager
async def lifespan(app: FastAPI):
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    app.state.pool = await asyncpg.create_pool(_dsn(), min_size=1, max_size=4)
    app.state.http = httpx.AsyncClient()
    app.state.genai = genai.Client(api_key=GEMINI_API_KEY) if GEMINI_API_KEY else None
    app.state.autopilot = {
        "task": None,
        "running": False,
        "config": {
            "interval": 3.0,
            "model": GEMINI_ROBOTICS_MODEL,
            "mode": "free",
            "goal": "",
        },
        "last_command": None,
        "last_reason": None,
        "last_error": None,
        "decisions": [],  # list[{ts, command, reason, ok}]
        # Guards concurrent /autopilot/start and /stop so two racers can't both
        # claim the loop or both leave a dangling task.
        "lock": asyncio.Lock(),
    }

    loop = asyncio.get_running_loop()
    mq = mqtt.Client(client_id="api", protocol=mqtt.MQTTv311)

    def _on_message(_c, _u, msg):
        text = msg.payload.decode("utf-8", errors="replace")
        targets = list(SUBS.get(msg.topic, ()))
        for ws in targets:
            asyncio.run_coroutine_threadsafe(_safe_send(ws, msg.topic, text), loop)
        # Persist every roomba/cmd to TimescaleDB so the UI can rehydrate
        # trajectory + autopilot timeline after a browser reload, and so we
        # can JOIN with eeg_features for research queries.
        if msg.topic == "roomba/cmd":
            asyncio.run_coroutine_threadsafe(_record_roomba_event(text), loop)

    mq.on_message = _on_message
    mq.connect(MQTT_HOST, MQTT_PORT, keepalive=30)
    for topic in SUBS:
        mq.subscribe(topic, qos=0)
    mq.loop_start()
    app.state.mq = mq

    # Rehydrate the autopilot decision timeline from DB so a fresh /autopilot/status
    # poll after an api restart still shows the recent decisions. Bounded to
    # AUTOPILOT_MAX_DECISIONS so the in-memory ring buffer stays small.
    try:
        await _hydrate_autopilot_decisions()
    except asyncpg.UndefinedTableError:
        # roomba_events isn't created yet — likely a brand new deployment that
        # hasn't run the init.sql migration. Boot the api anyway and let the
        # MQTT insert path surface the error if it actually matters.
        log.warning("roomba_events table missing; skipping autopilot hydration")
    except Exception:  # noqa: BLE001 — never let a cold-start query break boot
        log.exception("autopilot decision hydration failed")

    try:
        yield
    finally:
        ap = app.state.autopilot
        task = ap.get("task")
        if task and not task.done():
            # Ask the loop to exit cleanly first; its finally block sends one
            # last "stop" while http is still open. If it doesn't exit in 5s
            # (stuck in a Gemini call etc.), cancel and move on.
            ap["running"] = False
            try:
                await asyncio.wait_for(task, timeout=5.0)
            except asyncio.TimeoutError:
                task.cancel()
                try:
                    await asyncio.wait_for(task, timeout=2.0)
                except (asyncio.CancelledError, asyncio.TimeoutError):
                    pass
            except asyncio.CancelledError:
                pass
        mq.loop_stop()
        await app.state.http.aclose()
        await app.state.pool.close()


async def _safe_send(ws: WebSocket, topic: str, payload: str) -> None:
    try:
        await ws.send_text(json.dumps({"topic": topic, "payload": payload}))
    except Exception:
        SUBS.get(topic, set()).discard(ws)


async def _record_roomba_event(raw: str) -> None:
    """Persist a `roomba/cmd` MQTT payload into the roomba_events hypertable.

    Payload schema (all strings except `ok`/`ts`):
        { ts, cmd, ok, src, reason?, mode?, goal?, model?, err? }

    Silently drops malformed payloads so a misbehaving publisher can't
    knock the MQTT fan-out off the rails. Bad payloads are logged.
    """
    try:
        ev = json.loads(raw)
    except json.JSONDecodeError:
        log.warning("roomba/cmd payload is not JSON: %r", raw[:120])
        return
    cmd = ev.get("cmd")
    src = ev.get("src", "manual")
    ok = bool(ev.get("ok", False))
    raw_ts = ev.get("ts")
    if not isinstance(cmd, str) or not isinstance(src, str):
        return
    # bool is a subclass of int in Python — exclude it so {"ts": true} doesn't
    # land at epoch 1. Reject NaN/inf so asyncpg doesn't blow up downstream.
    if (
        isinstance(raw_ts, (int, float))
        and not isinstance(raw_ts, bool)
        and math.isfinite(float(raw_ts))
    ):
        ts_value = float(raw_ts)
    else:
        ts_value = time.time()
    try:
        async with app.state.pool.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO roomba_events (ts, cmd, ok, src, reason, mode, goal, model, err)
                VALUES (to_timestamp($1), $2, $3, $4, $5, $6, $7, $8, $9)
                """,
                ts_value,
                cmd,
                ok,
                src,
                ev.get("reason"),
                ev.get("mode"),
                ev.get("goal"),
                ev.get("model"),
                ev.get("err"),
            )
    except Exception:  # noqa: BLE001 — DB hiccups must not break MQTT fan-out
        log.exception("roomba_events insert failed (cmd=%s src=%s)", cmd, src)


async def _hydrate_autopilot_decisions() -> None:
    """Pull recent autopilot rows from DB into the in-memory decision buffer.

    Called once at lifespan startup so /autopilot/status returns the recent
    timeline even right after an api restart (UI was reloading and losing
    the run-trace before this).
    """
    q = """
      SELECT ts, cmd, ok, reason
      FROM roomba_events
      WHERE src = 'autopilot'
      ORDER BY ts DESC
      LIMIT $1
    """
    async with app.state.pool.acquire() as conn:
        rows = await conn.fetch(q, AUTOPILOT_MAX_DECISIONS)
    # rows are newest-first; flip so the in-memory buffer stays oldest-first
    # (matches the append-only convention the live loop writes).
    decisions = [
        {
            "ts": r["ts"].timestamp(),
            "command": r["cmd"],
            "reason": r["reason"] or "",
            "ok": bool(r["ok"]),
        }
        for r in reversed(rows)
    ]
    app.state.autopilot["decisions"] = decisions
    if decisions:
        latest = decisions[-1]
        app.state.autopilot["last_command"] = latest["command"]
        app.state.autopilot["last_reason"] = latest["reason"]


app = FastAPI(lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], allow_methods=["*"], allow_headers=["*"],
)


@app.get("/healthz")
async def healthz() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/history/alpha")
async def history_alpha(seconds: int = 60, ch: int | None = None) -> list[dict[str, Any]]:
    q = """
      SELECT ts, ch, alpha FROM eeg_features
      WHERE ts > now() - ($1::int * INTERVAL '1 second')
      ORDER BY ts ASC
    """
    async with app.state.pool.acquire() as conn:
        rows = await conn.fetch(q, seconds)
    out = [{"ts": r["ts"].isoformat(), "ch": r["ch"], "alpha": r["alpha"]} for r in rows]
    if ch is not None:
        out = [r for r in out if r["ch"] == ch]
    return out


@app.get("/history/roomba")
async def history_roomba(seconds: int = 600, src: str | None = None) -> list[dict[str, Any]]:
    """Return roomba_events from the last `seconds` window.

    Used by the UI on tab load to rehydrate the trajectory + chip strip +
    autopilot timeline after a reload. Pass `src=autopilot` to filter to
    just the Gemini-Robotics decisions.
    """
    q = """
      SELECT ts, cmd, ok, src, reason, mode, goal, model, err
      FROM roomba_events
      WHERE ts > now() - ($1::int * INTERVAL '1 second')
        AND ($2::text IS NULL OR src = $2)
      ORDER BY ts ASC
    """
    async with app.state.pool.acquire() as conn:
        rows = await conn.fetch(q, seconds, src)
    return [
        {
            "ts": r["ts"].timestamp(),
            "cmd": r["cmd"],
            "ok": bool(r["ok"]),
            "src": r["src"],
            "reason": r["reason"],
            "mode": r["mode"],
            "goal": r["goal"],
            "model": r["model"],
            "err": r["err"],
        }
        for r in rows
    ]


@app.get("/history/bands")
async def history_bands(seconds: int = 60, ch: int | None = None) -> list[dict[str, Any]]:
    q = """
      SELECT ts, ch, delta, theta, alpha, beta, gamma FROM eeg_features
      WHERE ts > now() - ($1::int * INTERVAL '1 second')
      ORDER BY ts ASC
    """
    async with app.state.pool.acquire() as conn:
        rows = await conn.fetch(q, seconds)
    out = [
        {
            "ts": r["ts"].isoformat(),
            "ch": r["ch"],
            "delta": r["delta"],
            "theta": r["theta"],
            "alpha": r["alpha"],
            "beta": r["beta"],
            "gamma": r["gamma"],
        }
        for r in rows
    ]
    if ch is not None:
        out = [r for r in out if r["ch"] == ch]
    return out


@app.post("/control/connect")
async def connect_roomba(body: dict[str, Any] | None = None) -> dict[str, Any]:
    """Open the serial port on pi-b's roomba-api. Idempotent."""
    payload = body or {"port": "/dev/ttyACM0", "baud_rate": 9600}
    try:
        r = await app.state.http.post(
            f"{ROOMBA_BASE}/connect",
            json=payload,
            timeout=5.0,
        )
        r.raise_for_status()
        return r.json()
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e


@app.post("/control/disconnect")
async def disconnect_roomba() -> dict[str, Any]:
    try:
        r = await app.state.http.post(f"{ROOMBA_BASE}/disconnect", timeout=5.0)
        r.raise_for_status()
        return r.json()
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e


@app.get("/control/serial_status")
async def serial_status() -> dict[str, Any]:
    """Returns roomba-api connection status (used by UI to know if connect is needed)."""
    try:
        # roomba-api doesn't expose a serial-status endpoint; we detect via /command probe.
        probe = await app.state.http.post(
            f"{ROOMBA_BASE}/command/__probe__",
            timeout=3.0,
        )
        if probe.status_code == 400:
            # 400 = "Serial port not connected" pattern.
            return {"connected": False}
        return {"connected": True}
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e


async def _dispatch_command(
    cmd: str,
    src: str = "manual",
    *,
    reason: str | None = None,
    mode: str | None = None,
    goal: str | None = None,
    model: str | None = None,
) -> bool:
    """Background-task half of /control/{cmd}: hits roomba-api and reports.

    Returns True on success so callers (autopilot) can record the outcome.

    Optional metadata (reason/mode/goal/model) is forwarded to MQTT and then
    into roomba_events, so the autopilot trace is queryable after the fact
    and can be JOINed with eeg_features.
    """
    extra: dict[str, Any] = {}
    if reason: extra["reason"] = reason
    if mode:   extra["mode"]   = mode
    if goal:   extra["goal"]   = goal
    if model:  extra["model"]  = model

    try:
        r = await app.state.http.post(f"{ROOMBA_BASE}/command/{cmd}", timeout=2.0)
        r.raise_for_status()
    except httpx.HTTPError as e:
        log.warning("roomba command %s failed: %s", cmd, e)
        app.state.mq.publish(
            "roomba/cmd",
            json.dumps({"cmd": cmd, "ts": time.time(), "ok": False, "err": str(e), "src": src, **extra}),
            qos=1,
        )
        return False
    app.state.mq.publish(
        "roomba/cmd",
        json.dumps({"cmd": cmd, "ts": time.time(), "ok": True, "src": src, **extra}),
        qos=1,
    )
    return True


@app.post("/control/{cmd}")
async def proxy_control(cmd: str) -> dict[str, Any]:
    """Dispatch a manual Roomba command without blocking on Pi-B.

    The roomba-api on pi-b does a ser.write + 100ms time.sleep to capture
    the Arduino response, so each upstream call roundtrips ~135ms even on
    localhost. Joystick repeat (~280ms) stacked with that latency makes
    manual control feel sluggish. Fire the upstream call into the
    background and ack immediately; the actual outcome is published to
    `roomba/cmd` from `_dispatch_command` once known.
    """
    asyncio.create_task(_dispatch_command(cmd))
    return {"ok": True, "cmd": cmd, "queued": True}


@app.post("/camera/start")
async def camera_start() -> dict[str, Any]:
    try:
        r = await app.state.http.post(f"{ROOMBA_BASE}/camera/start", timeout=5.0)
        r.raise_for_status()
        return r.json()
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e


@app.post("/camera/stop")
async def camera_stop() -> dict[str, Any]:
    try:
        r = await app.state.http.post(f"{ROOMBA_BASE}/camera/stop", timeout=5.0)
        r.raise_for_status()
        return r.json()
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e


@app.get("/camera/stream")
async def camera_stream():
    req = app.state.http.build_request("GET", f"{ROOMBA_BASE}/camera/stream")
    upstream = await app.state.http.send(req, stream=True)
    if upstream.status_code != 200:
        await upstream.aclose()
        raise HTTPException(status_code=502, detail="camera upstream not ready")
    media_type = upstream.headers.get(
        "content-type", "multipart/x-mixed-replace; boundary=frame"
    )

    async def _gen():
        try:
            async for chunk in upstream.aiter_raw():
                yield chunk
        finally:
            await upstream.aclose()

    return StreamingResponse(_gen(), media_type=media_type)


@app.post("/threshold")
async def set_threshold(body: dict[str, Any]) -> dict[str, str]:
    app.state.mq.publish("control/threshold", json.dumps(body), qos=1, retain=True)
    return {"status": "queued"}


AUTOPILOT_VALID_CMDS = {"forward", "left", "right", "back", "stop"}
AUTOPILOT_MAX_DECISIONS = 20
AUTOPILOT_FRAME_TIMEOUT = 4.0
AUTOPILOT_FRAME_MAX_BYTES = 2 * 1024 * 1024  # 2 MB per JPEG, very generous

AUTOPILOT_PROMPT_FREE = (
    "You are the navigation brain of a Roomba robot. You see through its front camera.\n"
    "\n"
    "Step 1 - Analyze the scene: Identify obstacles, walls, open paths, and spatial layout.\n"
    "Step 2 - Decide action: Pick ONE command from the list below.\n"
    "\n"
    "Commands:\n"
    "- forward: Path ahead is clear\n"
    "- left: Turn left to avoid obstacle or explore\n"
    "- right: Turn right to avoid obstacle or explore\n"
    "- back: Too close to obstacle, reverse\n"
    "- stop: Unsafe or unclear situation\n"
    "\n"
    'Respond with ONLY this JSON (no markdown, no extra text):\n'
    '{"command": "<command>", "reason": "<brief scene analysis and why this action>"}'
)

AUTOPILOT_PROMPT_GOAL = (
    "You are the navigation brain of a Roomba robot. You see through its front camera.\n"
    "Your goal: {goal}\n"
    "\n"
    "Step 1 - Analyze the scene: What do you see? Is the goal (or path toward it) visible?\n"
    "Step 2 - Decide action: Move toward the goal while avoiding obstacles.\n"
    "Step 3 - If you have reached the goal, stop.\n"
    "\n"
    "Commands:\n"
    "- forward: Move toward the goal\n"
    "- left: Turn left to find or approach the goal\n"
    "- right: Turn right to find or approach the goal\n"
    "- back: Too close to obstacle, reverse\n"
    "- stop: Goal reached OR unsafe situation\n"
    "\n"
    'Respond with ONLY this JSON (no markdown, no extra text):\n'
    '{{"command": "<command>", "reason": "<what you see and progress toward goal>"}}'
)


async def _grab_jpeg_frame() -> bytes | None:
    """Pull one JPEG frame out of pi-b's MJPEG stream.

    pi-b's roomba-api emits `multipart/x-mixed-replace; boundary=frame`
    parts that carry only `Content-Type: image/jpeg` — *no* `Content-Length`.
    Rather than fight the multipart framing, we just scan the raw byte stream
    for the JPEG **Start-Of-Image** marker `\\xff\\xd8` and the matching
    **End-Of-Image** `\\xff\\xd9`, and slice the complete frame out. This is
    robust to whatever the upstream's boundary formatting happens to be, and
    self-validating (we only return bytes that begin and end with the magic).

    Returns None on any failure — callers should treat it as transient and
    try again on the next tick.
    """
    try:
        req = app.state.http.build_request(
            "GET", f"{ROOMBA_BASE}/camera/stream", timeout=AUTOPILOT_FRAME_TIMEOUT
        )
        upstream = await app.state.http.send(req, stream=True)
    except httpx.HTTPError as e:
        log.warning("autopilot frame fetch failed: %s", e)
        return None
    if upstream.status_code != 200:
        await upstream.aclose()
        return None

    buf = bytearray()
    soi_at = -1

    async def _read_one() -> bytes | None:
        nonlocal soi_at
        async for chunk in upstream.aiter_raw():
            buf.extend(chunk)
            if len(buf) > AUTOPILOT_FRAME_MAX_BYTES * 2:
                return None
            if soi_at < 0:
                soi_at = buf.find(b"\xff\xd8")
                if soi_at < 0:
                    # Drain pre-amble until we see a JPEG start.
                    if len(buf) > 4096:
                        del buf[:-1]
                    continue
            # Look for the matching EOI strictly after the SOI.
            eoi_at = buf.find(b"\xff\xd9", soi_at + 2)
            if eoi_at < 0:
                continue
            return bytes(buf[soi_at : eoi_at + 2])
        return None

    try:
        # Per-iteration deadline: httpx's connect/read timeouts don't cover the
        # async iteration over a streaming body, so a slow-trickling or stalled
        # upstream could hang the autopilot tick. wait_for() bounds the whole pull.
        return await asyncio.wait_for(_read_one(), timeout=AUTOPILOT_FRAME_TIMEOUT)
    except (asyncio.TimeoutError, httpx.HTTPError) as e:
        log.warning("autopilot frame read aborted: %s", e)
        return None
    finally:
        await upstream.aclose()


def _parse_autopilot_response(text: str) -> tuple[str | None, str]:
    """Extract `command` / `reason` from the model's response.

    Mirrors the pi-b reference: tolerant JSON parse with markdown-fence strip,
    then a keyword-search fallback so a malformed turn doesn't stall the loop.
    """
    cleaned = text.strip()
    if cleaned.startswith("```"):
        # Strip leading fence + optional language tag.
        cleaned = cleaned.split("\n", 1)[-1] if "\n" in cleaned else cleaned[3:]
    if cleaned.endswith("```"):
        cleaned = cleaned[:-3]
    cleaned = cleaned.strip()
    if cleaned.lower().startswith("json"):
        cleaned = cleaned[4:].strip()
    # The model sometimes wraps JSON in extra prose; grab the first {...} block.
    if not cleaned.startswith("{"):
        lo = cleaned.find("{")
        hi = cleaned.rfind("}")
        if lo >= 0 and hi > lo:
            cleaned = cleaned[lo : hi + 1]
    try:
        data = json.loads(cleaned)
        cmd = str(data.get("command", "")).lower().strip()
        reason = str(data.get("reason", "")).strip()
        if cmd in AUTOPILOT_VALID_CMDS:
            return cmd, reason
    except (json.JSONDecodeError, AttributeError, TypeError):
        pass
    # Fallback: keyword search with word-boundary so e.g. "background" doesn't
    # match "back".
    low = text.lower()
    for cand in ("forward", "back", "left", "right", "stop"):
        if re.search(rf"\b{cand}\b", low):
            return cand, text[:120].strip()
    return None, ""


def _autopilot_log(state: dict[str, Any], command: str, reason: str, ok: bool) -> None:
    state["decisions"].append(
        {"ts": time.time(), "command": command, "reason": reason, "ok": ok}
    )
    if len(state["decisions"]) > AUTOPILOT_MAX_DECISIONS:
        state["decisions"] = state["decisions"][-AUTOPILOT_MAX_DECISIONS:]


async def _autopilot_loop() -> None:
    """Background loop: frame → Gemini Robotics → command, until stopped."""
    state = app.state.autopilot
    cfg = state["config"]
    prompt = (
        AUTOPILOT_PROMPT_GOAL.format(goal=cfg["goal"])
        if cfg["mode"] == "goal" and cfg["goal"]
        else AUTOPILOT_PROMPT_FREE
    )
    # Reuse the existing genai client (built with GEMINI_API_KEY at startup).
    client = app.state.genai
    model = cfg["model"]

    try:
        while state["running"]:
            try:
                frame = await _grab_jpeg_frame()
                if not frame:
                    state["last_error"] = "no camera frame"
                    await asyncio.sleep(1.0)
                    continue

                contents = [
                    gtypes.Content(
                        role="user",
                        parts=[
                            gtypes.Part(inline_data=gtypes.Blob(mime_type="image/jpeg", data=frame)),
                            gtypes.Part(text=prompt),
                        ],
                    ),
                ]
                # Mirror the bash example: thinking=LOW + googleSearch tool.
                # LOW keeps latency reasonable for a ~3s cadence. If a future
                # SDK rename drops these symbols we log once and fall back to
                # a plain config rather than silently dropping the features.
                config_kwargs: dict[str, Any] = {"temperature": 0.3}
                try:
                    config_kwargs["thinking_config"] = gtypes.ThinkingConfig(thinking_level="LOW")
                except (AttributeError, TypeError) as e:
                    log.warning("autopilot: ThinkingConfig unavailable (%s); disabling", e)
                try:
                    config_kwargs["tools"] = [gtypes.Tool(google_search=gtypes.GoogleSearch())]
                except (AttributeError, TypeError) as e:
                    log.warning("autopilot: googleSearch tool unavailable (%s); disabling", e)

                resp = await client.aio.models.generate_content(
                    model=model,
                    contents=contents,
                    config=gtypes.GenerateContentConfig(**config_kwargs),
                )
                text = resp.text or ""
                command, reason = _parse_autopilot_response(text)

                if not command:
                    state["last_error"] = f"parse error: {text[:120]}"
                    _autopilot_log(state, "error", state["last_error"], False)
                else:
                    ok = await _dispatch_command(
                        command,
                        src="autopilot",
                        reason=reason,
                        mode=cfg["mode"],
                        goal=cfg["goal"] or None,
                        model=model,
                    )
                    state["last_command"] = command
                    state["last_reason"] = reason
                    state["last_error"] = None if ok else "dispatch failed"
                    _autopilot_log(state, command, reason, ok)
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001 — keep loop alive on any error
                log.exception("autopilot iteration failed")
                state["last_error"] = str(e)[:200]
                _autopilot_log(state, "error", state["last_error"], False)

            await asyncio.sleep(max(1.0, float(cfg["interval"])))
    except asyncio.CancelledError:
        pass
    finally:
        state["running"] = False
        # Safety: when we stop, the robot stops too.
        await _dispatch_command("stop", src="autopilot")


@app.post("/autopilot/start")
async def autopilot_start(body: dict[str, Any] | None = None) -> dict[str, Any]:
    if app.state.genai is None:
        raise HTTPException(status_code=503, detail="GEMINI_API_KEY not set on the api service")
    ap = app.state.autopilot

    body = body or {}
    try:
        interval = float(body.get("interval", ap["config"]["interval"]))
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="interval must be a number") from None
    interval = max(1.0, min(30.0, interval))
    mode = body.get("mode") or "free"
    if mode not in ("free", "goal"):
        raise HTTPException(status_code=400, detail="mode must be 'free' or 'goal'")
    goal = str(body.get("goal") or "")[:200]
    model = str(body.get("model") or GEMINI_ROBOTICS_MODEL)[:80]

    # Lock-guard: two concurrent /autopilot/start POSTs both pass the
    # `running` check before either flips it, so without the lock both
    # would launch a loop and the second would orphan the first task.
    async with ap["lock"]:
        if ap["running"]:
            return {"status": "already_running", "config": ap["config"]}

        # Make sure the camera is actually streaming — autopilot needs frames.
        try:
            await app.state.http.post(f"{ROOMBA_BASE}/camera/start", timeout=5.0)
        except httpx.HTTPError:
            # Non-fatal: the loop will surface a "no camera frame" error if needed.
            pass

        ap["config"] = {"interval": interval, "mode": mode, "goal": goal, "model": model}
        ap["last_command"] = None
        ap["last_reason"] = None
        ap["last_error"] = None
        ap["decisions"] = []
        ap["running"] = True
        ap["task"] = asyncio.create_task(_autopilot_loop())
        return {"status": "started", "config": ap["config"]}


@app.post("/autopilot/stop")
async def autopilot_stop() -> dict[str, Any]:
    ap = app.state.autopilot
    async with ap["lock"]:
        if not ap["running"]:
            return {"status": "not_running"}
        ap["running"] = False
        task = ap.get("task")
    # The await happens outside the lock so /status calls don't queue behind
    # a slow Gemini iteration cooling down.
    if task and not task.done():
        # Prefer cooperative exit; the loop checks ap["running"] each tick
        # and its finally sends one last "stop". Cancel only if it's stuck.
        try:
            await asyncio.wait_for(task, timeout=5.0)
        except asyncio.TimeoutError:
            task.cancel()
            try:
                await asyncio.wait_for(task, timeout=2.0)
            except (asyncio.CancelledError, asyncio.TimeoutError):
                pass
        except asyncio.CancelledError:
            pass
    ap["task"] = None
    return {"status": "stopped"}


@app.get("/autopilot/status")
async def autopilot_status() -> dict[str, Any]:
    ap = app.state.autopilot
    return {
        "running": ap["running"],
        "config": ap["config"],
        "last_command": ap["last_command"],
        "last_reason": ap["last_reason"],
        "last_error": ap["last_error"],
        "decisions": ap["decisions"],
        "model_available": app.state.genai is not None,
    }


SYSTEM_INSTRUCTION = (
    "You are the operator assistant for eeg_roomba — a 3-node pipeline that "
    "reads 16-channel EEG from a PiEEG, computes band power, and drives a "
    "Roomba based on an alpha-power decision rule. You receive a JSON snapshot "
    "of the live system state with each user message. Answer concisely and "
    "factually about the data you can see; if the user asks about historical "
    "trends you cannot observe from the snapshot, say so. Reply in the user's "
    "language (Japanese or English). Band powers are in μV²-derived units."
)


CHAT_MAX_MESSAGES = 40
CHAT_MAX_TEXT_BYTES = 4 * 1024
CHAT_MAX_CONTEXT_BYTES = 4 * 1024
ANALYZE_MAX_IMAGE_BYTES = 4 * 1024 * 1024  # 4 MB after base64 decode
# Whitelist of context keys we accept. Anything else is dropped before the
# snapshot is inlined into the prompt.
CHAT_CONTEXT_KEYS = {"pieegOnline", "roombaOk", "decisionState", "threshold", "bandsNow"}


@app.post("/chat")
async def chat(body: dict[str, Any]) -> dict[str, Any]:
    """Multi-turn chat with a Gemini-backed assistant.

    Body: { messages: [{role: "user"|"model", text: str}], context: {...} }
    Returns: { text: str }
    """
    if app.state.genai is None:
        raise HTTPException(status_code=503, detail="GEMINI_API_KEY not set on the api service")

    msgs = body.get("messages") or []
    if not isinstance(msgs, list) or not msgs:
        raise HTTPException(status_code=400, detail="messages must be a non-empty array")
    if len(msgs) > CHAT_MAX_MESSAGES:
        msgs = msgs[-CHAT_MAX_MESSAGES:]

    raw_context = body.get("context") or {}
    context = {k: raw_context.get(k) for k in CHAT_CONTEXT_KEYS if k in raw_context}
    snap = json.dumps(context, ensure_ascii=False, default=str)[:CHAT_MAX_CONTEXT_BYTES]

    contents = []
    for m in msgs:
        role = "user" if m.get("role") == "user" else "model"
        text = str(m.get("text", ""))[:CHAT_MAX_TEXT_BYTES]
        if text:
            contents.append(gtypes.Content(role=role, parts=[gtypes.Part(text=text)]))

    if not contents:
        raise HTTPException(status_code=400, detail="no non-empty messages")

    # Inject the live state snapshot as a leading part on the latest user turn
    # so the model always sees the freshest state, not whatever was true 10
    # turns ago.
    if contents[-1].role == "user":
        contents[-1].parts.insert(0, gtypes.Part(text=f"[live snapshot] {snap}\n\n"))

    try:
        resp = await app.state.genai.aio.models.generate_content(
            model=GEMINI_MODEL,
            contents=contents,
            config=gtypes.GenerateContentConfig(
                system_instruction=SYSTEM_INSTRUCTION,
                temperature=0.4,
            ),
        )
    except Exception:
        log.exception("gemini call failed")
        raise HTTPException(status_code=502, detail="upstream model call failed") from None

    return {"text": resp.text or ""}


ANALYZE_INSTRUCTION = (
    "You are looking at a screenshot of the pieeg analysis tab from eeg_roomba — "
    "a live EEG dashboard. The tab contains these panels: EEG live (16-channel "
    "sparklines), Topography (electrode map coloured by band power), Band power "
    "60s (time-series of δ θ α β γ for one selected channel), PSD (Welch spectrum), "
    "Bands (current power of each band for the selected channel), Per-channel "
    "bands (16 mini bar groups), Channel correlation (16×16 Pearson matrix), "
    "Cognitive metrics (Engagement / α-β ratio / Frontal α asymmetry). "
    "In ONE Japanese sentence (max 80 chars), describe the current brain state "
    "visible in the screenshot. Then on a new line, write `根拠: ` followed by "
    "the panel name(s) you read it from (comma separated). Keep it tight."
)


@app.post("/analyze-eeg")
async def analyze_eeg(body: dict[str, Any]) -> dict[str, Any]:
    """One-shot multimodal analysis of a screenshot of the pieeg tab.

    Body: { image: "data:image/png;base64,..." | "<base64>", mime?: "image/png" }
    Returns: { text: str }
    """
    if app.state.genai is None:
        raise HTTPException(status_code=503, detail="GEMINI_API_KEY not set on the api service")

    img = body.get("image")
    if not isinstance(img, str) or not img:
        raise HTTPException(status_code=400, detail="image (base64) required")

    mime = body.get("mime") or "image/png"
    # Strip optional data-URL prefix.
    if img.startswith("data:"):
        try:
            head, img = img.split(",", 1)
            if ";base64" in head and ":" in head:
                mime = head.split(":", 1)[1].split(";", 1)[0] or mime
        except ValueError:
            raise HTTPException(status_code=400, detail="malformed data URL") from None

    try:
        raw = base64.b64decode(img, validate=True)
    except (binascii.Error, ValueError):
        raise HTTPException(status_code=400, detail="image is not valid base64") from None
    if len(raw) > ANALYZE_MAX_IMAGE_BYTES:
        raise HTTPException(status_code=413, detail=f"image > {ANALYZE_MAX_IMAGE_BYTES} bytes")

    contents = [
        gtypes.Content(
            role="user",
            parts=[
                gtypes.Part(inline_data=gtypes.Blob(mime_type=mime, data=raw)),
                gtypes.Part(text="この pieeg ダッシュボードの今の脳波状態を一言で説明してください。"),
            ],
        ),
    ]

    try:
        resp = await app.state.genai.aio.models.generate_content(
            model=GEMINI_MODEL,
            contents=contents,
            config=gtypes.GenerateContentConfig(
                system_instruction=ANALYZE_INSTRUCTION,
                temperature=0.3,
            ),
        )
    except Exception:
        log.exception("gemini analyze call failed")
        raise HTTPException(status_code=502, detail="upstream model call failed") from None

    return {"text": resp.text or ""}


@app.websocket("/ws")
async def ws(ws: WebSocket) -> None:
    await ws.accept()
    # Subscribe to all topics by default; client can ignore unwanted.
    for s in SUBS.values():
        s.add(ws)
    try:
        while True:
            # The client doesn't need to send; just keep the connection alive.
            await ws.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        for s in SUBS.values():
            s.discard(ws)
