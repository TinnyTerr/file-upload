from __future__ import annotations


def _upload(c, csrf, payload: bytes, name: str, content_type="application/octet-stream", **data):
    form = {"original_filename": name, **{k: str(v) for k, v in data.items() if v is not None}}
    r = c.post(
        "/files/upload",
        files={"file": (name, payload, content_type)},
        data=form,
        headers={"X-CSRF-Token": csrf},
    )
    assert r.status_code == 200, r.text
    return r.json()


def test_admin_storage_includes_fun_stats_and_source_breakdowns(master_session):
    c, csrf, _ = master_session
    first = _upload(c, csrf, b"same", "same-a.txt", "text/plain")
    _upload(c, csrf, b"same", "same-b.txt", "text/plain")
    big = _upload(c, csrf, b"x" * 32, "big.bin")

    assert c.get(f"/file/{first['slug']}/raw").status_code == 200
    assert c.get(f"/file/{first['slug']}/raw").status_code == 200

    storage = c.get("/admin/storage")
    assert storage.status_code == 200, storage.text
    body = storage.json()
    stats = body["fun_stats"]

    assert body["dedup_saved_bytes"] == len(b"same")
    assert stats["dedup_saved_bytes"] == len(b"same")
    assert stats["top_downloaded_files"][0]["filename"] == "same-a.txt"
    assert stats["top_downloaded_files"][0]["downloads"] == 2
    assert stats["biggest_files"][0]["filename"] == "big.bin"
    assert stats["top_storage_users"][0]["username"] == "admin"
    assert stats["source_type_counts"]["upload"] == 3
    assert stats["file_type_counts"]["text/plain"]["count"] == 2
    assert stats["file_type_counts"]["application/octet-stream"]["bytes"] == 32
    assert big["file_id"] in {f["id"] for f in stats["biggest_files"]}
