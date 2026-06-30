from __future__ import annotations

from fastapi.testclient import TestClient

from app.cluster.replication import apply_rows, export_all, identity_hash, serialize_row
from app.main import create_app
from app.models.file import FileObject
from app.models.user import User


def _upload(c, csrf, *, name="repl.bin", body=b"replicated-bytes"):
    r = c.post(
        "/files/upload",
        files={"file": (name, body, "application/octet-stream")},
        data={"original_filename": name, "randomize_filename": "false"},
        headers={"X-CSRF-Token": csrf},
    )
    assert r.status_code == 200, r.text
    return r.json()


def _second_node(tmp_path):
    app = create_app(config_path=str(tmp_path / "node-b.env"), database_url="sqlite:///:memory:")
    return app


# ── serialization / identity unit behaviour ────────────────────────────────────

def test_identity_hash_ignores_volatile_fields(app_client):
    _c, state = app_client
    with state.session_factory() as s:
        admin = s.query(User).first()
        row = serialize_row(admin)["data"]
        h1 = identity_hash("users", row)
        # Mutating a volatile field must not change identity.
        row2 = dict(row, last_seen_at="2099-01-01T00:00:00+00:00")
        assert identity_hash("users", row2) == h1
        # Mutating an identity field must change it.
        row3 = dict(row, username="someone-else")
        assert identity_hash("users", row3) != h1


# ── end-to-end: a file uploaded on node A becomes usable on node B ──────────────

def test_file_replicates_to_a_second_node(master_session, app_client, tmp_path):
    a_client, csrf, _pw = master_session
    a_state = app_client[1]
    up = _upload(a_client, csrf)
    slug = up["slug"]

    # Node A's canonical snapshot (as a peer would pull / receive).
    export = a_client.get(
        "/cluster/export", headers={"Authorization": f"Bearer {a_state.cluster_token}"}
    )
    assert export.status_code == 200
    rows = export.json()["rows"]
    assert any(r["table"] == "files" for r in rows)

    appB = _second_node(tmp_path)
    with TestClient(appB) as b_client:
        b_state = appB.state.app_state
        b_token = b_state.cluster_token

        # Replicate A's rows into B via the cluster endpoint.
        r = b_client.post(
            "/cluster/replicate", json={"rows": rows},
            headers={"Authorization": f"Bearer {b_token}"},
        )
        assert r.status_code == 200, r.text
        assert r.json()["applied"] > 0

        # B now holds the file row and can serve its public info (metadata-only,
        # no bytes needed) — i.e. the file exists cluster-wide.
        with b_state.session_factory() as s:
            assert s.query(FileObject).filter_by(original_filename="repl.bin").count() == 1
        assert b_client.get(f"/file/{slug}/info").status_code == 200

        # Re-applying is idempotent (merge by primary key).
        b_client.post("/cluster/replicate", json={"rows": rows},
                      headers={"Authorization": f"Bearer {b_token}"})
        with b_state.session_factory() as s:
            assert s.query(FileObject).filter_by(original_filename="repl.bin").count() == 1


# ── reserve (announce step) ─────────────────────────────────────────────────────

def test_reserve_detects_conflict(master_session, app_client):
    c, csrf, _pw = master_session
    state = app_client[1]
    token = state.cluster_token
    up = _upload(c, csrf)
    file_id = up["file_id"]

    with state.session_factory() as s:
        f = s.get(FileObject, file_id)
        identity = identity_hash("files", serialize_row(f)["data"])

    headers = {"Authorization": f"Bearer {token}"}
    # Same id + same identity → free (it's the same row).
    ok = c.post("/cluster/reserve", json={"table": "files", "id": file_id, "identity": identity}, headers=headers)
    assert ok.json()["ok"] is True
    # Same id + different identity → conflict.
    bad = c.post("/cluster/reserve", json={"table": "files", "id": file_id, "identity": "deadbeef"}, headers=headers)
    assert bad.json()["ok"] is False
    # Unused id → free.
    free = c.post("/cluster/reserve", json={"table": "files", "id": 999999, "identity": "x"}, headers=headers)
    assert free.json()["ok"] is True


def test_export_requires_cluster_token(master_session):
    c, _csrf, _pw = master_session
    assert c.get("/cluster/export").status_code == 401
