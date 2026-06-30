from __future__ import annotations

import time

from app.cluster.halt import GLOBAL, halt_registry, user_scope
from app.models.user import User
from app.permissions.policy import ensure_permissions


def _upload(c, csrf, *, name="f.bin", body=b"payload"):
    return c.post(
        "/files/upload",
        files={"file": (name, body, "application/octet-stream")},
        data={"original_filename": name, "randomize_filename": "false"},
        headers={"X-CSRF-Token": csrf},
    )


# ── registry unit behaviour ────────────────────────────────────────────────────

def test_registry_global_and_user_scope_and_expiry():
    halt_registry.reset()
    assert halt_registry.active_until(5) is None

    halt_registry.set_ttl(user_scope(5), 60)
    assert halt_registry.active_until(5) is not None       # halted user
    assert halt_registry.active_until(6) is None           # other user unaffected

    halt_registry.set(GLOBAL, time.time() + 60)
    assert halt_registry.active_until(6) is not None       # global hits everyone

    halt_registry.reset()
    halt_registry.set(GLOBAL, time.time() - 1)             # already expired
    assert halt_registry.active_until(1) is None
    halt_registry.reset()


# ── upload enforcement ─────────────────────────────────────────────────────────

def test_global_halt_blocks_then_clears(master_session):
    c, csrf, _ = master_session
    halt_registry.reset()

    halt_registry.set_ttl(GLOBAL, 60)
    r = _upload(c, csrf)
    assert r.status_code == 423
    assert "Retry-After" in r.headers

    halt_registry.clear(GLOBAL)
    assert _upload(c, csrf).status_code == 200
    halt_registry.reset()


def test_quota_exceed_triggers_user_halt(master_session, app_client):
    c, csrf, _ = master_session
    state = app_client[1]
    halt_registry.reset()

    # A non-master user with a tiny quota.
    c.post("/users/", json={"username": "tina", "password": "tina-password-123",
                            "role": "user"}, headers={"X-CSRF-Token": csrf})
    with state.session_factory() as s:
        u = s.query(User).filter_by(username="tina").one()
        perm = ensure_permissions(s, u.id)
        perm.quota_bytes = 4  # bytes
        perm.max_file_bytes = 10_000
        s.commit()
        uid = u.id

    tc = c.post("/auth/login", json={"username": "tina", "password": "tina-password-123"})
    tcsrf = tc.json()["csrf_token"]

    # First over-quota upload is rejected AND raises a halt for this user.
    r = _upload(c, tcsrf, body=b"way-too-large-for-4-bytes")
    assert r.status_code in (413, 423)
    assert halt_registry.active_until(uid) is not None

    # A subsequent (even tiny) upload is now pre-blocked with 423 until TTL.
    r2 = _upload(c, tcsrf, body=b"x")
    assert r2.status_code == 423
    halt_registry.reset()
