from __future__ import annotations


def _login(c, username: str, password: str) -> str:
    r = c.post("/auth/login", json={"username": username, "password": password})
    assert r.status_code == 200, r.text
    return r.json()["csrf_token"]


def _upload_file(c, csrf, name: str):
    r = c.post(
        "/files/upload",
        files={"file": (name, b"payload", "application/octet-stream")},
        data={"original_filename": name},
        headers={"X-CSRF-Token": csrf},
    )
    assert r.status_code == 200, r.text
    return r.json()


def _create_dir(c, csrf, title: str):
    r = c.post(
        "/directories",
        json={"title": title, "encryption_mode": "none"},
        headers={"X-CSRF-Token": csrf},
    )
    assert r.status_code == 200, r.text
    return r.json()


def _seed_master_and_user_content(master_session):
    c, master_csrf, master_password = master_session
    user_password = "alice-pass-1234"
    r = c.post(
        "/users/",
        json={"username": "alice", "password": user_password, "role": "user", "can_upload": True},
        headers={"X-CSRF-Token": master_csrf},
    )
    assert r.status_code == 200, r.text

    alice_csrf = _login(c, "alice", user_password)
    alice_file = _upload_file(c, alice_csrf, "alice.txt")
    alice_dir = _create_dir(c, alice_csrf, "alice folder")

    master_csrf = _login(c, "admin", master_password)
    master_file = _upload_file(c, master_csrf, "master.txt")
    master_dir = _create_dir(c, master_csrf, "master folder")

    return c, {
        "alice_file": alice_file,
        "alice_dir": alice_dir,
        "master_file": master_file,
        "master_dir": master_dir,
    }


def test_master_main_file_area_only_shows_own_files_and_directories(master_session):
    c, seeded = _seed_master_and_user_content(master_session)

    files = c.get("/files/").json()["files"]
    directories = c.get("/directories/").json()["directories"]

    assert {f["id"] for f in files} == {seeded["master_file"]["file_id"]}
    assert {d["id"] for d in directories} == {seeded["master_dir"]["id"]}


def test_admin_file_area_can_see_all_files_and_directories(master_session):
    c, seeded = _seed_master_and_user_content(master_session)

    files = c.get("/admin/files").json()["files"]
    directories = c.get("/admin/directories").json()["directories"]

    assert {f["id"] for f in files} == {
        seeded["alice_file"]["file_id"],
        seeded["master_file"]["file_id"],
    }
    assert {d["id"] for d in directories} == {
        seeded["alice_dir"]["id"],
        seeded["master_dir"]["id"],
    }
