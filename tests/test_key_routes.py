from __future__ import annotations


def _create_key(c, csrf):
    return c.post("/keys/", headers={"X-CSRF-Token": csrf})


def test_create_key_success(master_session):
    c, csrf, _ = master_session
    r = _create_key(c, csrf)
    assert r.status_code == 200
    d = r.json()
    assert "key" in d and len(d["key"]) > 20
    assert "id" in d


def test_list_keys_no_raw_key(master_session):
    c, csrf, _ = master_session
    _create_key(c, csrf)
    r = c.get("/keys/")
    assert r.status_code == 200
    for k in r.json()["keys"]:
        assert "key" not in k
        assert "key_hash" not in k


def test_delete_key_removes_it_from_owner_list(master_session):
    c, csrf, _ = master_session
    key_id = _create_key(c, csrf).json()["id"]
    r = c.delete(f"/keys/{key_id}", headers={"X-CSRF-Token": csrf})
    assert r.status_code == 200
    assert r.json()["status"] == "deleted"
    keys = c.get("/keys/").json()["keys"]
    assert all(k["id"] != key_id for k in keys)


def test_reset_ip_success(master_session):
    c, csrf, pw = master_session
    key_id = _create_key(c, csrf).json()["id"]
    r = c.post(f"/keys/{key_id}/reset-ip", json={"password": pw}, headers={"X-CSRF-Token": csrf})
    assert r.status_code == 200
    assert r.json()["status"] == "ip_reset"


def test_reset_ip_wrong_password(master_session):
    c, csrf, _ = master_session
    key_id = _create_key(c, csrf).json()["id"]
    r = c.post(f"/keys/{key_id}/reset-ip", json={"password": "wrongpw"}, headers={"X-CSRF-Token": csrf})
    assert r.status_code == 401


def test_me_includes_can_use_api_keys(master_session):
    c, csrf, _ = master_session
    r = c.get("/account/me")
    assert r.status_code == 200
    assert "can_use_api_keys" in r.json()
