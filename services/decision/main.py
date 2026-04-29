"""decision_svc: α power threshold + hysteresis -> Roomba HTTP control.

Subscribes:
  - eeg/alpha   (per-channel α from feature_svc)
  - control/threshold  (retained: dynamic threshold updates from WebUI)

Publishes:
  - control/state   (idle/active, retained)
  - roomba/cmd      (last command sent, for telemetry)
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import time

import httpx
import paho.mqtt.client as mqtt

log = logging.getLogger("decision")

MQTT_HOST = os.environ.get("MQTT_HOST", "localhost")
MQTT_PORT = int(os.environ.get("MQTT_PORT", "1883"))
ROOMBA_BASE = os.environ.get("ROOMBA_HTTP_BASE", "http://localhost:8000").rstrip("/")
ENTER_TH = float(os.environ.get("ALPHA_ENTER_TH", "10.0"))
EXIT_TH = float(os.environ.get("ALPHA_EXIT_TH", "6.0"))
DWELL_MS = int(os.environ.get("ALPHA_DWELL_MS", "500"))
ALPHA_CHANNELS = [int(x) for x in os.environ.get("ALPHA_CHANNELS", "6,7").split(",")]


class Decider:
    def __init__(self, mq: mqtt.Client, http: httpx.AsyncClient, loop: asyncio.AbstractEventLoop):
        self.mq = mq
        self.http = http
        self.loop = loop
        self.state = "idle"  # idle | active
        self.last_cross_t: float | None = None
        self.enter_th = ENTER_TH
        self.exit_th = EXIT_TH
        self.dwell_ms = DWELL_MS
        self.channels = ALPHA_CHANNELS

    def update_thresholds(self, payload: dict) -> None:
        self.enter_th = float(payload.get("enter", self.enter_th))
        self.exit_th = float(payload.get("exit", self.exit_th))
        self.dwell_ms = int(payload.get("dwell_ms", self.dwell_ms))
        if "channels" in payload:
            self.channels = list(payload["channels"])
        log.info("thresholds: enter=%.2f exit=%.2f dwell=%dms ch=%s",
                 self.enter_th, self.exit_th, self.dwell_ms, self.channels)

    def on_alpha(self, payload: dict) -> None:
        alpha = payload["alpha"]
        # Mean over selected channels (occipital).
        sel = [alpha[c] for c in self.channels if c < len(alpha)]
        if not sel:
            return
        value = sum(sel) / len(sel)
        now = time.monotonic()

        if self.state == "idle":
            if value >= self.enter_th:
                self.last_cross_t = self.last_cross_t or now
                if (now - self.last_cross_t) * 1000 >= self.dwell_ms:
                    self._transition("active", value)
            else:
                self.last_cross_t = None
        else:  # active
            if value <= self.exit_th:
                self.last_cross_t = self.last_cross_t or now
                if (now - self.last_cross_t) * 1000 >= self.dwell_ms:
                    self._transition("idle", value)
            else:
                self.last_cross_t = None

    def _transition(self, new_state: str, value: float) -> None:
        log.info("state %s -> %s (alpha=%.2f)", self.state, new_state, value)
        self.state = new_state
        self.last_cross_t = None
        self.mq.publish(
            "control/state",
            json.dumps({"state": new_state, "alpha": value, "ts": time.time()}),
            qos=1,
            retain=True,
        )
        asyncio.run_coroutine_threadsafe(self._dispatch(new_state), self.loop)

    async def _dispatch(self, state: str) -> None:
        cmd = "0" if state == "active" else "stop"
        url = f"{ROOMBA_BASE}/move/{cmd}"
        try:
            r = await self.http.post(url, timeout=2.0)
            r.raise_for_status()
            self.mq.publish(
                "roomba/cmd",
                json.dumps({"cmd": cmd, "ts": time.time(), "ok": True}),
                qos=1,
            )
        except Exception as e:
            log.warning("Roomba HTTP failed: %s", e)
            self.mq.publish(
                "roomba/cmd",
                json.dumps({"cmd": cmd, "ts": time.time(), "ok": False, "err": str(e)}),
                qos=1,
            )


async def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    loop = asyncio.get_running_loop()
    http = httpx.AsyncClient()
    mq = mqtt.Client(client_id="decision", protocol=mqtt.MQTTv311)
    decider = Decider(mq, http, loop)

    def _on_message(_c, _u, msg):
        try:
            payload = json.loads(msg.payload)
        except Exception:
            return
        if msg.topic == "eeg/alpha":
            decider.on_alpha(payload)
        elif msg.topic == "control/threshold":
            decider.update_thresholds(payload)

    mq.on_message = _on_message
    mq.connect(MQTT_HOST, MQTT_PORT, keepalive=30)
    mq.subscribe([("eeg/alpha", 0), ("control/threshold", 1)])
    mq.loop_start()
    log.info("decision_svc running")

    # Publish current thresholds (retained) so UI sees defaults.
    mq.publish("control/threshold", json.dumps({
        "enter": decider.enter_th, "exit": decider.exit_th,
        "dwell_ms": decider.dwell_ms, "channels": decider.channels,
    }), qos=1, retain=True)

    while True:
        await asyncio.sleep(3600)


if __name__ == "__main__":
    asyncio.run(main())
