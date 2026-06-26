import pytest
from fastapi import Depends
from fastapi.testclient import TestClient

from app.main import create_app
from app.deps import require_master, require_permission
from app.models.user import User
from app.permissions.policy import ensure_permissions


@pytest.fixture
def client(tmp_path):
    app = create_app(config_path=str(tmp_path / "app.env"),
                     database_url="sqlite:///:memory:")

    @app.get("/_t/master")
    def _master(u: User = Depends(require_master)):
        return {"u": u.username}

    @app.get("/_t/p2p")
    def _p2p(u: User = Depends(require_permission("can_use_p2p"))):
        return {"u": u.username}

    with TestClient(app) as c:
        yield c, app.state.app_state


def _login_and_change(c, state):
    csrf = c.post("/auth/login",
                  json={"username": "admin", "password": state.bootstrap_password}
                  ).json()["csrf_token"]
    c.post("/account/change-credentials", headers={"X-CSRF-Token": csrf},
           json={"new_username": "boss", "current_password": state.bootstrap_password,
                 "new_password": "a-strong-new-password"})
    return csrf


def test_master_passes_master_gate(client):
    c, state = client
    _login_and_change(c, state)
    assert c.get("/_t/master").status_code == 200


def test_permission_denied_when_flag_false(client):
    c, state = client
    _login_and_change(c, state)
    with state.session_factory() as s:
        u = s.query(User).filter_by(username="boss").one()
        p = ensure_permissions(s, u.id)
        p.can_use_p2p = False
        s.commit()
    assert c.get("/_t/p2p").status_code == 403


def test_permission_allows_when_flag_true(client):
    c, state = client
    _login_and_change(c, state)
    with state.session_factory() as s:
        u = s.query(User).filter_by(username="boss").one()
        p = ensure_permissions(s, u.id)
        p.can_use_p2p = True
        s.commit()
    assert c.get("/_t/p2p").status_code == 200
