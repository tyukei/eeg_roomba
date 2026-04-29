"""ingest_svc: read EEG source -> TimescaleDB + MQTT pass-through for live UI.

The MQTT pass-through is downsampled (every Nth sample) so the WebUI can render
without overwhelming the browser. Raw 250 Hz still goes to TimescaleDB intact.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
from datetime import datetime, timezone

import asyncpg
import paho.mqtt.client as mqtt

from sources import Chunk, EEGSource, FileReplaySource, LSLSource

log = logging.getLogger("ingest")

MQTT_HOST = os.environ.get("MQTT_HOST", "localhost")
MQTT_PORT = int(os.environ.get("MQTT_PORT", "1883"))
LSL_NAME = os.environ.get("LSL_STREAM_NAME", "PiEEG-16")
SOURCE = os.environ.get("EEG_SOURCE", "lsl")  # "lsl" | "file"
REPLAY_PATH = os.environ.get("EEG_REPLAY_PATH", "")
LIVE_DOWNSAMPLE = int(os.environ.get("LIVE_DOWNSAMPLE", "5"))  # 250→50 Hz to UI


def _build_source() -> EEGSource:
    if SOURCE == "file":
        return FileReplaySource(REPLAY_PATH)
    return LSLSource(LSL_NAME)


def _dsn() -> str:
    return (
        f"postgres://{os.environ['POSTGRES_USER']}:{os.environ['POSTGRES_PASSWORD']}"
        f"@{os.environ['POSTGRES_HOST']}:{os.environ['POSTGRES_PORT']}/{os.environ['POSTGRES_DB']}"
    )


async def _writer(pool: asyncpg.Pool, queue: asyncio.Queue[Chunk]) -> None:
    """Drain chunks and COPY them into eeg_raw."""
    while True:
        chunk = await queue.get()
        rows = []
        for sample, ts in zip(chunk.samples, chunk.timestamps):
            t = datetime.fromtimestamp(ts, tz=timezone.utc)
            for ch_idx, uv in enumerate(sample):
                rows.append((t, ch_idx, float(uv)))
        async with pool.acquire() as conn:
            await conn.copy_records_to_table("eeg_raw", records=rows, columns=["ts", "ch", "uv"])


def _mqtt_client() -> mqtt.Client:
    c = mqtt.Client(client_id="ingest", protocol=mqtt.MQTTv311)
    c.connect_async(MQTT_HOST, MQTT_PORT, keepalive=30)
    c.loop_start()
    return c


async def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    src = _build_source()
    log.info("source ready: srate=%s nch=%s", src.srate, src.n_channels)

    pool = await asyncpg.create_pool(_dsn(), min_size=1, max_size=4)
    mq = _mqtt_client()
    queue: asyncio.Queue[Chunk] = asyncio.Queue(maxsize=200)

    asyncio.create_task(_writer(pool, queue))

    loop = asyncio.get_running_loop()

    def _produce() -> None:
        global_i = 0
        for chunk in src.stream():
            try:
                loop.call_soon_threadsafe(queue.put_nowait, chunk)
            except asyncio.QueueFull:
                log.warning("DB queue full, dropping chunk")

            # Full-rate chunk for feature_svc.
            mq.publish(
                "eeg/chunk",
                json.dumps({"ts": chunk.timestamps, "samples": chunk.samples}),
                qos=0,
            )
            # Downsampled chunk for browsers.
            ds_samples = chunk.samples[::LIVE_DOWNSAMPLE]
            ds_ts = chunk.timestamps[::LIVE_DOWNSAMPLE]
            if ds_samples:
                mq.publish(
                    "eeg/live",
                    json.dumps({"ts": ds_ts, "samples": ds_samples}),
                    qos=0,
                )
            global_i += len(chunk.samples)

    await asyncio.to_thread(_produce)


if __name__ == "__main__":
    asyncio.run(main())
