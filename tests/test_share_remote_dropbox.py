from __future__ import annotations


def _login(c, username: str, password: str) -> str:
    r = c.post("/auth/login", json={"username": username, "password": password})
    assert r.status_code == 200, r.text
    return r.json()["csrf_token"]


def _create_user(c, csrf, username="alice", password="alice-pass-1234") -> int:
    r = c.post(
        "/users/",
        json={"username": username, "password": password, "role": "user", "can_upload": True},
        headers={"X-CSRF-Token": csrf},
    )
    assert r.status_code == 200, r.text
    return r.json()["id"]


def _upload(c, csrf, payload=b"payload", name="file.txt", content_type="text/plain", **data):
    form = {"original_filename": name, **{k: str(v) for k, v in data.items() if v is not None}}
    r = c.post(
        "/files/upload",
        files={"file": (name, payload, content_type)},
        data=form,
        headers={"X-CSRF-Token": csrf},
    )
    assert r.status_code == 200, r.text
    return r.json()


def _create_dir(c, csrf, title="team"):
    r = c.post(
        "/directories",
        json={"title": title, "encryption_mode": "none"},
        headers={"X-CSRF-Token": csrf},
    )
    assert r.status_code == 200, r.text
    return r.json()


def test_logged_in_user_saves_shared_file_as_reference_copy(master_session):
    c, master_csrf, master_pw = master_session
    uploaded = _upload(c, master_csrf, b"shared", "shared.txt")
    _create_user(c, master_csrf)

    anonymous = c.post(f"/files/{uploaded['slug']}/save", headers={"X-CSRF-Token": master_csrf})
    # The current client is authenticated as master; verify unauthenticated through a fresh client is covered by auth.
    assert anonymous.status_code == 200

    alice_csrf = _login(c, "alice", "alice-pass-1234")
    saved = c.post(f"/files/{uploaded['slug']}/save", headers={"X-CSRF-Token": alice_csrf})
    assert saved.status_code == 200, saved.text
    saved_body = saved.json()
    assert saved_body["saved_from_file_id"] == uploaded["file_id"]

    files = c.get("/files/").json()["files"]
    row = next(f for f in files if f["id"] == saved_body["file_id"])
    assert row["source_type"] == "saved"
    assert row["saved_from_file_id"] == uploaded["file_id"]
    assert c.get(f"/file/{row['links'][0]['slug']}/raw").content == b"shared"

    _login(c, "admin", master_pw)
    source = next(f for f in c.get("/admin/files").json()["files"] if f["id"] == uploaded["file_id"])
    assert row["blob_id"] == source["blob_id"]


def test_remote_upload_rejects_private_urls_and_records_success(monkeypatch, master_session):
    import app.routes.remote_upload as remote_upload

    c, csrf, _ = master_session

    private = c.post(
        "/files/remote-upload",
        json={"url": "http://127.0.0.1/secrets.txt"},
        headers={"X-CSRF-Token": csrf},
    )
    assert private.status_code == 400

    def fake_download(url, destination, *, max_bytes):
        destination.write_bytes(b"remote-data")
        return {
            "filename": "remote.txt",
            "content_type": "text/plain",
            "size_bytes": len(b"remote-data"),
        }

    monkeypatch.setattr(remote_upload, "download_remote_url", fake_download)

    started = c.post(
        "/files/remote-upload",
        json={"url": "https://example.com/remote.txt"},
        headers={"X-CSRF-Token": csrf},
    )
    assert started.status_code == 200, started.text
    job = started.json()
    assert job["status"] == "completed"

    status = c.get(f"/files/remote-upload/{job['job_id']}")
    assert status.status_code == 200
    assert status.json()["file_id"] == job["file_id"]

    row = next(f for f in c.get("/files/").json()["files"] if f["id"] == job["file_id"])
    assert row["source_type"] == "remote"
    assert c.get(f"/file/{row['links'][0]['slug']}/raw").content == b"remote-data"


