from datetime import datetime, timedelta, timezone

from app.db import make_engine, make_session_factory, init_db
from app.models.user import User
from app.security.sessions import SessionManager


def _ctx():
    engine = make_engine("sqlite:///:memory:")
    init_db(engine)
    Session = make_session_factory(engine)
    with Session() as s:
        u = User(username="root", password_hash="x", role="master")
        s.add(u); s.commit()
        uid = u.id
    return Session, uid


def test_create_resolve_destroy():
    Session, uid = _ctx()
    mgr = SessionManager(secret_key="k" * 40, secure=False)
    with Session() as s:
        cookie, csrf = mgr.create(s, uid)
        assert csrf
        row = mgr.resolve(s, cookie)
        assert row is not None and row.user_id == uid and row.csrf_token == csrf
        mgr.destroy(s, cookie)
        assert mgr.resolve(s, cookie) is None


def test_tampered_cookie_resolves_none():
    Session, uid = _ctx()
    mgr = SessionManager(secret_key="k" * 40, secure=False)
    with Session() as s:
        cookie, _ = mgr.create(s, uid)
        assert mgr.resolve(s, cookie + "garbage") is None


def test_cookie_params_respect_secure_flag():
    assert SessionManager("k" * 40, secure=True).cookie_params()["secure"] is True
    assert SessionManager("k" * 40, secure=False).cookie_params()["secure"] is False


def test_malformed_cookie_resolves_none():
    # A structurally invalid (non-base64) cookie must resolve to None and must
    # not raise — exercises the BadData (not just BadSignature) handling.
    Session, uid = _ctx()
    mgr = SessionManager(secret_key="k" * 40, secure=False)
    with Session() as s:
        assert mgr.resolve(s, "!!!not-valid-base64!!!") is None
        mgr.destroy(s, "!!!not-valid-base64!!!")  # must not raise


def test_expired_session_resolves_none():
    Session, uid = _ctx()
    mgr = SessionManager(secret_key="k" * 40, secure=False)
    with Session() as s:
        cookie, _ = mgr.create(s, uid)
        row = mgr.resolve(s, cookie)
        assert row is not None
        # Force the session to be expired, then confirm resolve rejects it.
        row.expires_at = datetime.now(timezone.utc) - timedelta(seconds=1)
        s.commit()
        assert mgr.resolve(s, cookie) is None
