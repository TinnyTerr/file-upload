from __future__ import annotations

CONTENT = b"top secret server-side payload " * 1000


def _upload_server_encrypted(c, csrf):
    r = c.post(
        "/files/upload",
        files={"file": ("s.bin", CONTENT, "application/octet-stream")},
        data={"original_filename": "s.bin", "encryption_mode": "server"},
        headers={"X-CSRF-Token": csrf},
    )
    assert r.status_code == 200, r.text
    return r.json()


def test_server_upload_returns_access_key(master_session):
    c, csrf, _ = master_session
    data = _upload_server_encrypted(c, csrf)
    assert data["encryption_mode"] == "server"
    assert data["access_key"], "server-mode upload must return an access credential"


def test_download_requires_access_key(master_session):
    c, csrf, _ = master_session
    slug = _upload_server_encrypted(c, csrf)["slug"]
    # No ?ek= → blocked.
    r = c.get(f"/file/{slug}/raw")
    assert r.status_code == 401


def test_download_with_wrong_key_rejected(master_session):
    c, csrf, _ = master_session
    slug = _upload_server_encrypted(c, csrf)["slug"]
    r = c.get(f"/file/{slug}/raw", params={"ek": "definitely-not-the-key"})
    assert r.status_code == 401


def test_download_with_correct_key_decrypts(master_session):
    c, csrf, _ = master_session
    data = _upload_server_encrypted(c, csrf)
    r = c.get(f"/file/{data['slug']}/raw", params={"ek": data["access_key"]})
    assert r.status_code == 200
    assert r.content == CONTENT  # server decrypts transparently with its stored key


def test_wrong_key_does_not_consume_limited_use(master_session):
    c, csrf, _ = master_session
    # Upload server-encrypted with a single-use link.
    r = c.post(
        "/files/upload",
        files={"file": ("s.bin", CONTENT, "application/octet-stream")},
        data={"original_filename": "s.bin", "encryption_mode": "server", "max_uses": "1"},
        headers={"X-CSRF-Token": csrf},
    )
    data = r.json()
    slug, ek = data["slug"], data["access_key"]
    # A failed (wrong-key) attempt must NOT burn the single use.
    assert c.get(f"/file/{slug}/raw", params={"ek": "nope"}).status_code == 401
    # The legitimate download still works.
    ok = c.get(f"/file/{slug}/raw", params={"ek": ek})
    assert ok.status_code == 200
    assert ok.content == CONTENT
    # Now the single use is exhausted.
    assert c.get(f"/file/{slug}/raw", params={"ek": ek}).status_code == 404


def test_access_key_recoverable_in_listing(master_session):
    c, csrf, _ = master_session
    data = _upload_server_encrypted(c, csrf)
    listing = c.get("/files/").json()["files"]
    match = next(f for f in listing if f["id"] == data["file_id"])
    assert match["access_key"] == data["access_key"]


def test_minted_link_carries_access_key(master_session):
    c, csrf, _ = master_session
    data = _upload_server_encrypted(c, csrf)
    minted = c.post(
        f"/files/{data['file_id']}/links",
        json={},
        headers={"X-CSRF-Token": csrf},
    ).json()
    assert minted["encryption_mode"] == "server"
    assert minted["access_key"] == data["access_key"]
    # The freshly minted link works with the same access key.
    r = c.get(f"/file/{minted['slug']}/raw", params={"ek": minted["access_key"]})
    assert r.status_code == 200
    assert r.content == CONTENT
