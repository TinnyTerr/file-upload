from __future__ import annotations

import io
import zipfile


def _upload(c, csrf, *, name: str, body: bytes = b"payload"):
    r = c.post(
        "/files/upload",
        files={"file": (name, body, "application/octet-stream")},
        data={"original_filename": name, "randomize_filename": "false"},
        headers={"X-CSRF-Token": csrf},
    )
    assert r.status_code == 200, r.text
    return r.json()


def _my_file_ids(c) -> dict[str, int]:
    files = c.get("/files/").json()["files"]
    return {f["original_filename"]: f["id"] for f in files}


def test_batch_zip_bundles_selected_files(master_session):
    c, csrf, _ = master_session
    _upload(c, csrf, name="a.txt", body=b"alpha")
    _upload(c, csrf, name="b.txt", body=b"bravo")
    ids = _my_file_ids(c)

    r = c.get("/files/batch-zip", params={"ids": [ids["a.txt"], ids["b.txt"]]})
    assert r.status_code == 200, r.text
    assert r.headers["content-type"] == "application/zip"

    zf = zipfile.ZipFile(io.BytesIO(r.content))
    names = set(zf.namelist())
    assert names == {"a.txt", "b.txt"}
    assert zf.read("a.txt") == b"alpha"
    assert zf.read("b.txt") == b"bravo"


def test_batch_zip_requires_ids(master_session):
    c, _csrf, _ = master_session
    assert c.get("/files/batch-zip").status_code == 400


def test_batch_zip_rejects_other_users_file(master_session, app_client):
    c, csrf, _ = master_session
    _upload(c, csrf, name="mine.txt", body=b"x")
    owner_ids = _my_file_ids(c)
    mine = owner_ids["mine.txt"]

    # Create a second, non-master user and log in as them on a fresh client.
    c.post("/users/", json={"username": "bob", "password": "bob-password-123",
                            "role": "user"}, headers={"X-CSRF-Token": csrf})
    state = app_client[1]
    app = None  # use same client, switch session
    r = c.post("/auth/login", json={"username": "bob", "password": "bob-password-123"})
    assert r.status_code == 200
    # bob tries to grab the master's file → 403
    resp = c.get("/files/batch-zip", params={"ids": [mine]})
    assert resp.status_code == 403
    _ = (state, app)
