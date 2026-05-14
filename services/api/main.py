"""WebUI backend: FastAPI + WebSocket proxy to MQTT, REST for history & control."""
from __future__ import annotations

import asyncio
import json
import logging
import os
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
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash-lite")

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

    loop = asyncio.get_running_loop()
    mq = mqtt.Client(client_id="api", protocol=mqtt.MQTTv311)

    def _on_message(_c, _u, msg):
        text = msg.payload.decode("utf-8", errors="replace")
        targets = list(SUBS.get(msg.topic, ()))
        for ws in targets:
            asyncio.run_coroutine_threadsafe(_safe_send(ws, msg.topic, text), loop)

    mq.on_message = _on_message
    mq.connect(MQTT_HOST, MQTT_PORT, keepalive=30)
    for topic in SUBS:
        mq.subscribe(topic, qos=0)
    mq.loop_start()
    app.state.mq = mq

    try:
        yield
    finally:
        mq.loop_stop()
        await app.state.http.aclose()
        await app.state.pool.close()


async def _safe_send(ws: WebSocket, topic: str, payload: str) -> None:
    try:
        await ws.send_text(json.dumps({"topic": topic, "payload": payload}))
    except Exception:
        SUBS.get(topic, set()).discard(ws)


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


async def _dispatch_command(cmd: str) -> None:
    """Background-task half of /control/{cmd}: hits roomba-api and reports."""
    try:
        r = await app.state.http.post(f"{ROOMBA_BASE}/command/{cmd}", timeout=2.0)
        r.raise_for_status()
    except httpx.HTTPError as e:
        log.warning("roomba command %s failed: %s", cmd, e)
        app.state.mq.publish(
            "roomba/cmd",
            json.dumps({"cmd": cmd, "ts": time.time(), "ok": False, "err": str(e), "src": "manual"}),
            qos=1,
        )
        return
    app.state.mq.publish(
        "roomba/cmd",
        json.dumps({"cmd": cmd, "ts": time.time(), "ok": True, "src": "manual"}),
        qos=1,
    )


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
