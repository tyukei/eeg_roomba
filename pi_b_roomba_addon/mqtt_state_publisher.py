"""Pi-B side-car: publish Roomba state to MQTT.

Polls the existing FastAPI service (`/state` if available, else just heartbeat)
and publishes `roomba/state` at 1 Hz with retain. Drop into the same Pi as the
existing roomba_arudino_raspberrypi_client repo and run via systemd.
"""
from __future__ import annotations

import json
import logging
import os
import socket
import time

import httpx
import paho.mqtt.client as mqtt

MQTT_HOST = os.environ.get("MQTT_HOST", "analysis-pc.local")
MQTT_PORT = int(os.environ.get("MQTT_PORT", "1883"))
ROOMBA_BASE = os.environ.get("ROOMBA_HTTP_BASE", "http://localhost:8000").rstrip("/")
HOST_ID = socket.gethostname()

log = logging.getLogger("roomba-state")


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    c = mqtt.Client(client_id=f"roomba-{HOST_ID}", protocol=mqtt.MQTTv311)
    c.will_set("roomba/state", json.dumps({"host": HOST_ID, "online": False}).encode(),
               qos=1, retain=True)
    c.connect(MQTT_HOST, MQTT_PORT, keepalive=30)
    c.loop_start()

    with httpx.Client(timeout=2.0) as http:
        while True:
            online = False
            extra: dict = {}
            try:
                r = http.get(f"{ROOMBA_BASE}/")
                online = r.status_code < 500
                try:
                    extra = r.json()
                except Exception:
                    pass
            except httpx.HTTPError as e:
                log.warning("Roomba probe failed: %s", e)

            payload = {"host": HOST_ID, "online": online, "ts": time.time(), **extra}
            c.publish("roomba/state", json.dumps(payload), qos=1, retain=True)
            time.sleep(1.0)


if __name__ == "__main__":
    main()
