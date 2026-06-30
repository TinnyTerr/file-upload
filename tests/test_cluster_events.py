from __future__ import annotations

import time

from app.models.cluster_event import ClusterEvent


def _wait_for_events(state, *, minimum: int = 1, timeout: float = 5.0) -> int:
    """The ClusterEvent mirror is written by a background thread, so poll briefly
    for the expected rows to land."""
    deadline = time.time() + timeout
    last = 0
    while time.time() < deadline:
        with state.session_factory() as s:
            last = s.query(ClusterEvent).count()
        if last >= minimum:
            return last
        time.sleep(0.1)
    return last


def test_local_events_are_mirrored_and_tagged(master_session, app_client):
    c, csrf, _pw = master_session
    state = app_client[1]

    # Logging in + changing creds already produced several audited events.
    count = _wait_for_events(state, minimum=1)
    assert count >= 1

    with state.session_factory() as s:
        ev = s.query(ClusterEvent).order_by(ClusterEvent.id.desc()).first()
        # Every event is stamped with this node's identity.
        assert ev.origin_node_id == state.node_id
        assert ev.origin_node_name == state.node_name
        assert ev.origin_seq > 0


def test_cluster_event_endpoint_filters_by_server(master_session, app_client):
    c, csrf, _pw = master_session
    state = app_client[1]
    _wait_for_events(state, minimum=1)

    r = c.get("/audit/cluster")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["entries"]
    # The local node shows up as a selectable server.
    server_ids = {s["node_id"] for s in body["servers"]}
    assert state.node_id in server_ids

    # Filtering by this server returns rows; filtering by an unknown one returns none.
    r_match = c.get("/audit/cluster", params={"server": state.node_id})
    assert r_match.status_code == 200
    assert r_match.json()["filtered_count"] >= 1

    r_none = c.get("/audit/cluster", params={"server": "nonexistent-node"})
    assert r_none.status_code == 200
    assert r_none.json()["filtered_count"] == 0


def test_cluster_event_endpoint_requires_master(app_client):
    c, _state = app_client
    # Unauthenticated → not master.
    assert c.get("/audit/cluster").status_code == 401
