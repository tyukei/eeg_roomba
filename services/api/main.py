"""WebUI backend: FastAPI + WebSocket proxy to MQTT, REST for history & control."""
from __future__ import annotations

import asyncio
import json
import logging
import os
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Any

import asyncpg
import httpx
import paho.mqtt.client as mqtt
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse

log = logging.getLogger("api")

MQTT_HOST = os.environ.get("MQTT_HOST", "localhost")
MQTT_PORT = int(os.environ.get("MQTT_PORT", "1883"))
ROOMBA_BASE = os.environ.get("ROOMBA_HTTP_BASE", "http://localhost:8000").rstrip("/")

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


@app.post("/control/{cmd}")
async def proxy_control(cmd: str) -> dict[str, Any]:
    try:
        r = await app.state.http.post(f"{ROOMBA_BASE}/command/{cmd}", timeout=2.0)
        r.raise_for_status()
        return {"ok": True, "cmd": cmd}
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=str(e))


@app.post("/camera/start")
async def camera_start() -> dict[str, Any]:
    try:
        r = await app.state.http.post(f"{ROOMBA_BASE}/camera/start", timeout=5.0)
        r.raise_for_status()
        return r.json()
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=str(e))


@app.post("/camera/stop")
async def camera_stop() -> dict[str, Any]:
    try:
        r = await app.state.http.post(f"{ROOMBA_BASE}/camera/stop", timeout=5.0)
        r.raise_for_status()
        return r.json()
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=str(e))


@app.get("/camera/stream")
async def camera_stream():
    async def _gen():
        async with httpx.AsyncClient() as client:
            async with client.stream("GET", f"{ROOMBA_BASE}/camera/stream", timeout=None) as r:
                async for chunk in r.aiter_bytes(4096):
                    yield chunk
    return StreamingResponse(_gen(), media_type="multipart/x-mixed-replace; boundary=frame")


@app.post("/threshold")
async def set_threshold(body: dict[str, Any]) -> dict[str, str]:
    app.state.mq.publish("control/threshold", json.dumps(body), qos=1, retain=True)
    return {"status": "queued"}


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
