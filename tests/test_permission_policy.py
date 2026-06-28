import pytest

from app.db import make_engine, make_session_factory, init_db
from app.models.user import User
from app.permissions.policy import ensure_permissions, get_permissions, has_permission


def _session():
    engine = make_engine("sqlite:///:memory:")
    init_db(engine)
    return make_session_factory(engine)()


def _user(s, role="user"):
    u = User(username=f"u{role}", password_hash="x", role=role)
    s.add(u)
    s.flush()
    return u


def test_ensure_creates_user_defaults():
    s = _session()
    u = _user(s)
    p = ensure_permissions(s, u.id)
    assert p.can_upload is True
    assert p.can_use_api_keys is False


def test_ensure_master_enables_everything():
    s = _session()
    u = _user(s, role="master")
    p = ensure_permissions(s, u.id, master=True)
    assert p.can_use_api_keys is True
    assert p.can_upload_client_encrypted is True
    assert p.can_view_admin is True


def test_ensure_is_idempotent():
    s = _session()
    u = _user(s)
    first = ensure_permissions(s, u.id)
    first.can_use_api_keys = True
    s.flush()
    second = ensure_permissions(s, u.id)
    assert second.id == first.id
    assert second.can_use_api_keys is True  # not reset


def test_get_returns_none_when_absent():
    s = _session()
    u = _user(s)
    assert get_permissions(s, u.id) is None


def test_has_permission_reads_flag():
    s = _session()
    u = _user(s)
    p = ensure_permissions(s, u.id)
    assert has_permission(p, "can_upload") is True
    assert has_permission(p, "can_use_api_keys") is False


def test_has_permission_unknown_name_raises():
    s = _session()
    u = _user(s)
    p = ensure_permissions(s, u.id)
    with pytest.raises(AttributeError):
        has_permission(p, "can_fly")
