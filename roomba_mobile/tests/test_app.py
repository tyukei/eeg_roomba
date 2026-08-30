"""Hardware-free tests: the serial port is faked, so these run anywhere."""

import time

import pytest
from fastapi.testclient import TestClient

import app as roomba_app


class FakeSerial:
    """Stands in for `serial.Serial`, recording what the app writes."""

    def __init__(self, *_args, **_kwargs) -> None:
        self.is_open = True
        self.writes: list[bytes] = []
        self.pending = b""

    def write(self, data: bytes) -> int:
        self.writes.append(data)
        if data == roomba_app.SENSOR_CHAR:
            # The real Arduino echoes the command char first, so the sensor
            # line arrives prefixed — `iS,...`, not `S,...`.
            self.pending = (
                b"Received command: 105\r\n"
                b"iS,bump_left=1,bump_right=0,wall=0,cliff=-1,charging_state=2,"
                b"voltage_mv=15000,charge_mah=1200,capacity_mah=2400\r\n"
            )
        return len(data)

    @property
    def in_waiting(self) -> int:
        return len(self.pending)

    def read(self, size: int) -> bytes:
        chunk, self.pending = self.pending[:size], self.pending[size:]
        return chunk

    def close(self) -> None:
        self.is_open = False


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr(roomba_app.serial, "Serial", FakeSerial)
    # Keep the tests quick: the real connect waits out the Arduino's reset.
    monkeypatch.setattr(roomba_app.time, "sleep", lambda _s: None)
    monkeypatch.setattr(roomba_app, "SERIAL_PORT", "/dev/fake")
    with TestClient(roomba_app.app) as test_client:
        yield test_client
    roomba_app.link.close()


def test_healthz_reports_connection(client):
    body = client.get("/healthz").json()
    assert body["ok"] is True
    assert body["connected"] is True


def test_command_writes_the_arduino_char(client):
    assert client.post("/command/forward").json()["char"] == "0"
    assert roomba_app.link._ser.writes[-1] == b"0"


def test_unknown_command_is_rejected(client):
    assert client.post("/command/launch").status_code == 400


def test_state_parses_the_sensor_line(client):
    sensor = client.get("/state").json()["sensor"]
    assert sensor["bump_left"] is True
    assert sensor["bump_right"] is False
    # -1 means "unavailable" and must not become a truthy boolean.
    assert sensor["cliff"] == -1
    assert sensor["charge_mah"] == 1200


def test_state_does_not_touch_serial_while_driving(client):
    client.post("/command/forward")
    before = len(roomba_app.link._ser.writes)
    client.get("/state")
    assert len(roomba_app.link._ser.writes) == before


def test_watchdog_stops_an_unrefreshed_move(client, monkeypatch):
    monkeypatch.setattr(roomba_app, "HOLD_TIMEOUT", 0.05)
    roomba_app.driver._last_move = time.time() - 1.0
    roomba_app.driver._moving = True
    deadline = time.time() + 2.0
    while roomba_app.driver.moving and time.time() < deadline:
        time.sleep(0.02)
    assert roomba_app.driver.moving is False
    assert roomba_app.link._ser.writes[-1] == b"s"


def test_websocket_disconnect_stops_the_roomba(client):
    with client.websocket_connect("/ws/control") as ws:
        ws.send_json({"cmd": "forward"})
        assert ws.receive_json() == {"ok": True, "cmd": "forward"}
    assert roomba_app.link._ser.writes[-1] == b"s"


def test_command_without_serial_is_a_400(client):
    client.post("/disconnect")
    assert client.post("/command/forward").status_code == 400
