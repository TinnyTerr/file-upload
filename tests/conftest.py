from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.deps import AppState


@pytest.fixture
def app_client(tmp_path):
    app = create_app(
        config_path=str(tmp_path / "app.env"),
        database_url="sqlite:///:memory:",
    )
    state: AppState = app.state.app_state
    with TestClient(app) as c:
        yield c, state


@pytest.fixture
def master_session(app_client):
    c, state = app_client
    bootstrap_pw = state.bootstrap_password
    r = c.post("/auth/login", json={"username": "admin", "password": bootstrap_pw})
    assert r.status_code == 200
    csrf1 = r.json()["csrf_token"]
    new_pw = "masterpass1234"
    c.post(
        "/account/change-credentials",
        json={"current_password": bootstrap_pw, "new_username": "admin", "new_password": new_pw},
        headers={"X-CSRF-Token": csrf1},
    )
    r2 = c.post("/auth/login", json={"username": "admin", "password": new_pw})
    assert r2.status_code == 200
    csrf2 = r2.json()["csrf_token"]
    return c, csrf2, new_pw
