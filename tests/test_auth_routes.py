import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.deps import AppState


@pytest.fixture
def client(tmp_path):
    app = create_app(config_path=str(tmp_path / "app.env"),
                     database_url="sqlite:///:memory:")
    state: AppState = app.state.app_state
    # Capture the bootstrap password printed at startup.
    with TestClient(app) as c:
        yield c, state


def _login(c, state, username="admin"):
    pw = state.bootstrap_password
    return c.post("/auth/login", json={"username": username, "password": pw})


def test_login_success_sets_cookie_and_flags_change(client):
    c, state = client
    resp = _login(c, state)
    assert resp.status_code == 200
    body = resp.json()
    assert body["must_change_credentials"] is True
    assert body["csrf_token"]
    assert "fu_session" in resp.cookies


def test_login_wrong_password_fails(client):
    c, state = client
    resp = c.post("/auth/login", json={"username": "admin", "password": "nope"})
    assert resp.status_code == 401


def test_lockout_after_five_failures(client):
    c, state = client
    for _ in range(5):
        c.post("/auth/login", json={"username": "admin", "password": "nope"})
    # 6th attempt, even with correct password, is locked out.
    resp = _login(c, state)
    assert resp.status_code == 429


def test_logout_clears_session(client):
    c, state = client
    login = _login(c, state)
    csrf = login.json()["csrf_token"]
    resp = c.post("/auth/logout", headers={"X-CSRF-Token": csrf})
    assert resp.status_code == 200
