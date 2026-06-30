from __future__ import annotations

from app.cluster.digest import compute_digest
from app.storage.accounting import ensure_storage_settings


def test_digest_endpoint_requires_cluster_token(master_session, app_client):
    c, _csrf, _ = master_session
    state = app_client[1]

    assert c.get("/cluster/digest").status_code == 401
    r = c.get("/cluster/digest", headers={"Authorization": f"Bearer {state.cluster_token}"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert "hash" in body and "members" in body and "global_quota" in body
    # A lone node's membership is just itself.
    assert body["members"] == [state.node_id]


def test_digest_hash_changes_with_shared_state(app_client):
    _c, state = app_client
    before = compute_digest(state.session_factory, state.settings)["hash"]
    with state.session_factory() as s:
        storage = ensure_storage_settings(s)
        storage.global_storage_quota_bytes = storage.global_storage_quota_bytes + 1
        s.commit()
    after = compute_digest(state.session_factory, state.settings)["hash"]
    assert before != after  # divergent shared state ⇒ divergent digest ⇒ alertable
