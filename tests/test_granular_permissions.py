from __future__ import annotations


def _login(c, username: str, password: str) -> str:
    r = c.post("/auth/login", json={"username": username, "password": password})
    assert r.status_code == 200, r.text
    return r.json()["csrf_token"]


def _create_user(c, csrf):
    r = c.post(
        "/users/",
        json={"username": "alice", "password": "alice-pass-1234", "role": "user"},
        headers={"X-CSRF-Token": csrf},
    )
    assert r.status_code == 200, r.text
    return r.json()["id"]


def test_folder_creation_has_its_own_permission(master_session):
    c, master_csrf, _ = master_session
    user_id = _create_user(c, master_csrf)
    r = c.post(
        f"/users/{user_id}/permissions",
        json={"can_create_directories": False},
        headers={"X-CSRF-Token": master_csrf},
    )
    assert r.status_code == 200, r.text

    alice_csrf = _login(c, "alice", "alice-pass-1234")
    denied = c.post(
        "/directories",
        json={"title": "blocked", "encryption_mode": "none"},
        headers={"X-CSRF-Token": alice_csrf},
    )
    assert denied.status_code == 403


def test_lifecycle_upload_options_have_their_own_permission(master_session):
    c, master_csrf, _ = master_session
    user_id = _create_user(c, master_csrf)
    r = c.post(
        f"/users/{user_id}/permissions",
        json={"can_manage_lifecycle": False},
        headers={"X-CSRF-Token": master_csrf},
    )
    assert r.status_code == 200, r.text

    alice_csrf = _login(c, "alice", "alice-pass-1234")
    plain = c.post(
        "/files/upload",
        files={"file": ("plain.txt", b"ok", "text/plain")},
        data={"original_filename": "plain.txt"},
        headers={"X-CSRF-Token": alice_csrf},
    )
    assert plain.status_code == 200, plain.text

    denied = c.post(
        "/files/upload",
        files={"file": ("arch.txt", b"blocked", "text/plain")},
        data={"original_filename": "arch.txt", "archive_after_idle_days": "1"},
        headers={"X-CSRF-Token": alice_csrf},
    )
    assert denied.status_code == 403
