from __future__ import annotations


GB = 1024 ** 3


def _upload(c, csrf, payload=b"x" * 128, name="stored.txt", content_type="text/plain"):
    r = c.post(
        "/files/upload",
        files={"file": (name, payload, content_type)},
        data={"original_filename": name},
        headers={"X-CSRF-Token": csrf},
    )
    return r


def test_storage_details_default_and_rejects_bad_global_cap(master_session):
    c, csrf, _ = master_session

    details = c.get("/admin/storage")
    assert details.status_code == 200, details.text
    body = details.json()
    assert body["global_storage_quota_bytes"] == 500 * GB
    assert body["used_bytes"] == 0
    assert body["allocated_quota_bytes"] >= 100 * GB
    assert "archive_saved_bytes" in body
    assert "users" in body
    assert "lifecycle_counts" in body
    assert "content_type_counts" in body
    assert "storage_summary" in body
    assert "disk" in body
    assert "link_status_counts" in body
    assert "api_key_status_counts" in body
    assert "recent_audit_counts" in body

    below_allocated = c.patch(
        "/admin/storage",
        json={"global_storage_quota_bytes": 99 * GB},
        headers={"X-CSRF-Token": csrf},
    )
    assert below_allocated.status_code == 400


def test_storage_details_returns_chart_ready_aggregates(master_session):
    c, csrf, _ = master_session
    uploaded = _upload(c, csrf, b"png-bytes", "chart.png", "image/png")
    assert uploaded.status_code == 200, uploaded.text
    file_id = uploaded.json()["file_id"]

    files = c.get("/files/").json()["files"]
    link_id = next(f for f in files if f["id"] == file_id)["links"][0]["id"]
    deactivated = c.patch(
        f"/links/{link_id}",
        json={"active": False},
        headers={"X-CSRF-Token": csrf},
    )
    assert deactivated.status_code == 200, deactivated.text

    key = c.post("/keys/", headers={"X-CSRF-Token": csrf})
    assert key.status_code == 200, key.text
    revoked = c.delete(
        f"/keys/{key.json()['id']}",
        headers={"X-CSRF-Token": csrf},
    )
    assert revoked.status_code == 200, revoked.text

    body = c.get("/admin/storage").json()

    assert body["storage_summary"]["used_percent"] >= 0
    assert body["storage_summary"]["allocated_percent"] > 0
    assert body["storage_summary"]["free_under_cap_bytes"] >= 0
    assert body["disk"]["free_bytes"] >= 0
    assert body["link_status_counts"]["inactive"] == 1
    assert body["api_key_status_counts"]["inactive"] == 1
    assert body["content_type_counts"][0]["stored_bytes"] >= len(b"png-bytes")
    assert any(row["action"] == "file.uploaded" for row in body["recent_audit_counts"])
    owner = next(u for u in body["users"] if u["username"] == "admin")
    assert owner["link_count"] == 1
    assert owner["quota_percent"] >= 0


def test_global_storage_cap_blocks_future_uploads(master_session):
    c, csrf, _ = master_session
    master_id = c.get("/account/me").json()["id"]
    quota = c.post(
        f"/users/{master_id}/permissions",
        json={"quota_bytes": 1024, "max_file_bytes": 4096},
        headers={"X-CSRF-Token": csrf},
    )
    assert quota.status_code == 200, quota.text

    cap = c.patch(
        "/admin/storage",
        json={"global_storage_quota_bytes": 1024},
        headers={"X-CSRF-Token": csrf},
    )
    assert cap.status_code == 200, cap.text

    assert _upload(c, csrf, b"a" * 512, "small.txt").status_code == 200
    rejected = _upload(c, csrf, b"b" * 700, "too-much.txt")
    assert rejected.status_code == 413
    assert "global storage" in rejected.json()["detail"]


def test_user_quota_update_cannot_overallocate_global_cap(master_session):
    c, csrf, _ = master_session
    master_id = c.get("/account/me").json()["id"]
    assert c.post(
        f"/users/{master_id}/permissions",
        json={"quota_bytes": 1024, "max_file_bytes": 4096},
        headers={"X-CSRF-Token": csrf},
    ).status_code == 200
    assert c.patch(
        "/admin/storage",
        json={"global_storage_quota_bytes": 1024},
        headers={"X-CSRF-Token": csrf},
    ).status_code == 200

    over = c.post(
        f"/users/{master_id}/permissions",
        json={"quota_bytes": 2048},
        headers={"X-CSRF-Token": csrf},
    )

    assert over.status_code == 400
    assert "global storage" in over.json()["detail"]


def test_global_storage_cap_cannot_exceed_available_disk(master_session, monkeypatch):
    c, csrf, _ = master_session

    class Disk:
        total = 101 * GB
        used = 0
        free = 101 * GB

    monkeypatch.setattr("shutil.disk_usage", lambda _path: Disk())

    too_large = c.patch(
        "/admin/storage",
        json={"global_storage_quota_bytes": 102 * GB},
        headers={"X-CSRF-Token": csrf},
    )

    assert too_large.status_code == 400
    assert "disk space" in too_large.json()["detail"]


def test_user_quota_update_cannot_overallocate_disk_capacity(master_session, monkeypatch):
    c, csrf, _ = master_session
    master_id = c.get("/account/me").json()["id"]

    class Disk:
        total = 101 * GB
        used = 0
        free = 101 * GB

    monkeypatch.setattr("shutil.disk_usage", lambda _path: Disk())

    over = c.post(
        f"/users/{master_id}/permissions",
        json={"quota_bytes": 102 * GB},
        headers={"X-CSRF-Token": csrf},
    )

    assert over.status_code == 400
    assert "disk space" in over.json()["detail"]


def test_manual_archive_and_unarchive_track_saved_bytes(master_session):
    c, csrf, _ = master_session
    payload = b"compress me " * 10_000
    uploaded = _upload(c, csrf, payload, "compressible.txt", "text/plain")
    assert uploaded.status_code == 200, uploaded.text
    file_id = uploaded.json()["file_id"]

    archived = c.post(
        f"/admin/files/{file_id}/archive",
        headers={"X-CSRF-Token": csrf},
    )
    assert archived.status_code == 200, archived.text
    archived_body = archived.json()
    assert archived_body["archived"] is True
    assert archived_body["archive_saved_bytes"] > 0
    assert archived_body["archive_original_stored_size_bytes"] == len(payload)

    details = c.get("/admin/storage").json()
    assert details["archive_saved_bytes"] >= archived_body["archive_saved_bytes"]

    unarchived = c.post(
        f"/admin/files/{file_id}/unarchive",
        headers={"X-CSRF-Token": csrf},
    )
    assert unarchived.status_code == 200, unarchived.text
    assert unarchived.json()["archived"] is False
    assert unarchived.json()["archive_saved_bytes"] == 0
    assert c.get(f"/file/{uploaded.json()['slug']}/raw").content == payload


def test_manual_lifecycle_job_buttons_return_counts(master_session):
    c, csrf, _ = master_session

    for endpoint in (
        "/admin/lifecycle/archive-idle",
        "/admin/lifecycle/temp-expiry",
        "/admin/lifecycle/link-expiry",
        "/admin/lifecycle/reconcile",
    ):
        r = c.post(endpoint, headers={"X-CSRF-Token": csrf})
        assert r.status_code == 200, r.text
        assert "processed" in r.json()