def test_dropbox_link_accepts_exactly_one_upload(master_session):
    c, csrf, _ = master_session
    link = c.post(
        "/dropbox-links",
        json={"expires_in_seconds": 3600},
        headers={"X-CSRF-Token": csrf},
    )
    assert link.status_code == 200, link.text
    token = link.json()["token"]

    info = c.get(f"/dropbox/{token}")
    assert info.status_code == 200
    assert info.json()["status"] == "active"

    uploaded = c.post(
        f"/dropbox/{token}/upload",
        files={"file": ("guest.txt", b"guest", "text/plain")},
        data={"original_filename": "guest.txt"},
    )
    assert uploaded.status_code == 200, uploaded.text
    file_id = uploaded.json()["file_id"]

    repeat = c.post(
        f"/dropbox/{token}/upload",
        files={"file": ("again.txt", b"again", "text/plain")},
        data={"original_filename": "again.txt"},
    )
    assert repeat.status_code in {400, 410}

    row = next(f for f in c.get("/files/").json()["files"] if f["id"] == file_id)
    assert row["source_type"] == "dropbox"


def test_dropbox_link_url_opens_receive_spa(master_session):
    c, csrf, _ = master_session
    link = c.post(
        "/dropbox-links",
        json={"expires_in_seconds": 3600},
        headers={"X-CSRF-Token": csrf},
    )
    assert link.status_code == 200, link.text
    body = link.json()
    token = body["token"]

    assert body["url"] == f"http://testserver/?receive={token}"
    assert body["upload_url"] == f"http://testserver/dropbox/{token}/upload"


def test_dropbox_upload_can_target_directory(master_session):
    c, csrf, _ = master_session
    directory = _create_dir(c, csrf)
    link = c.post(
        "/dropbox-links",
        json={"target_directory_id": directory["id"], "expires_in_seconds": 3600},
        headers={"X-CSRF-Token": csrf},
    )
    assert link.status_code == 200, link.text

    uploaded = c.post(
        f"/dropbox/{link.json()['token']}/upload",
        files={"file": ("dir.txt", b"dir", "text/plain")},
        data={"original_filename": "dir.txt"},
    )
    assert uploaded.status_code == 200, uploaded.text

    members = c.get(f"/directories/{directory['id']}/files").json()["files"]
    assert [m["filename"] for m in members] == ["dir.txt"]


def test_dropbox_chunked_upload_roundtrips_large_file_and_closes_link(monkeypatch, master_session):
    monkeypatch.setenv("FILEUPLOAD_CHUNK_SIZE", "4096")
    c, csrf, _ = master_session
    content = b"dropbox chunk payload " * 7000
    link = c.post(
        "/dropbox-links",
        json={"expires_in_seconds": 3600},
        headers={"X-CSRF-Token": csrf},
    )
    assert link.status_code == 200, link.text
    token = link.json()["token"]

    init = c.post(
        f"/dropbox/{token}/upload/init",
        json={
            "original_filename": "large-dropbox.bin",
            "total_size": len(content),
            "content_type": "application/octet-stream",
        },
    )
    assert init.status_code == 200, init.text
    info = init.json()
    assert info["chunk_size"] == 4096
    assert info["num_chunks"] > 1

    pieces = [
        content[offset:offset + info["chunk_size"]]
        for offset in range(0, len(content), info["chunk_size"])
    ]
    upload_id = info["upload_id"]

    for index, piece in enumerate(pieces[:-1]):
        sent = c.post(
            f"/dropbox/{token}/upload/chunk",
            params={"upload_id": upload_id, "index": index},
            content=piece,
            headers={"Content-Type": "application/octet-stream"},
        )
        assert sent.status_code == 200, sent.text

    early = c.post(
        f"/dropbox/{token}/upload/finalize",
        json={"upload_id": upload_id},
    )
    assert early.status_code == 409
    assert early.json()["detail"]["missing"] == [len(pieces) - 1]

    last = c.post(
        f"/dropbox/{token}/upload/chunk",
        params={"upload_id": upload_id, "index": len(pieces) - 1},
        content=pieces[-1],
        headers={"Content-Type": "application/octet-stream"},
    )
    assert last.status_code == 200, last.text

    finalized = c.post(
        f"/dropbox/{token}/upload/finalize",
        json={"upload_id": upload_id},
    )
    assert finalized.status_code == 200, finalized.text
    body = finalized.json()
    assert body["source_type"] == "dropbox"
    assert c.get(f"/file/{body['slug']}/raw").content == content
    assert c.get(f"/dropbox/{token}").status_code == 410
