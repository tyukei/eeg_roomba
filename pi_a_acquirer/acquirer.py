"""Pi-A acquisition daemon: SPI → LSL outlet + MQTT health beacon."""
from __future__ import annotations

import json
import logging
import os
import signal
import socket
import time

import paho.mqtt.client as mqtt
from pylsl import StreamInfo, StreamOutlet, local_clock
from spi_driver import PiEEG16

SRATE = 250
NCH = 16
STREAM_NAME = os.environ.get("LSL_STREAM_NAME", "PiEEG-16")
MQTT_HOST = os.environ.get("MQTT_HOST", "analysis-pc.local")
MQTT_PORT = int(os.environ.get("MQTT_PORT", "1883"))
HOST_ID = socket.gethostname()

log = logging.getLogger("acquirer")


def _build_outlet() -> StreamOutlet:
    info = StreamInfo(
        name=STREAM_NAME,
        type="EEG",
        channel_count=NCH,
        nominal_srate=SRATE,
        channel_format="float32",
        source_id=f"pieeg-{HOST_ID}",
    )
    chans = info.desc().append_child("channels")
    for i in range(NCH):
        ch = chans.append_child("channel")
        ch.append_child_value("label", f"ch{i:02d}")
        ch.append_child_value("unit", "microvolts")
        ch.append_child_value("type", "EEG")
    return StreamOutlet(info, chunk_size=8, max_buffered=360)


def _mqtt_client() -> mqtt.Client:
    c = mqtt.Client(client_id=f"pieeg-{HOST_ID}", protocol=mqtt.MQTTv311)
    will = json.dumps({"host": HOST_ID, "online": False}).encode()
    c.will_set("pieeg/health", will, qos=1, retain=True)
    c.connect_async(MQTT_HOST, MQTT_PORT, keepalive=30)
    c.loop_start()
    return c


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    dev = PiEEG16()
    outlet = _build_outlet()
    mq = _mqtt_client()

    stop = False

    def _sig(*_):
        nonlocal stop
        stop = True

    signal.signal(signal.SIGINT, _sig)
    signal.signal(signal.SIGTERM, _sig)

    log.info("PiEEG-16 acquisition started: %dch @ %d Hz", NCH, SRATE)

    period = 1.0 / SRATE
    next_tick = time.perf_counter()
    last_health = 0.0
    last_count = 0
    last_errs = 0

    while not stop:
        try:
            sample = dev.read_sample()
            outlet.push_sample(sample, timestamp=local_clock())
        except OSError:
            log.warning("SPI read error")
            time.sleep(0.005)
            continue

        now = time.perf_counter()
        if now - last_health >= 1.0:
            stats = dev.stats
            payload = {
                "host": HOST_ID,
                "online": True,
                "samples_total": stats.samples,
                "samples_last_sec": stats.samples - last_count,
                "spi_errors": stats.spi_errors,
                "spi_errors_last_sec": stats.spi_errors - last_errs,
                "lsl_stream": STREAM_NAME,
            }
            mq.publish("pieeg/health", json.dumps(payload), qos=0, retain=True)
            last_count = stats.samples
            last_errs = stats.spi_errors
            last_health = now

        next_tick += period
        sleep = next_tick - time.perf_counter()
        if sleep > 0:
            time.sleep(sleep)
        else:
            # Fell behind; resync to avoid spiral
            next_tick = time.perf_counter()

    log.info("Shutting down")
    mq.publish("pieeg/health", json.dumps({"host": HOST_ID, "online": False}), qos=1, retain=True)
    mq.loop_stop()
    mq.disconnect()
    dev.close()


if __name__ == "__main__":
    main()
