"""feature_svc: subscribes eeg/chunk -> Welch PSD -> MQTT eeg/alpha + DB.

Sliding window 1.0s, hop 0.25s. Per-channel α (8-13Hz), θ (4-8Hz), β (13-30Hz)
band integrals from Welch PSD. Notch 50/60Hz applied via IIR.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
from collections import deque
from datetime import UTC, datetime

import asyncpg
import numpy as np
import paho.mqtt.client as mqtt
from scipy.signal import butter, iirnotch, sosfiltfilt, welch

log = logging.getLogger("feature")

SRATE = 250
NCH = 16
WIN_SEC = 1.0
HOP_SEC = 0.25
WIN_N = int(SRATE * WIN_SEC)
HOP_N = int(SRATE * HOP_SEC)

DELTA = (1.0, 4.0)
THETA = (4.0, 8.0)
ALPHA = (8.0, 13.0)
BETA = (13.0, 30.0)
GAMMA = (30.0, 45.0)

MQTT_HOST = os.environ.get("MQTT_HOST", "localhost")
MQTT_PORT = int(os.environ.get("MQTT_PORT", "1883"))
NOTCH_HZ = float(os.environ.get("LINE_FREQ", "50"))


def _filters():
    sos_hp = butter(3, 1.0, btype="highpass", fs=SRATE, output="sos")
    sos_lp = butter(5, 40.0, btype="lowpass", fs=SRATE, output="sos")
    b_n, a_n = iirnotch(NOTCH_HZ, 30.0, fs=SRATE)
    return sos_hp, sos_lp, (b_n, a_n)


def _band_power(freqs: np.ndarray, psd: np.ndarray, lo: float, hi: float) -> np.ndarray:
    mask = (freqs >= lo) & (freqs <= hi)
    return np.trapezoid(psd[..., mask], freqs[mask], axis=-1)


def _dsn() -> str:
    return (
        f"postgres://{os.environ['POSTGRES_USER']}:{os.environ['POSTGRES_PASSWORD']}"
        f"@{os.environ['POSTGRES_HOST']}:{os.environ['POSTGRES_PORT']}/{os.environ['POSTGRES_DB']}"
    )


class FeatureWorker:
    def __init__(self, mq: mqtt.Client, pool: asyncpg.Pool, loop: asyncio.AbstractEventLoop):
        self.mq = mq
        self.pool = pool
        self.loop = loop
        self.buf: deque[tuple[float, list[float]]] = deque(maxlen=WIN_N * 4)
        self.sos_hp, self.sos_lp, (self.bn, self.an) = _filters()
        self.samples_since_emit = 0

    def on_chunk(self, ts: list[float], samples: list[list[float]]) -> None:
        for t, s in zip(ts, samples):
            self.buf.append((t, s))
            self.samples_since_emit += 1
        while self.samples_since_emit >= HOP_N and len(self.buf) >= WIN_N:
            self._emit()
            self.samples_since_emit -= HOP_N

    def _emit(self) -> None:
        from scipy.signal import filtfilt

        window = list(self.buf)[-WIN_N:]
        ts_end = window[-1][0]
        x = np.asarray([s for _, s in window], dtype="float32")  # [N, ch]
        x = x - x.mean(axis=0, keepdims=True)
        x = sosfiltfilt(self.sos_hp, x, axis=0)
        x = sosfiltfilt(self.sos_lp, x, axis=0)
        x = filtfilt(self.bn, self.an, x, axis=0)

        freqs, psd = welch(x, fs=SRATE, nperseg=min(256, x.shape[0]), axis=0)
        # psd shape: [F, ch]
        psd_t = psd.T  # [ch, F]
        delta = _band_power(freqs, psd_t, *DELTA)
        theta = _band_power(freqs, psd_t, *THETA)
        alpha = _band_power(freqs, psd_t, *ALPHA)
        beta = _band_power(freqs, psd_t, *BETA)
        gamma = _band_power(freqs, psd_t, *GAMMA)

        payload = {
            "ts": ts_end,
            "delta": delta.tolist(),
            "theta": theta.tolist(),
            "alpha": alpha.tolist(),
            "beta": beta.tolist(),
            "gamma": gamma.tolist(),
        }
        self.mq.publish("eeg/alpha", json.dumps(payload), qos=0, retain=True)
        asyncio.run_coroutine_threadsafe(
            self._persist(ts_end, delta, theta, alpha, beta, gamma), self.loop
        )

    async def _persist(
        self,
        ts: float,
        delta: np.ndarray,
        theta: np.ndarray,
        alpha: np.ndarray,
        beta: np.ndarray,
        gamma: np.ndarray,
    ) -> None:
        t = datetime.fromtimestamp(ts, tz=UTC)
        rows = [
            (t, ch, float(delta[ch]), float(theta[ch]), float(alpha[ch]),
             float(beta[ch]), float(gamma[ch]))
            for ch in range(NCH)
        ]
        async with self.pool.acquire() as conn:
            await conn.copy_records_to_table(
                "eeg_features",
                records=rows,
                columns=["ts", "ch", "delta", "theta", "alpha", "beta", "gamma"],
            )


async def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    pool = await asyncpg.create_pool(_dsn(), min_size=1, max_size=2)
    loop = asyncio.get_running_loop()

    mq = mqtt.Client(client_id="feature", protocol=mqtt.MQTTv311)
    worker = FeatureWorker(mq, pool, loop)

    def _on_message(_c, _u, msg):
        try:
            data = json.loads(msg.payload)
            worker.on_chunk(data["ts"], data["samples"])
        except Exception as e:
            log.exception("decode error: %s", e)

    mq.on_message = _on_message
    mq.connect(MQTT_HOST, MQTT_PORT, keepalive=30)
    mq.subscribe("eeg/chunk", qos=0)
    mq.loop_start()
    log.info("feature_svc running, win=%ds hop=%dms", WIN_SEC, int(HOP_SEC * 1000))

    while True:
        await asyncio.sleep(3600)


if __name__ == "__main__":
    asyncio.run(main())
