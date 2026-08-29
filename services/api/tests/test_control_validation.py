"""Safety checks for the physical Roomba command proxy."""
from __future__ import annotations

from test_healthz import client  # reuse the no-network FastAPI fixture


def test_control_rejects_unknown_command(client):
    response = client.post("/control/arbitrary-path")
    assert response.status_code == 400
    assert response.json()["detail"] == "Unsupported Roomba command"


def test_control_accepts_cleaning_command(client):
    response = client.post("/control/clean")
    assert response.status_code == 200
    assert response.json()["cmd"] == "clean"
