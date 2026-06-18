import pytest
from fastapi.testclient import TestClient

from app.main import create_app


@pytest.fixture
def client(tmp_path):
    app = create_app(config_path=str(tmp_path / "app.env"),
                     database_url="sqlite:///:memory:")
    with TestClient(app) as c:
        yield c, app.state.app_state


def _login(c, pw, username="admin"):
    return c.post("/auth/login", json={"username": username, "password": pw})


def test_change_credentials_clears_flag(client):
    c, state = client
    csrf = _login(c, state.bootstrap_password).json()["csrf_token"]
    resp = c.post("/account/change-credentials",
                  headers={"X-CSRF-Token": csrf},
                  json={"new_username": "axo", "current_password": state.bootstrap_password,
                        "new_password": "a-brand-new-strong-pass"})
    assert resp.status_code == 200
    # Old creds no longer work; new ones do, with flag cleared.
    assert _login(c, state.bootstrap_password).status_code == 401
    new_login = _login(c, "a-brand-new-strong-pass", username="axo")
    assert new_login.status_code == 200
    assert new_login.json()["must_change_credentials"] is False


def test_flagged_account_blocked_from_other_endpoints(client):
    c, state = client
    csrf = _login(c, state.bootstrap_password).json()["csrf_token"]
    # /account/me is gated by require_active_user and must be blocked pre-change.
    resp = c.get("/account/me")
    assert resp.status_code == 403


def test_wrong_current_password_rejected(client):
    c, state = client
    csrf = _login(c, state.bootstrap_password).json()["csrf_token"]
    resp = c.post("/account/change-credentials",
                  headers={"X-CSRF-Token": csrf},
                  json={"new_username": "axo", "current_password": "wrong",
                        "new_password": "whatever-strong"})
    assert resp.status_code == 401
