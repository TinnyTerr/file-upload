from __future__ import annotations

from app.models.content_blob import ContentBlob
from app.storage.paths import safe_join, storage_root


def _upload(c, csrf, *, name="blob.bin", body=b"cluster-blob-bytes"):
    r = c.post(
        "/files/upload",
        files={"file": (name, body, "application/octet-stream")},
        data={"original_filename": name, "randomize_filename": "false"},
        headers={"X-CSRF-Token": csrf},
    )
    assert r.status_code == 200, r.text
    return r.json()


def test_blob_endpoint_streams_stored_bytes(master_session, app_client):
    c, csrf, _ = master_session
    state = app_client[1]
    _upload(c, csrf)

    with state.session_factory() as s:
        blob = s.query(ContentBlob).order_by(ContentBlob.id.desc()).first()
        stored_sha = blob.stored_sha256
        transform = blob.transform_key
        on_disk = safe_join(storage_root(), blob.storage_path).read_bytes()

    r = c.get(
        f"/cluster/blobs/{stored_sha}",
        params={"transform": transform},
        headers={"Authorization": f"Bearer {state.cluster_token}"},
    )
    assert r.status_code == 200, r.text
    assert r.content == on_disk
    assert r.headers.get("X-Blob-Stored-Sha256") == stored_sha


def test_blob_endpoint_requires_token(master_session, app_client):
    c, csrf, _ = master_session
    state = app_client[1]
    _upload(c, csrf)
    with state.session_factory() as s:
        stored_sha = s.query(ContentBlob).order_by(ContentBlob.id.desc()).first().stored_sha256

    assert c.get(f"/cluster/blobs/{stored_sha}").status_code == 401


def test_blob_endpoint_unknown_hash_404(master_session, app_client):
    c, _csrf, _ = master_session
    state = app_client[1]
    r = c.get(
        "/cluster/blobs/" + "0" * 64,
        headers={"Authorization": f"Bearer {state.cluster_token}"},
    )
    assert r.status_code == 404
