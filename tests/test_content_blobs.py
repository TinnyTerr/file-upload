from __future__ import annotations

import hashlib


def _upload(c, csrf, payload: bytes, name="sample.bin", content_type="application/octet-stream", **data):
    form = {"original_filename": name, **{k: str(v) for k, v in data.items() if v is not None}}
    r = c.post(
        "/files/upload",
        files={"file": (name, payload, content_type)},
        data=form,
        headers={"X-CSRF-Token": csrf},
    )
    assert r.status_code == 200, r.text
    return r.json()


def test_duplicate_plain_uploads_share_one_blob_but_count_user_logical_usage(master_session):
    c, csrf, _ = master_session
    payload = b"same logical file"
    first = _upload(c, csrf, payload, "first.txt", "text/plain")
    second = _upload(c, csrf, payload, "second.txt", "text/plain")

    files = c.get("/files/").json()["files"]
    by_id = {f["id"]: f for f in files}

    assert by_id[first["file_id"]]["blob_id"] == by_id[second["file_id"]]["blob_id"]
    assert by_id[first["file_id"]]["hashes"]["sha256"] == hashlib.sha256(payload).hexdigest()

    # User quota is logical/account-level, global storage is physical blob bytes.
    assert c.get("/files/usage").json()["used_bytes"] == len(payload) * 2
    storage = c.get("/admin/storage").json()
    assert storage["used_bytes"] == len(payload)
    assert storage["dedup_saved_bytes"] == len(payload)

    delete_one = c.delete(f"/files/{first['file_id']}", headers={"X-CSRF-Token": csrf})
    assert delete_one.status_code == 200, delete_one.text
    assert c.get(f"/file/{second['slug']}/raw").content == payload
    assert c.get("/admin/storage").json()["used_bytes"] == len(payload)

    delete_two = c.delete(f"/files/{second['file_id']}", headers={"X-CSRF-Token": csrf})
    assert delete_two.status_code == 200, delete_two.text
    assert c.get("/admin/storage").json()["used_bytes"] == 0


def test_download_info_exposes_hash_dropdown_values(master_session):
    c, csrf, _ = master_session
    payload = b"hash me"
    uploaded = _upload(c, csrf, payload, "hash.txt", "text/plain")

    info = c.get(f"/file/{uploaded['slug']}/info")
    assert info.status_code == 200, info.text
    hashes = info.json()["hashes"]

    assert hashes["sha256"] == hashlib.sha256(payload).hexdigest()
    assert hashes["sha1"] == hashlib.sha1(payload).hexdigest()
    assert hashes["md5"] == hashlib.md5(payload).hexdigest()
    assert hashes["blake2b"] == hashlib.blake2b(payload).hexdigest()
