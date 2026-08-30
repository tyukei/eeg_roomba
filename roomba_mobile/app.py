"""Standalone smartphone controller for the Roomba on Pi-B.

Deliberately independent of the EEG pipeline: no MQTT, no TimescaleDB, no
LLM, no autopilot.  The only moving parts are a serial link to the Arduino,
an optional USB-camera MJPEG feed, and the touch UI served from `static/`.

The HTTP paths match the `roomba_api.py` this replaces, so anything that
already talks to Pi-B (the EEG stack's `services/api`, the MQTT state
publisher) keeps working against the same URLs.
"""

from __future__ import annotations

import logging
import os
import threading
import time
from contextlib import asynccontextmanager
from typing import Any

import serial
import serial.tools.list_ports
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

try:
    import cv2
except Exception:  # camera is optional; the controller works without it
    cv2 = None

log = logging.getLogger("roomba_mobile")

HERE = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(HERE, "static")

# Arduino command chars — must stay in sync with roomba.ino's switch table.
COMMAND_CHARS = {
    "forward": b"0",
    "right": b"1",
    "left": b"2",
    "back": b"3",
    "stop": b"s",
    "clean": b"c",
    "pause": b"p",
    "dock": b"d",
}
# These leave the Roomba driving until something else stops it.
MOVE_COMMANDS = {"forward", "right", "left", "back"}
SENSOR_CHAR = b"i"
BOOLEAN_SENSORS = {"bump_left", "bump_right", "wall", "cliff"}

SERIAL_PORT = os.environ.get("ROOMBA_SERIAL_PORT", "")
BAUD_RATE = int(os.environ.get("ROOMBA_BAUD", "9600"))
HTTP_PORT = int(os.environ.get("ROOMBA_HTTP_PORT", "8000"))
# A phone that loses Wi-Fi mid-drive must not leave the Roomba running.
HOLD_TIMEOUT = float(os.environ.get("ROOMBA_HOLD_TIMEOUT_MS", "800")) / 1000.0


class SerialLink:
    """Thread-safe wrapper around the Arduino serial port.

    Every writer (HTTP, WebSocket, watchdog) goes through `send`, so the
    Arduino never sees interleaved bytes from two concurrent requests.
    """

    def __init__(self) -> None:
        self._ser: serial.Serial | None = None
        self._lock = threading.RLock()
        self.port = ""
        self.error = ""
        self.last_response = ""
        self.sensor: dict[str, int | bool] = {}
        self.sensor_ts: float | None = None

    @property
    def is_open(self) -> bool:
        return bool(self._ser and self._ser.is_open)

    def available_ports(self) -> list[str]:
        found = [p.device for p in serial.tools.list_ports.comports()]
        # On Pi-B the Arduino hangs off the GPIO UART, which pyserial does not
        # always enumerate; offer it whenever the device node exists.
        for extra in ("/dev/ttyS0", "/dev/ttyAMA0"):
            if os.path.exists(extra) and extra not in found:
                found.append(extra)
        return found

    def _guess_port(self) -> str:
        ports = self.available_ports()
        for candidate in ports:  # a USB-attached Arduino wins when present
            if "ACM" in candidate or "USB" in candidate:
                return candidate
        return ports[0] if ports else ""

    def connect(self, port: str = "", baud: int = BAUD_RATE) -> str:
        with self._lock:
            self.close()
            target = port or SERIAL_PORT or self._guess_port()
            if not target:
                raise RuntimeError("no serial port available")
            try:
                self._ser = serial.Serial(target, baud, timeout=1)
            except Exception as exc:
                self.error = str(exc)
                raise
            # Opening the port resets the Arduino; commands sent during its
            # bootloader window are silently dropped.
            time.sleep(2)
            self.port = target
            self.error = ""
            return target

    def close(self) -> None:
        with self._lock:
            if self._ser and self._ser.is_open:
                try:
                    self._ser.close()
                except Exception:
                    pass
            self._ser = None
            self.port = ""

    def send(self, char: bytes, settle: float = 0.1) -> str:
        with self._lock:
            if not self.is_open:
                raise RuntimeError("serial port not connected")
            assert self._ser is not None
            self._ser.write(char)
            # The Arduino echoes and then prints; a short settle captures both.
            time.sleep(settle)
            response = ""
            if self._ser.in_waiting > 0:
                response = self._ser.read(self._ser.in_waiting).decode("utf-8", errors="ignore")
            self._record(response)
            return response

    def _record(self, response: str) -> None:
        """Keep the newest Arduino text and decode its `S,key=value` line."""
        if not response:
            return
        self.last_response = response[-1000:]
        for line in reversed(response.splitlines()):
            # The Arduino echoes the command char before replying, so the
            # sensor line arrives as `iS,bump_left=...` rather than starting
            # with `S,`. Anchor on the marker instead of the line start.
            marker = line.find("S,")
            if marker < 0:
                continue
            values: dict[str, int | bool] = {}
            for item in line[marker + 2:].split(","):
                key, sep, raw = item.partition("=")
                if not sep:
                    continue
                try:
                    parsed = int(raw)
                except ValueError:
                    continue
                # -1 is the Arduino's explicit "sensor unavailable" marker.
                if key in BOOLEAN_SENSORS and parsed >= 0:
                    values[key] = bool(parsed)
                else:
                    values[key] = parsed
            if values:
                self.sensor = values
                self.sensor_ts = time.time()
            return


