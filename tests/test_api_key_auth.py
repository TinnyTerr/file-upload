import pytest
from fastapi import Depends
from fastapi.testclient import TestClient

from app.main import create_app
from app.deps import require_api_key
from app.models.user import User
from app.models.api_key import ApiKey
from app.security.api_keys import hash_key


@pytest.fixture
def client(tmp_path):
    app = create_app(config_path=str(tmp_path / "app.env"),
                     database_url="sqlite:///:memory:")

    @app.get("/_t/whoami")
    def _whoami(k: ApiKey = Depends(require_api_key)):
        return {"owner": k.owner_id}

    with TestClient(app) as c:
        yield c, app.state.app_state


def _make_key(state, raw="secret-key-value", bound_ip=None):
    with state.session_factory() as s:
        u = User(username="o", password_hash="x", role="user")
        s.add(u)
        s.flush()
        s.add(ApiKey(owner_id=u.id, key_hash=hash_key(raw), bound_ip=bound_ip))
        s.commit()


def test_missing_header_401(client):
    c, _ = client
    assert c.get("/_t/whoami").status_code == 401


def test_invalid_key_401(client):
    c, state = client
    _make_key(state, raw="real")
    assert c.get("/_t/whoami", headers={"Authorization": "Bearer wrong"}).status_code == 401


def test_first_use_binds_and_succeeds(client):
    c, state = client
    _make_key(state, raw="real")
    r = c.get("/_t/whoami", headers={"Authorization": "Bearer real"})
    assert r.status_code == 200
    with state.session_factory() as s:
        assert s.query(ApiKey).one().bound_ip is not None


def test_bound_to_other_ip_rejected(client):
    c, state = client
    _make_key(state, raw="real", bound_ip="203.0.113.7")
    r = c.get("/_t/whoami", headers={"Authorization": "Bearer real"})
    assert r.status_code == 403
