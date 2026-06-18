import pytest
from fastapi.testclient import TestClient

from app.main import create_app


@pytest.fixture
def client(tmp_path):
    app = create_app(config_path=str(tmp_path / "app.env"),
                     database_url="sqlite:///:memory:")
    with TestClient(app) as c:
        yield c, app.state.app_state


def test_logout_without_csrf_is_rejected(client):
    c, state = client
    c.post("/auth/login", json={"username": "admin", "password": state.bootstrap_password})
    resp = c.post("/auth/logout")  # no X-CSRF-Token
    assert resp.status_code == 403


def test_logout_with_bad_csrf_is_rejected(client):
    c, state = client
    c.post("/auth/login", json={"username": "admin", "password": state.bootstrap_password})
    resp = c.post("/auth/logout", headers={"X-CSRF-Token": "wrong"})
    assert resp.status_code == 403
