from __future__ import annotations

import pytest


def _login_master(app_client):
    """Log in as the bootstrap admin and clear must_change_credentials so the
    master-only endpoints are reachable. Returns (client, state, csrf)."""
    c, state = app_client
    pw = state.bootstrap_password
    r = c.post("/auth/login", json={"username": "admin", "password": pw})
    assert r.status_code == 200
    csrf1 = r.json()["csrf_token"]
    new_pw = "masterpass1234"
    c.post(
        "/account/change-credentials",
        json={"current_password": pw, "new_username": "admin", "new_password": new_pw},
        headers={"X-CSRF-Token": csrf1},
    )
    r2 = c.post("/auth/login", json={"username": "admin", "password": new_pw})
    assert r2.status_code == 200
    return c, state, r2.json()["csrf_token"]


def test_cluster_token_generated_and_revealable(app_client):
    c, state, csrf = _login_master(app_client)
    assert state.cluster_token
    r = c.get("/cluster/token")
    assert r.status_code == 200
    assert r.json()["token"] == state.cluster_token


def test_cluster_token_required_for_poll(app_client):
    c, state = app_client
    assert c.get("/admin/cluster/events").status_code == 401
    assert c.get("/admin/cluster/events",
                 headers={"Authorization": "Bearer wrong"}).status_code == 401
    r = c.get("/admin/cluster/events",
              headers={"Authorization": f"Bearer {state.cluster_token}"})
    assert r.status_code == 200
    assert "events" in r.json()


def test_token_rotation_changes_token(app_client):
    c, state, csrf = _login_master(app_client)
    old = state.cluster_token
    r = c.post("/cluster/token/rotate", headers={"X-CSRF-Token": csrf})
    assert r.status_code == 200
    new = r.json()["token"]
    assert new != old
    assert state.cluster_token == new
    # Old token no longer authenticates.
    assert c.get("/admin/cluster/events",
                 headers={"Authorization": f"Bearer {old}"}).status_code == 401


def test_firehose_ws_requires_token(app_client):
    c, state = app_client
    with pytest.raises(Exception):
        with c.websocket_connect("/admin/cluster/firehose?token=nope") as ws:
            ws.receive_json()


def _last_id(c, token):
    r = c.get("/admin/cluster/events", headers={"Authorization": f"Bearer {token}"})
    return r.json()["last_id"]


def test_firehose_ws_receives_all_events(app_client):
    c, state, csrf = _login_master(app_client)
    token = state.cluster_token
    after = _last_id(c, token)  # skip the login/credential-change backlog
    with c.websocket_connect(f"/admin/cluster/firehose?token={token}&after={after}") as ws:
        ready = ws.receive_json()
        assert ready["type"] == "ready"
        # Trigger an event: create an api key (records apikey.created).
        r = c.post("/keys/", headers={"X-CSRF-Token": csrf})
        assert r.status_code == 200
        msg = ws.receive_json()
        assert msg["type"] == "event"
        assert msg["action"] == "apikey.created"


def test_user_ws_rejects_anonymous(app_client):
    c, state = app_client
    with pytest.raises(Exception):
        with c.websocket_connect("/ws/events") as ws:
            ws.receive_json()


def test_user_ws_streams_own_events(app_client):
    c, state, csrf = _login_master(app_client)
    after = _last_id(c, state.cluster_token)
    with c.websocket_connect(f"/ws/events?after={after}") as ws:
        assert ws.receive_json()["type"] == "ready"
        r = c.post("/keys/", headers={"X-CSRF-Token": csrf})
        assert r.status_code == 200
        msg = ws.receive_json()
        assert msg["type"] == "event"
        assert msg["actor"] == "admin"


def test_events_appear_in_backend_logs(app_client):
    c, state, csrf = _login_master(app_client)
    r = c.post("/keys/", headers={"X-CSRF-Token": csrf})
    assert r.status_code == 200
    logs = c.get("/admin/backend/logs", params={"q": "event action=apikey.created"})
    assert logs.status_code == 200
    entries = logs.json()["entries"]
    assert any(
        e["logger"] == "app.event" and "apikey.created" in e["message"]
        for e in entries
    ), entries


def test_poll_replays_recent_with_after_cursor(app_client):
    c, state, csrf = _login_master(app_client)
    token = state.cluster_token
    c.post("/keys/", headers={"X-CSRF-Token": csrf})
    r = c.get("/admin/cluster/events",
              headers={"Authorization": f"Bearer {token}"})
    body = r.json()
    assert body["count"] >= 1
    last = body["last_id"]
    # Nothing new since last_id.
    r2 = c.get(f"/admin/cluster/events?after={last}",
               headers={"Authorization": f"Bearer {token}"})
    assert r2.json()["count"] == 0
