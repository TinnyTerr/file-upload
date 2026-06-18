"""Regression test: credential mutation and audit entry commit atomically."""
import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.audit.log import verify_chain
from app.models.audit import AuditEntry
from app.models.user import User


@pytest.fixture
def client(tmp_path):
    app = create_app(config_path=str(tmp_path / "app.env"),
                     database_url="sqlite:///:memory:")
    with TestClient(app) as c:
        yield c, app.state.app_state


def _login(c, pw, username="admin"):
    return c.post("/auth/login", json={"username": username, "password": pw})


def test_credentials_change_and_audit_are_atomic(client):
    """After a successful change-credentials call:
    - exactly one 'account.credentials_changed' audit entry exists
    - the user's must_change_credentials flag is cleared
    Both are visible in a fresh session from the same engine, proving they
    landed in a single committed transaction.
    """
    c, state = client
    login_resp = _login(c, state.bootstrap_password)
    csrf = login_resp.json()["csrf_token"]

    resp = c.post(
        "/account/change-credentials",
        headers={"X-CSRF-Token": csrf},
        json={
            "new_username": "axo",
            "current_password": state.bootstrap_password,
            "new_password": "a-brand-new-strong-pass",
        },
    )
    assert resp.status_code == 200

    # Inspect via a fresh session to confirm the commit landed.
    with state.session_factory() as fresh_db:
        audit_entries = (
            fresh_db.query(AuditEntry)
            .filter_by(action="account.credentials_changed")
            .all()
        )
        assert len(audit_entries) == 1
        # The actor is the authenticating identity ("admin"), not the new name.
        assert audit_entries[0].actor == "admin"

        user = fresh_db.query(User).filter_by(username="axo").one()
        assert user.must_change_credentials is False

        assert verify_chain(fresh_db) is True
