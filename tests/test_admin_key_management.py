from __future__ import annotations


def _login(c, username: str, password: str) -> str:
    r = c.post("/auth/login", json={"username": username, "password": password})
    assert r.status_code == 200, r.text
    return r.json()["csrf_token"]


def _create_key(c, csrf):
    r = c.post("/keys/", headers={"X-CSRF-Token": csrf})
    assert r.status_code == 200, r.text
    return r.json()


def _create_user_with_api_keys(c, master_csrf):
    r = c.post(
        "/users/",
        json={"username": "alice", "password": "alice-pass-1234", "role": "user"},
        headers={"X-CSRF-Token": master_csrf},
    )
    assert r.status_code == 200, r.text
    user_id = r.json()["id"]
    p = c.post(
        f"/users/{user_id}/permissions",
        json={"can_use_api_keys": True},
        headers={"X-CSRF-Token": master_csrf},
    )
    assert p.status_code == 200, p.text
    return user_id


def test_keys_page_is_scoped_to_current_user_even_for_master(master_session):
    c, master_csrf, master_pw = master_session
    master_key = _create_key(c, master_csrf)
    alice_id = _create_user_with_api_keys(c, master_csrf)

    alice_csrf = _login(c, "alice", "alice-pass-1234")
    alice_key = _create_key(c, alice_csrf)

    master_csrf = _login(c, "admin", master_pw)
    own = c.get("/keys/")
    assert own.status_code == 200
    assert [k["id"] for k in own.json()["keys"]] == [master_key["id"]]
    assert own.json()["keys"][0]["owner_id"] != alice_id

    admin = c.get("/admin/keys")
    assert admin.status_code == 200
    all_ids = {k["id"] for k in admin.json()["keys"]}
    assert {master_key["id"], alice_key["id"]} <= all_ids
    alice_row = next(k for k in admin.json()["keys"] if k["id"] == alice_key["id"])
    assert alice_row["owner_id"] == alice_id
    assert alice_row["owner_username"] == "alice"


def test_api_key_numbers_are_per_user_and_stable(master_session):
    c, master_csrf, master_pw = master_session
    first_master = _create_key(c, master_csrf)
    second_master = _create_key(c, master_csrf)
    _create_user_with_api_keys(c, master_csrf)

    alice_csrf = _login(c, "alice", "alice-pass-1234")
    first_alice = _create_key(c, alice_csrf)
    c.delete(f"/keys/{first_alice['id']}", headers={"X-CSRF-Token": alice_csrf})
    second_alice = _create_key(c, alice_csrf)

    assert first_master["user_key_number"] == 1
    assert second_master["user_key_number"] == 2
    assert first_alice["user_key_number"] == 1
    assert second_alice["user_key_number"] == 2

    master_csrf = _login(c, "admin", master_pw)
    admin_keys = c.get("/admin/keys").json()["keys"]
    by_id = {k["id"]: k for k in admin_keys}
    assert by_id[first_master["id"]]["user_key_number"] == 1
    assert by_id[second_master["id"]]["user_key_number"] == 2
    # first_alice's key was deleted (soft-deleted) so it no longer appears in admin listing
    assert by_id[second_alice["id"]]["user_key_number"] == 2
