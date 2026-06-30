from __future__ import annotations

from app.models.cluster_node import ClusterNode


def _token(state) -> str:
    return state.cluster_token


def test_peer_can_join_and_appears_in_membership(master_session, app_client):
    c, csrf, _pw = master_session
    state = app_client[1]
    token = _token(state)

    payload = {
        "node_id": "peer-abc",
        "name": "peer-one",
        "base_url": "https://peer.example.com/",
        "token": "peer-token-xyz",
        "is_master": False,
        "archive_enabled": False,
        "replication_mode": "cache",
        "disk_total_bytes": 1000,
        "disk_free_bytes": 400,
        "used_bytes": 600,
    }
    r = c.post("/cluster/join", json=payload,
               headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 200, r.text
    body = r.json()
    # The joiner learns this node's identity and the (currently empty) peer list.
    assert body["self"]["node_id"] == state.node_id
    assert body["self"]["is_master"] is True
    assert body["peers"] == []

    # The peer is now a linked node, keyed by its stable node_id, capabilities kept.
    with state.session_factory() as s:
        node = s.query(ClusterNode).filter_by(node_id="peer-abc").one()
        assert node.base_url == "https://peer.example.com"
        assert node.archive_enabled is False
        assert node.replication_mode == "cache"
        assert node.is_master is False


def test_join_is_idempotent_by_node_id(master_session, app_client):
    c, _csrf, _pw = master_session
    state = app_client[1]
    token = _token(state)
    payload = {
        "node_id": "peer-dup", "name": "p", "base_url": "https://p.example.com",
        "token": "t",
    }
    for _ in range(3):
        assert c.post("/cluster/join", json=payload,
                      headers={"Authorization": f"Bearer {token}"}).status_code == 200
    with state.session_factory() as s:
        assert s.query(ClusterNode).filter_by(node_id="peer-dup").count() == 1


def test_join_rejects_bad_cluster_token(master_session, app_client):
    c, _csrf, _pw = master_session
    payload = {"node_id": "x", "name": "x", "base_url": "https://x", "token": "t"}
    r = c.post("/cluster/join", json=payload,
               headers={"Authorization": "Bearer wrong-token"})
    assert r.status_code == 401


def test_cluster_self_reports_identity_and_role(master_session, app_client):
    c, _csrf, _pw = master_session
    state = app_client[1]
    r = c.get("/cluster/self")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["node_id"] == state.node_id
    assert body["role"] == "master"
    assert body["is_master"] is True
    assert body["halts"] == []


def test_backend_logs_lists_servers_for_filter(master_session):
    c, _csrf, _pw = master_session
    r = c.get("/admin/backend/logs")
    assert r.status_code == 200, r.text
    body = r.json()
    # The server filter dropdown is populated from this; self is always present.
    assert "servers" in body and len(body["servers"]) >= 1
    assert "entries" in body


def test_heartbeat_updates_stats_and_returns_self(master_session, app_client):
    c, _csrf, _pw = master_session
    state = app_client[1]
    token = _token(state)
    base = {"node_id": "hb-node", "name": "hb", "base_url": "https://hb.example.com",
            "token": "t"}
    c.post("/cluster/join", json=base, headers={"Authorization": f"Bearer {token}"})

    hb = {**base, "disk_total_bytes": 5000, "disk_free_bytes": 1234, "used_bytes": 3766}
    r = c.post("/cluster/heartbeat", json=hb,
               headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 200
    assert r.json()["node_id"] == state.node_id
    with state.session_factory() as s:
        node = s.query(ClusterNode).filter_by(node_id="hb-node").one()
        assert node.disk_free_bytes == 1234
        assert node.used_bytes == 3766
        assert node.last_heartbeat_at is not None
