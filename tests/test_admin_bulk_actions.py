from __future__ import annotations


def _upload(c, csrf, payload=b"bulk", name="bulk.txt", content_type="text/plain"):
    r = c.post(
        "/files/upload",
        files={"file": (name, payload, content_type)},
        data={"original_filename": name},
        headers={"X-CSRF-Token": csrf},
    )
    assert r.status_code == 200, r.text
    return r.json()


def _file_row(c, file_id: int) -> dict:
    rows = c.get("/admin/files").json()["files"]
    return next(f for f in rows if f["id"] == file_id)


def test_bulk_danger_zone_previews_requires_confirmation_and_deletes_inactive_links(master_session):
    c, csrf, _ = master_session
    first = _upload(c, csrf, name="inactive.txt")
    second = _upload(c, csrf, name="active.txt")
    inactive_link_id = _file_row(c, first["file_id"])["links"][0]["id"]
    active_link_id = _file_row(c, second["file_id"])["links"][0]["id"]

    deactivated = c.patch(
        f"/links/{inactive_link_id}",
        json={"active": False},
        headers={"X-CSRF-Token": csrf},
    )
    assert deactivated.status_code == 200, deactivated.text

    preview = c.post(
        "/admin/bulk/preview",
        json={"action": "delete_inactive_links"},
        headers={"X-CSRF-Token": csrf},
    )
    assert preview.status_code == 200, preview.text
    body = preview.json()
    assert body["affected_count"] == 1
    assert body["confirmation_phrase"] == "CONFIRM 1"

    rejected = c.post(
        "/admin/bulk/run",
        json={"action": "delete_inactive_links", "confirm": "wrong"},
        headers={"X-CSRF-Token": csrf},
    )
    assert rejected.status_code == 400

    run = c.post(
        "/admin/bulk/run",
        json={"action": "delete_inactive_links", "confirm": "CONFIRM 1"},
        headers={"X-CSRF-Token": csrf},
    )
    assert run.status_code == 200, run.text
    assert run.json()["processed_count"] == 1

    remaining_link_ids = {
        link["id"]
        for f in c.get("/admin/files").json()["files"]
        for link in f["links"]
    }
    assert inactive_link_id not in remaining_link_ids
    assert active_link_id in remaining_link_ids
    audit_actions = [e["action"] for e in c.get("/audit/").json()["entries"]]
    assert "bulk.links_deleted" in audit_actions


def test_bulk_danger_zone_revokes_and_resets_api_keys(master_session):
    c, csrf, _ = master_session
    key = c.post("/keys/", headers={"X-CSRF-Token": csrf})
    assert key.status_code == 200, key.text
    raw_key = key.json()["key"]
    key_id = key.json()["id"]

    uploaded = c.post(
        "/files/upload",
        files={"file": ("via-key.txt", b"api", "text/plain")},
        data={"original_filename": "via-key.txt"},
        headers={"Authorization": f"Bearer {raw_key}"},
    )
    assert uploaded.status_code == 200, uploaded.text

    reset_preview = c.post(
        "/admin/bulk/preview",
        json={"action": "reset_api_key_ips", "ids": [key_id]},
        headers={"X-CSRF-Token": csrf},
    )
    assert reset_preview.status_code == 200, reset_preview.text
    assert reset_preview.json()["affected_count"] == 1

    reset = c.post(
        "/admin/bulk/run",
        json={"action": "reset_api_key_ips", "ids": [key_id], "confirm": "CONFIRM 1"},
        headers={"X-CSRF-Token": csrf},
    )
    assert reset.status_code == 200, reset.text
    assert reset.json()["processed_count"] == 1
    key_row = next(k for k in c.get("/admin/keys").json()["keys"] if k["id"] == key_id)
    assert key_row["bound_ip"] is None

    revoke = c.post(
        "/admin/bulk/run",
        json={"action": "revoke_api_keys", "ids": [key_id], "confirm": "CONFIRM 1"},
        headers={"X-CSRF-Token": csrf},
    )
    assert revoke.status_code == 200, revoke.text
    assert revoke.json()["processed_count"] == 1
    key_row = next(k for k in c.get("/admin/keys").json()["keys"] if k["id"] == key_id)
    assert key_row["active"] is False


def test_bulk_danger_zone_deletes_selected_files_and_audits(master_session):
    c, csrf, _ = master_session
    doomed = _upload(c, csrf, payload=b"delete-me", name="delete-me.txt")
    kept = _upload(c, csrf, payload=b"keep-me", name="keep-me.txt")

    preview = c.post(
        "/admin/bulk/preview",
        json={"action": "delete_files", "ids": [doomed["file_id"]]},
        headers={"X-CSRF-Token": csrf},
    )
    assert preview.status_code == 200, preview.text
    assert preview.json()["affected_count"] == 1

    run = c.post(
        "/admin/bulk/run",
        json={"action": "delete_files", "ids": [doomed["file_id"]], "confirm": "CONFIRM 1"},
        headers={"X-CSRF-Token": csrf},
    )
    assert run.status_code == 200, run.text
    assert run.json()["processed_count"] == 1

    remaining_ids = {f["id"] for f in c.get("/admin/files").json()["files"]}
    assert doomed["file_id"] not in remaining_ids
    assert kept["file_id"] in remaining_ids
    audit_actions = [e["action"] for e in c.get("/audit/").json()["entries"]]
    assert "bulk.files_deleted" in audit_actions
