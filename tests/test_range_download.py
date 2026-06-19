from __future__ import annotations


def _upload(c, csrf, content=b"0123456789abcdef"):
    r = c.post(
        "/files/upload",
        files={"file": ("r.bin", content, "application/octet-stream")},
        data={"original_filename": "r.bin"},
        headers={"X-CSRF-Token": csrf},
    )
    return r.json()["slug"]


def test_full_download_200(master_session):
    c, csrf, _ = master_session
    slug = _upload(c, csrf)
    r = c.get(f"/file/{slug}/raw")
    assert r.status_code == 200
    assert r.headers.get("Accept-Ranges") == "bytes"


def test_range_returns_206(master_session):
    c, csrf, _ = master_session
    slug = _upload(c, csrf, b"0123456789abcdef")
    r = c.get(f"/file/{slug}/raw", headers={"Range": "bytes=0-4"})
    assert r.status_code == 206
    assert r.content == b"01234"
    assert r.headers["Content-Range"] == "bytes 0-4/16"


def test_range_to_end(master_session):
    c, csrf, _ = master_session
    slug = _upload(c, csrf, b"hello world")
    r = c.get(f"/file/{slug}/raw", headers={"Range": "bytes=6-"})
    assert r.status_code == 206
    assert r.content == b"world"


def test_range_suffix(master_session):
    c, csrf, _ = master_session
    slug = _upload(c, csrf, b"hello world")
    r = c.get(f"/file/{slug}/raw", headers={"Range": "bytes=-5"})
    assert r.status_code == 206
    assert r.content == b"world"


def test_range_invalid_416(master_session):
    c, csrf, _ = master_session
    slug = _upload(c, csrf, b"hello")
    r = c.get(f"/file/{slug}/raw", headers={"Range": "bytes=10-20"})
    assert r.status_code == 416