class Driver:
    """Applies commands and stops the Roomba when the phone goes quiet.

    A move command makes the Arduino drive until told otherwise, so a dropped
    connection would leave the Roomba running into furniture.  The UI refreshes
    the move while a button is held; this watchdog turns the *absence* of that
    refresh into a stop.
    """

    def __init__(self, link: SerialLink) -> None:
        self.link = link
        self._moving = False
        self._last_move = 0.0
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        self._stop.clear()
        self._thread = threading.Thread(target=self._watch, daemon=True)
        self._thread.start()

    def shutdown(self) -> None:
        self._stop.set()
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=1.0)
        self._thread = None

    @property
    def moving(self) -> bool:
        return self._moving

    def command(self, cmd: str) -> str:
        char = COMMAND_CHARS.get(cmd)
        if char is None:
            raise KeyError(cmd)
        response = self.link.send(char)
        if cmd in MOVE_COMMANDS:
            self._moving = True
            self._last_move = time.time()
        else:
            self._moving = False
        return response

    def emergency_stop(self) -> None:
        self._moving = False
        try:
            self.link.send(COMMAND_CHARS["stop"])
        except Exception as exc:
            log.warning("emergency stop failed: %s", exc)

    def _watch(self) -> None:
        while not self._stop.wait(0.1):
            if not self._moving or time.time() - self._last_move < HOLD_TIMEOUT:
                continue
            log.info("hold timeout — stopping")
            self.emergency_stop()


def find_capture_device() -> str:
    """Return the first /dev/videoN that actually yields a frame.

    Only 0-9 are probed: on a Pi the higher indices are internal ISP and codec
    nodes, which open successfully but never produce a capture frame.
    """
    if cv2 is None:
        return ""
    for idx in range(10):
        path = f"/dev/video{idx}"
        if not os.path.exists(path):
            continue
        cap = cv2.VideoCapture(path, cv2.CAP_V4L2)
        if not cap.isOpened():
            cap.release()
            continue
        ok, _ = cap.read()
        cap.release()
        if ok:
            return path
    return ""


class CameraStreamer:
    """Grabs JPEG frames on a worker thread and fans them out as MJPEG."""

    def __init__(self) -> None:
        self.cap: Any = None
        self.running = False
        self.device = ""
        self.width = 640
        self.height = 480
        self.fps = 15
        self.quality = 70
        self.error = ""
        self._frame: bytes | None = None
        self._lock = threading.Lock()
        self._thread: threading.Thread | None = None

    def start(self, device: str = "", width: int = 640, height: int = 480,
              fps: int = 15, quality: int = 70) -> None:
        if cv2 is None:
            raise RuntimeError("opencv is not installed")
        if self.running:
            return
        target = device or find_capture_device()
        if not target:
            self.error = "no capture device (/dev/video0-9)"
            raise RuntimeError(self.error)

        cap = cv2.VideoCapture(target, cv2.CAP_V4L2)
        if not cap.isOpened():
            cap.release()
            self.error = f"cannot open {target}"
            raise RuntimeError(self.error)

        # Ask the camera itself for MJPEG at a modest size: decoding a raw
        # stream in Python would peg the Pi's CPU.
        cap.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*"MJPG"))
        cap.set(cv2.CAP_PROP_FRAME_WIDTH, width)
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, height)
        cap.set(cv2.CAP_PROP_FPS, fps)

        self.cap = cap
        self.device = target
        self.width, self.height, self.fps = width, height, fps
        self.quality = max(30, min(90, quality))
        self.error = ""
        self.running = True
        self._thread = threading.Thread(target=self._capture_loop, daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self.running = False
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=1.0)
        self._thread = None
        if self.cap is not None:
            self.cap.release()
        self.cap = None
        with self._lock:
            self._frame = None

    def _capture_loop(self) -> None:
        while self.running and self.cap is not None:
            ok, frame = self.cap.read()
            if not ok:
                time.sleep(0.05)
                continue
            ok, buf = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), self.quality])
            if not ok:
                continue
            with self._lock:
                self._frame = buf.tobytes()
            time.sleep(1.0 / max(1, self.fps))

    def frames(self):
        while self.running:
            with self._lock:
                frame = self._frame
            if frame is None:
                time.sleep(0.05)
                continue
            yield b"--frame\r\nContent-Type: image/jpeg\r\n\r\n" + frame + b"\r\n"
            time.sleep(1.0 / max(1, self.fps))

    def status(self) -> dict[str, Any]:
        return {
            "running": self.running,
            "device": self.device,
            "width": self.width,
            "height": self.height,
            "fps": self.fps,
            "quality": self.quality,
            "opencv_installed": cv2 is not None,
            "available": bool(find_capture_device()) if not self.running else True,
            "error": self.error,
        }


