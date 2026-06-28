"""Contract tests: lock the exact JSON shapes the React SPA (client/) depends on.

These guard against backend drift that would silently break the frontend — e.g.
`GET /admin/keys` returns `{"keys": [...]}` (not a bare array), which the SPA's
adminService unwraps. Each assertion mirrors a `services/*.ts` expectation.
"""
from __future__ import annotations

import io

import pytest


def _subset(keys: set[str], obj: dict, where: str):
    missing = keys - set(obj)
    assert not missing, f"{where}: missing keys {missing} (got {sorted(obj)})"


def _upload(c, csrf, *, name="hello.txt", mode="none", data=b"hello world"):
    r = c.post(
        "/files/upload",
        files={"file": (name, io.BytesIO(data), "text/plain")},
        data={"original_filename": name, "encryption_mode": mode},
        headers={"X-CSRF-Token": csrf},
    )
    assert r.status_code == 200, r.text
    return r.json()


# --- auth / account -------------------------------------------------------

def test_login_and_me_contract(master_session):
    c, csrf, _pw = master_session
    me = c.get("/account/me")
    assert me.status_code == 200
    body = me.json()
    _subset(
        {
            "id", "username", "role", "quota_bytes", "max_file_bytes", "used_bytes",
            "can_upload", "can_upload_client_encrypted", "can_delete", "can_regenerate_links",
            "can_delete_links", "can_create_directories", "can_manage_lifecycle", "can_use_api_keys",
            "can_view_admin", "can_manage_users", "can_manage_storage", "can_manage_api_keys",
        },
        body,
        "/account/me",
    )
    assert body["role"] == "master"


def test_login_response_shape(app_client):
    c, state = app_client
    r = c.post("/auth/login", json={"username": "admin", "password": state.bootstrap_password})
    assert r.status_code == 200
    _subset({"csrf_token", "must_change_credentials"}, r.json(), "/auth/login")


# --- files / usage / links ------------------------------------------------

def test_upload_and_list_contract(master_session):
    c, csrf, _ = master_session
    up = _upload(c, csrf)
    _subset(
        {"file_id", "slug", "url", "raw_url", "access_key", "encryption_mode", "max_uses",
         "expires_at", "compressed", "source_type"},
        up,
        "/files/upload",
    )

    listing = c.get("/files/")
    assert listing.status_code == 200
    body = listing.json()
    assert "files" in body and isinstance(body["files"], list) and body["files"]
    f = body["files"][0]
    _subset(
        {"id", "owner_id", "original_filename", "size_bytes", "content_type", "encryption_mode",
         "compressed", "archived", "expires_at", "access_key", "created_at", "links"},
        f,
        "/files/ item",
    )
    assert f["links"], "expected a default link"
    _subset({"id", "slug", "max_uses", "use_count", "expires_at", "active"}, f["links"][0], "link")


def test_usage_contract(master_session):
    c, _csrf, _ = master_session
    r = c.get("/files/usage")
    assert r.status_code == 200
    _subset({"used_bytes", "quota_bytes", "max_file_bytes"}, r.json(), "/files/usage")


def test_mint_link_contract(master_session):
    c, csrf, _ = master_session
    up = _upload(c, csrf)
    r = c.post(f"/files/{up['file_id']}/links", json={"max_uses": 3}, headers={"X-CSRF-Token": csrf})
    assert r.status_code == 200, r.text
    _subset({"slug", "url", "raw_url", "encryption_mode", "access_key"}, r.json(), "mint link")


def test_public_info_contract(master_session):
    c, csrf, _ = master_session
    up = _upload(c, csrf)
    r = c.get(f"/file/{up['slug']}/info")
    assert r.status_code == 200
    _subset(
        {"filename", "size_bytes", "content_type", "encryption_mode", "compressed", "archived",
         "max_uses", "use_count", "expires_at", "hashes"},
        r.json(),
        "/file/{slug}/info",
    )


def test_unknown_slug_404_detail(app_client):
    c, _ = app_client
    r = c.get("/file/does-not-exist/info")
    assert r.status_code == 404
    assert isinstance(r.json().get("detail"), str)


def test_server_mode_upload_has_access_key(master_session):
    c, csrf, _ = master_session
    up = _upload(c, csrf, mode="server", name="s.txt")
    assert up["encryption_mode"] == "server"
    assert up["access_key"], "server-mode upload must return an access_key the SPA appends as ?ek="


# --- api keys -------------------------------------------------------------

def test_keys_contract(master_session):
    c, csrf, _ = master_session
    created = c.post("/keys/", headers={"X-CSRF-Token": csrf})
    assert created.status_code == 200, created.text
    _subset({"id", "user_key_number", "key"}, created.json(), "POST /keys/")

    mine = c.get("/keys/")
    assert "keys" in mine.json() and isinstance(mine.json()["keys"], list)

    admin = c.get("/admin/keys")
    assert admin.status_code == 200
    # Regression guard for the SPA bug: this is an object with a "keys" list.
    assert isinstance(admin.json(), dict) and "keys" in admin.json()
    if admin.json()["keys"]:
        _subset({"id", "owner_id", "owner_username", "user_key_number", "bound_ip", "active"},
                admin.json()["keys"][0], "/admin/keys item")


# --- directories ----------------------------------------------------------

