from datetime import datetime, timezone

import pytest
from sqlalchemy import inspect, text

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


def test_legacy_p2p_permission_column_does_not_block_new_rows():
    engine = make_engine("sqlite:///:memory:")
    User.__table__.create(engine)
    created_at = datetime.now(timezone.utc)
    with engine.begin() as conn:
        conn.execute(
            text(
                """
                CREATE TABLE permissions (
                    id INTEGER NOT NULL,
                    user_id INTEGER NOT NULL,
                    can_upload BOOLEAN NOT NULL DEFAULT 1,
                    can_upload_client_encrypted BOOLEAN NOT NULL DEFAULT 0,
                    can_delete BOOLEAN NOT NULL DEFAULT 1,
                    can_regenerate_links BOOLEAN NOT NULL DEFAULT 1,
                    can_use_api_keys BOOLEAN NOT NULL DEFAULT 0,
                    can_use_p2p BOOLEAN NOT NULL,
                    quota_bytes BIGINT NOT NULL DEFAULT 107374182400,
                    max_file_bytes BIGINT NOT NULL DEFAULT 10737418240,
                    archive_after_idle_days INTEGER NOT NULL DEFAULT 5,
                    created_at DATETIME NOT NULL,
                    PRIMARY KEY (id),
                    UNIQUE (user_id),
                    FOREIGN KEY(user_id) REFERENCES users (id)
                )
                """
            )
        )
        conn.execute(
            text(
                """
                INSERT INTO users
                    (id, username, password_hash, role, must_change_credentials, created_at)
                VALUES
                    (1, 'legacy', 'x', 'user', 0, :created_at)
                """
            ),
            {"created_at": created_at},
        )
        conn.execute(
            text(
                """
                INSERT INTO permissions
                    (id, user_id, can_upload, can_upload_client_encrypted, can_delete,
                     can_regenerate_links, can_use_api_keys, can_use_p2p, quota_bytes,
                     max_file_bytes, archive_after_idle_days, created_at)
                VALUES
                    (1, 1, 1, 0, 1, 1, 1, 0, 100, 50, 5, :created_at)
                """
            ),
            {"created_at": created_at},
        )

    init_db(engine)

    permission_columns = {c["name"] for c in inspect(engine).get_columns("permissions")}
    assert "can_use_p2p" not in permission_columns

    s = make_session_factory(engine)()
    existing = get_permissions(s, 1)
    assert existing is not None
    assert existing.can_use_api_keys is True
    assert existing.quota_bytes == 100

    u = _user(s)
    p = ensure_permissions(s, u.id)

    assert p.can_upload is True
    assert p.can_use_api_keys is False