link = SerialLink()
driver = Driver(link)
camera = CameraStreamer()


@asynccontextmanager
async def lifespan(_: FastAPI):
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    driver.start()
    try:
        # Auto-connect so the phone can drive straight away; a missing Arduino
        # must not stop the UI from being served.
        log.info("serial connected on %s", link.connect())
    except Exception as exc:
        log.warning("serial auto-connect failed: %s", exc)
    yield
    camera.stop()
    if link.is_open:
        driver.emergency_stop()
    driver.shutdown()
    link.close()


app = FastAPI(title="Roomba Mobile Controller", lifespan=lifespan)


class ConnectionConfig(BaseModel):
    port: str = ""
    baud_rate: int = BAUD_RATE


def _apply(cmd: str) -> str:
    if cmd not in COMMAND_CHARS:
        raise HTTPException(status_code=400, detail=f"unknown command: {cmd}")
    try:
        return driver.command(cmd)
    except RuntimeError as exc:  # not connected
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/healthz")
def healthz() -> dict[str, Any]:
    return {"ok": True, "connected": link.is_open, "port": link.port}


@app.get("/ports")
def list_ports() -> dict[str, Any]:
    return {"ports": link.available_ports(), "current": link.port}


@app.post("/connect")
def connect_serial(config: ConnectionConfig = ConnectionConfig()) -> dict[str, Any]:
    try:
        port = link.connect(config.port, config.baud_rate)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    return {"status": "connected", "port": port}


@app.post("/disconnect")
def disconnect_serial() -> dict[str, Any]:
    if link.is_open:
        driver.emergency_stop()
    link.close()
    return {"status": "disconnected"}


@app.post("/command/{cmd_type}")
def send_command(cmd_type: str) -> dict[str, Any]:
    response = _apply(cmd_type)
    return {
        "status": "sent",
        "command": cmd_type,
        "char": COMMAND_CHARS[cmd_type].decode(),
        "arduino_response": response,
    }


@app.get("/state")
def state() -> dict[str, Any]:
    """Bridge status plus the latest sensor snapshot; safe to poll from the phone."""
    # A sensor read holds the serial link for ~0.75 s, long enough to stall a
    # held move command past the watchdog. While driving, serve the last
    # snapshot instead of taking the port.
    if link.is_open and not driver.moving:
        try:
            link.send(SENSOR_CHAR, settle=0.75)
        except Exception as exc:
            return {"online": False, "connected": False, "error": str(exc)}
    return {
        "online": link.is_open,
        "connected": link.is_open,
        "port": link.port,
        "moving": driver.moving,
        "sensor": link.sensor,
        "sensor_ts": link.sensor_ts,
        "arduino_response": link.last_response,
        "error": link.error,
    }


@app.post("/camera/start")
def camera_start(device: str = "", width: int = 640, height: int = 480,
                 fps: int = 15, quality: int = 70) -> dict[str, Any]:
    try:
        camera.start(device=device, width=width, height=height, fps=fps, quality=quality)
    except Exception as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return {"status": "started", **camera.status()}


@app.post("/camera/stop")
def camera_stop() -> dict[str, Any]:
    camera.stop()
    return {"status": "stopped"}


@app.get("/camera/status")
def camera_status() -> dict[str, Any]:
    return camera.status()


@app.get("/camera/stream")
def camera_stream() -> StreamingResponse:
    if not camera.running:
        try:
            camera.start()
        except Exception as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
    return StreamingResponse(
        camera.frames(), media_type="multipart/x-mixed-replace; boundary=frame"
    )


@app.websocket("/ws/control")
async def ws_control(ws: WebSocket) -> None:
    """Low-latency command channel; the socket closing is itself a stop."""
    await ws.accept()
    try:
        while True:
            data = await ws.receive_json()
            cmd = data.get("cmd")
            if cmd not in COMMAND_CHARS:
                continue
            try:
                driver.command(cmd)
            except Exception as exc:
                await ws.send_json({"ok": False, "cmd": cmd, "error": str(exc)})
                continue
            await ws.send_json({"ok": True, "cmd": cmd})
    except WebSocketDisconnect:
        driver.emergency_stop()
    except Exception:
        driver.emergency_stop()


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/")
def index() -> FileResponse:
    return FileResponse(os.path.join(STATIC_DIR, "index.html"))


@app.get("/manifest.json")
def manifest() -> FileResponse:
    return FileResponse(os.path.join(STATIC_DIR, "manifest.json"))


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=HTTP_PORT)
