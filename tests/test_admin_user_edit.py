from __future__ import annotations


def _login(c, username: str, password: str):
    return c.post("/auth/login", json={"username": username, "password": password})


def _create_user(c, csrf, *, username="alice", password="alice-pass-1234", role="user"):
    r = c.post(
        "/users/",
        json={"username": username, "password": password, "role": role},
        headers={"X-CSRF-Token": csrf},
    )
    assert r.status_code == 200, r.text
    return r.json()


def test_admin_can_patch_username_password_and_role(master_session):
    c, csrf, _ = master_session
    user_id = _create_user(c, csrf)["id"]

    patched = c.patch(
        f"/users/{user_id}",
        json={
            "username": "bob",
            "password": "bob-pass-123456",
            "role": "master",
        },
        headers={"X-CSRF-Token": csrf},
    )

    assert patched.status_code == 200, patched.text
    assert patched.json()["username"] == "bob"
    assert patched.json()["role"] == "master"
    assert _login(c, "alice", "alice-pass-1234").status_code == 401
    assert _login(c, "bob", "bob-pass-123456").status_code == 200
    assert c.get("/account/me").json()["role"] == "master"


def test_user_patch_rejects_duplicate_username_and_short_password(master_session):
    c, csrf, _ = master_session
    alice_id = _create_user(c, csrf, username="alice")["id"]
    _create_user(c, csrf, username="bob", password="bob-pass-1234")

    duplicate = c.patch(
        f"/users/{alice_id}",
        json={"username": "bob"},
        headers={"X-CSRF-Token": csrf},
    )
    assert duplicate.status_code == 409

    short = c.patch(
        f"/users/{alice_id}",
        json={"password": "short"},
        headers={"X-CSRF-Token": csrf},
    )
    assert short.status_code == 400


def test_cannot_demote_or_delete_last_master(master_session):
    c, csrf, _ = master_session
    master_id = c.get("/account/me").json()["id"]

    demote = c.patch(
        f"/users/{master_id}",
        json={"role": "user"},
        headers={"X-CSRF-Token": csrf},
    )
    assert demote.status_code == 400

    delete = c.delete(f"/users/{master_id}", headers={"X-CSRF-Token": csrf})
    assert delete.status_code == 400