def test_directory_contract(master_session):
    c, csrf, _ = master_session
    created = c.post("/directories", json={"title": "T", "encryption_mode": "none"}, headers={"X-CSRF-Token": csrf})
    assert created.status_code == 200, created.text
    _subset({"id", "slug", "url", "encryption_mode", "access_key"}, created.json(), "POST /directories")

    listing = c.get("/directories/")
    assert "directories" in listing.json() and isinstance(listing.json()["directories"], list)
    d = listing.json()["directories"][0]
    _subset({"id", "owner_id", "slug", "title", "url", "encryption_mode", "file_count", "total_bytes", "role"}, d, "dir item")


# --- dropbox (one-file inbound) ------------------------------------------

def test_dropbox_full_flow(master_session):
    c, csrf, _ = master_session
    created = c.post("/dropbox-links", json={"expires_in_seconds": 3600}, headers={"X-CSRF-Token": csrf})
    assert created.status_code == 200, created.text
    _subset({"id", "token", "url", "upload_url", "expires_at"}, created.json(), "POST /dropbox-links")
    token = created.json()["token"]

    info = c.get(f"/dropbox/{token}")
    assert info.status_code == 200 and info.json()["status"] == "active"

    first = c.post(
        f"/dropbox/{token}/upload",
        files={"file": ("drop.txt", io.BytesIO(b"inbound"), "text/plain")},
        data={"original_filename": "drop.txt"},
    )
    assert first.status_code == 200, first.text

    # One-shot: a second upload (and the status) must report it gone.
    second = c.post(
        f"/dropbox/{token}/upload",
        files={"file": ("drop2.txt", io.BytesIO(b"again"), "text/plain")},
        data={"original_filename": "drop2.txt"},
    )
    assert second.status_code == 410
    assert c.get(f"/dropbox/{token}").status_code == 410


# --- admin dashboard surfaces --------------------------------------------

def test_admin_storage_contract(master_session):
    c, csrf, _ = master_session
    _upload(c, csrf)
    r = c.get("/admin/storage")
    assert r.status_code == 200
    body = r.json()
    _subset(
        {"global_storage_quota_bytes", "used_bytes", "allocated_quota_bytes", "storage_summary",
         "disk", "total_files", "total_links", "active_links", "total_api_keys", "users",
         "lifecycle_counts", "content_type_counts", "link_status_counts", "api_key_status_counts", "fun_stats"},
        body,
        "/admin/storage",
    )
    _subset({"used_percent", "allocated_percent", "free_under_cap_bytes", "unallocated_quota_bytes"},
            body["storage_summary"], "storage_summary")
    _subset({"total_bytes", "used_bytes", "free_bytes"}, body["disk"], "disk")
    _subset(
        {"dedup_saved_bytes", "archive_saved_bytes", "top_downloaded_files", "biggest_files",
         "source_type_counts", "collaborator_count", "busiest_directories"},
        body["fun_stats"],
        "fun_stats",
    )


def test_disk_stats_contract(master_session):
    c, _csrf, _ = master_session
    r = c.get("/files/disk-stats")
    assert r.status_code == 200
    _subset({"total_files", "total_bytes", "total_users", "total_links"}, r.json(), "/files/disk-stats")


def test_users_contract(master_session):
    c, _csrf, _ = master_session
    r = c.get("/users/")
    assert r.status_code == 200
    body = r.json()
    assert "users" in body and body["users"]
    u = body["users"][0]
    _subset({"id", "username", "role", "must_change_credentials", "created_at", "permissions"}, u, "user")
    _subset({"can_upload", "quota_bytes", "max_file_bytes"}, u["permissions"], "permissions")


def test_audit_contract(master_session):
    c, _csrf, _ = master_session
    r = c.get("/audit/")
    assert r.status_code == 200
    _subset({"entries", "chain_ok", "actions", "total_count", "filtered_count"}, r.json(), "/audit/")


def test_admin_files_and_dirs_contract(master_session):
    c, csrf, _ = master_session
    _upload(c, csrf)
    assert "files" in c.get("/admin/files").json()
    assert "directories" in c.get("/admin/directories").json()


def test_bulk_preview_contract(master_session):
    c, csrf, _ = master_session
    r = c.post("/admin/bulk/preview", json={"action": "delete_inactive_links", "ids": []},
               headers={"X-CSRF-Token": csrf})
    assert r.status_code == 200, r.text
    _subset({"action", "affected_count", "confirmation_phrase", "items"}, r.json(), "bulk preview")
    assert r.json()["confirmation_phrase"].startswith("CONFIRM ")


def test_non_master_cannot_reach_admin(app_client):
    """A fresh second user with no admin perms is rejected from admin surfaces."""
    c, state = app_client
    # become master, finish setup
    r = c.post("/auth/login", json={"username": "admin", "password": state.bootstrap_password})
    csrf = r.json()["csrf_token"]
    c.post("/account/change-credentials",
           json={"current_password": state.bootstrap_password, "new_username": "admin", "new_password": "masterpass1234"},
           headers={"X-CSRF-Token": csrf})
    r = c.post("/auth/login", json={"username": "admin", "password": "masterpass1234"})
    csrf = r.json()["csrf_token"]
    # create a plain user
    c.post("/users/", json={"username": "bob", "password": "bobpassword12", "role": "user", "can_upload": True},
           headers={"X-CSRF-Token": csrf})
    c.post("/auth/logout", headers={"X-CSRF-Token": csrf})
    # log in as bob
    r = c.post("/auth/login", json={"username": "bob", "password": "bobpassword12"})
    assert r.status_code == 200
    assert c.get("/admin/storage").status_code == 403
    assert c.get("/users/").status_code == 403
    assert c.get("/admin/keys").status_code == 403
