from __future__ import annotations

import io
import zipfile

from app.models.user import User
from app.permissions.policy import ensure_permissions

A = b"first member payload " * 200
B = b"second member, different bytes " * 200


def _create_dir(c, csrf, mode="none", title="My folder"):
    r = c.post(
        "/directories",
        json={"title": title, "encryption_mode": mode},
        headers={"X-CSRF-Token": csrf},
    )
    assert r.status_code == 200, r.text
    return r.json()


def _upload_into(c, csrf, dir_id, name, content, mode):
    r = c.post(
        "/files/upload",
        files={"file": (name, content, "application/octet-stream")},
        data={"original_filename": name, "encryption_mode": mode, "directory_id": str(dir_id)},
        headers={"X-CSRF-Token": csrf},
    )
    assert r.status_code == 200, r.text
    return r.json()


def test_create_plain_directory_and_list(master_session):
    c, csrf, _ = master_session
    d = _create_dir(c, csrf, "none")
    assert d["encryption_mode"] == "none"
    assert d["access_key"] is None
    assert d["url"].endswith("/d/" + d["slug"])

    listing = c.get("/directories/").json()["directories"]
    match = next(x for x in listing if x["id"] == d["id"])
    assert match["file_count"] == 0


def test_directory_info_and_zip_plain(master_session):
    c, csrf, _ = master_session
    d = _create_dir(c, csrf, "none")
    _upload_into(c, csrf, d["id"], "a.txt", A, "none")
    _upload_into(c, csrf, d["id"], "b.txt", B, "none")

    info = c.get(f"/d/{d['slug']}/info").json()
    assert info["file_count"] == 2
    assert {f["filename"] for f in info["files"]} == {"a.txt", "b.txt"}

    # Members must NOT appear in the loose file listing.
    loose = c.get("/files/").json()["files"]
    assert all(f["original_filename"] not in ("a.txt", "b.txt") for f in loose)

    z = c.get(f"/d/{d['slug']}/zip")
    assert z.status_code == 200
    assert z.headers["content-type"] == "application/zip"
    zf = zipfile.ZipFile(io.BytesIO(z.content))
    assert set(zf.namelist()) == {"a.txt", "b.txt"}
    assert zf.read("a.txt") == A
    assert zf.read("b.txt") == B


def test_directory_server_encryption_shared_key(master_session):
    c, csrf, _ = master_session
    d = _create_dir(c, csrf, "server")
    assert d["access_key"], "server folder must return one shared access key"
    f1 = _upload_into(c, csrf, d["id"], "a.bin", A, "server")
    f2 = _upload_into(c, csrf, d["id"], "b.bin", B, "server")

    # Per-file download needs the shared ?ek=; the SAME key works for both files.
    assert c.get(f"/file/{f1['slug']}/raw").status_code == 401
    ok1 = c.get(f"/file/{f1['slug']}/raw", params={"ek": d["access_key"]})
    ok2 = c.get(f"/file/{f2['slug']}/raw", params={"ek": d["access_key"]})
    assert ok1.status_code == 200 and ok1.content == A
    assert ok2.status_code == 200 and ok2.content == B

    # Zip without the key is blocked; with it, it decrypts every member.
    assert c.get(f"/d/{d['slug']}/zip").status_code == 401
    z = c.get(f"/d/{d['slug']}/zip", params={"ek": d["access_key"]})
    assert z.status_code == 200
    zf = zipfile.ZipFile(io.BytesIO(z.content))
    assert zf.read("a.bin") == A and zf.read("b.bin") == B


def test_client_directory_zip_blocked_server_side(master_session):
    c, csrf, _ = master_session
    d = _create_dir(c, csrf, "client")
    # End-to-end bundles can't be assembled server-side (no key) → 400.
    assert c.get(f"/d/{d['slug']}/zip").status_code == 400


def test_delete_directory_removes_members(master_session):
    c, csrf, _ = master_session
    d = _create_dir(c, csrf, "none")
    f1 = _upload_into(c, csrf, d["id"], "a.txt", A, "none")

    r = c.delete(f"/directories/{d['id']}", headers={"X-CSRF-Token": csrf})
    assert r.status_code == 200
    assert r.json()["files_removed"] == 1

    # Directory page, info, and the member's link are all gone.
    assert c.get(f"/d/{d['slug']}/info").status_code == 404
    assert c.get(f"/file/{f1['slug']}/raw").status_code == 404
    assert all(x["id"] != d["id"] for x in c.get("/directories/").json()["directories"])


def test_directory_member_inherits_directory_mode(master_session):
    c, csrf, _ = master_session
    d = _create_dir(c, csrf, "server")
    # Even if the upload claims "none", the directory's mode wins.
    f = _upload_into(c, csrf, d["id"], "x.bin", A, "none")
    assert f["encryption_mode"] == "server"


def test_directory_upload_uses_actual_file_size_for_limit(master_session):
    c, csrf, _ = master_session
    d = _create_dir(c, csrf, "none")
    content = b"x" * 1024

    state = c.app.state.app_state
    with state.session_factory() as db:
        user = db.query(User).filter_by(username="admin").one()
        perm = ensure_permissions(db, user.id, master=True)
        perm.max_file_bytes = len(content)
        db.commit()

    r = c.post(
        "/files/upload",
        files={"file": ("large.bin", content, "application/octet-stream")},
        data={
            "original_filename": "large.bin",
            "encryption_mode": "none",
            "directory_id": str(d["id"]),
        },
        headers={"X-CSRF-Token": csrf},
    )

    assert r.status_code == 200, r.text
    info = c.get(f"/d/{d['slug']}/info").json()
    assert info["files"][0]["filename"] == "large.bin"
    assert info["total_bytes"] == len(content)


def test_directory_member_can_be_listed_and_removed_individually(master_session):
    c, csrf, _ = master_session
    d = _create_dir(c, csrf, "none")
    kept = _upload_into(c, csrf, d["id"], "kept.txt", A, "none")
    removed = _upload_into(c, csrf, d["id"], "removed.txt", B, "none")

    listing = c.get(f"/directories/{d['id']}/files").json()["files"]
    target = next(f for f in listing if f["filename"] == "removed.txt")

    r = c.delete(
        f"/directories/{d['id']}/files/{target['id']}",
        headers={"X-CSRF-Token": csrf},
    )

    assert r.status_code == 200, r.text
    info = c.get(f"/d/{d['slug']}/info").json()
    assert [f["filename"] for f in info["files"]] == ["kept.txt"]
    assert c.get(f"/file/{removed['slug']}/raw").status_code == 404
    assert c.get(f"/file/{kept['slug']}/raw").status_code == 200

    directory = next(x for x in c.get("/directories/").json()["directories"] if x["id"] == d["id"])
    assert directory["file_count"] == 1
    assert directory["total_bytes"] == len(A)
