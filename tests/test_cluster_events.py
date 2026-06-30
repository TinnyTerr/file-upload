from __future__ import annotations

import time

from app.audit.log import record
from app.models.audit import AuditEntry
from app.models.cluster_event import ClusterEvent
from app.observability.events import event_bus


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


def test_duplicate_origin_seq_does_not_break_the_request(app_client):
    """Regression: a colliding (origin_node_id, origin_seq) in the mirror must not
    poison the caller's transaction. Before the SAVEPOINT fix this surfaced as a
    login 500 ("PendingRollbackError ... UNIQUE constraint failed: cluster_events")
    whenever two writers (e.g. multiple workers, or a restart that reset the seq)
    reused a seq value."""
    _c, state = app_client

    with state.session_factory() as s:
        before = s.query(AuditEntry).count()

    # Force the very next published event to reuse a seq that is already stored.
    with state.session_factory() as s:
        record(s, actor="admin", action="test.first", target=None, ip="127.0.0.1")
        s.commit()
    taken_seq = event_bus._seq  # noqa: SLF001 — exercising the collision path

    # Rewind so the next publish re-mints the same seq → mirror insert collides.
    with event_bus._lock:  # noqa: SLF001
        event_bus._seq = taken_seq - 1  # noqa: SLF001

    with state.session_factory() as s:
        record(s, actor="admin", action="test.collision", target=None, ip="127.0.0.1")
        # The collision happens inside record()'s savepoint; the outer commit
        # must still succeed and the audit entry must persist.
        s.commit()

    with state.session_factory() as s:
        after = s.query(AuditEntry).count()
        # Both audit entries landed even though the second's mirror row collided.
        assert after == before + 2


def test_cluster_event_endpoint_requires_master(app_client):
    c, _state = app_client
    # Unauthenticated → not master.
    assert c.get("/audit/cluster").status_code == 401
