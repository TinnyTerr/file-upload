from __future__ import annotations

from app.models.user import User
from app.permissions.policy import ensure_permissions


def test_master_can_link_and_unlink_node(master_session):
    c, csrf, _pw = master_session

    # Empty to start.
    r = c.get("/cluster/nodes")
    assert r.status_code == 200
    assert r.json()["nodes"] == []

    # Link a node — trailing slash on base_url is normalized away.
    r = c.post(
        "/cluster/nodes",
        json={"name": "eu-west", "base_url": "https://node.example.com/", "token": "remote-secret-token"},
        headers={"X-CSRF-Token": csrf},
    )
    assert r.status_code == 200, r.text
    node = r.json()
    assert node["base_url"] == "https://node.example.com"
    # The raw token is never echoed back; only a masked preview.
    assert "remote-secret-token" not in str(node)
    assert node["token_preview"].endswith("oken")

    node_id = node["id"]
    listed = c.get("/cluster/nodes").json()["nodes"]
    assert len(listed) == 1 and listed[0]["id"] == node_id

    # Unlink.
    r = c.delete(f"/cluster/nodes/{node_id}", headers={"X-CSRF-Token": csrf})
    assert r.status_code == 200
    assert c.get("/cluster/nodes").json()["nodes"] == []


def test_link_rejects_non_http_base_url(master_session):
    c, csrf, _pw = master_session
    r = c.post(
        "/cluster/nodes",
        json={"name": "bad", "base_url": "ftp://nope", "token": "x"},
        headers={"X-CSRF-Token": csrf},
    )
    assert r.status_code == 400


def test_unlink_missing_node_is_404(master_session):
    c, csrf, _pw = master_session
    r = c.delete("/cluster/nodes/9999", headers={"X-CSRF-Token": csrf})
    assert r.status_code == 404


def _make_user(c, csrf, *, username: str, password: str) -> None:
    r = c.post(
        "/users/",
        json={"username": username, "password": password, "role": "user"},
        headers={"X-CSRF-Token": csrf},
    )
    assert r.status_code == 200, r.text


def test_cluster_requires_permission(master_session, app_client):
    c, csrf, _pw = master_session
    _make_user(c, csrf, username="nodefan", password="user-password-123")

    # Fresh client for the non-master user (separate cookie jar would be ideal,
    # but logging in on the same client replaces the session).
    user_csrf = c.post(
        "/auth/login", json={"username": "nodefan", "password": "user-password-123"}
    ).json()["csrf_token"]

    state = app_client[1]
    with state.session_factory() as s:
        u = s.query(User).filter_by(username="nodefan").one()
        perm = ensure_permissions(s, u.id)
        perm.can_manage_cluster = False
        s.commit()
    assert c.get("/cluster/nodes").status_code == 403
    assert c.get("/cluster/token").status_code == 403

    with state.session_factory() as s:
        u = s.query(User).filter_by(username="nodefan").one()
        perm = ensure_permissions(s, u.id)
        perm.can_manage_cluster = True
        s.commit()
    assert c.get("/cluster/nodes").status_code == 200
    r = c.get("/cluster/token")
    assert r.status_code == 200
    assert r.json()["token"] == state.cluster_token
    # unused; kept to mirror the fixture signature
    _ = user_csrf
