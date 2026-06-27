from __future__ import annotations

from app.models.permission import Permission
from app.models.user import User


def _upload(c, csrf, name="link-target.txt"):
    r = c.post(
        "/files/upload",
        files={"file": (name, b"link payload", "text/plain")},
        data={"original_filename": name},
        headers={"X-CSRF-Token": csrf},
    )
    assert r.status_code == 200, r.text
    return r.json()


def _links_for(c, file_id: int):
    files = c.get("/files/").json()["files"]
    match = next(f for f in files if f["id"] == file_id)
    return match["links"]


def test_patch_deactivates_and_delete_hard_deletes_link(master_session):
    c, csrf, _ = master_session
    uploaded = _upload(c, csrf)
    link_id = _links_for(c, uploaded["file_id"])[0]["id"]

    deactivated = c.patch(
        f"/links/{link_id}",
        json={"active": False},
        headers={"X-CSRF-Token": csrf},
    )
    assert deactivated.status_code == 200, deactivated.text
    assert _links_for(c, uploaded["file_id"])[0]["active"] is False
    assert c.get(f"/file/{uploaded['slug']}/raw").status_code == 404

    deleted = c.delete(f"/links/{link_id}", headers={"X-CSRF-Token": csrf})
    assert deleted.status_code == 200, deleted.text
    assert _links_for(c, uploaded["file_id"]) == []
    assert c.get(f"/file/{uploaded['slug']}/info").status_code == 404


def test_delete_link_requires_granular_permission(app_client):
    c, state = app_client
    bootstrap_pw = state.bootstrap_password
    r = c.post("/auth/login", json={"username": "admin", "password": bootstrap_pw})
    csrf = r.json()["csrf_token"]
    c.post(
        "/account/change-credentials",
        json={
            "current_password": bootstrap_pw,
            "new_username": "admin",
            "new_password": "masterpass1234",
        },
        headers={"X-CSRF-Token": csrf},
    )
    c.post("/auth/login", json={"username": "admin", "password": "masterpass1234"})
    master_csrf = c.post(
        "/auth/login", json={"username": "admin", "password": "masterpass1234"}
    ).json()["csrf_token"]
    created = c.post(
        "/users/",
        json={"username": "alice", "password": "alice-pass-1234", "role": "user"},
        headers={"X-CSRF-Token": master_csrf},
    )
    assert created.status_code == 200, created.text
    alice_id = created.json()["id"]
    with state.session_factory() as db:
        perm = db.query(Permission).filter_by(user_id=alice_id).one()
        perm.can_delete_links = False
        db.commit()

    alice_csrf = c.post(
        "/auth/login", json={"username": "alice", "password": "alice-pass-1234"}
    ).json()["csrf_token"]
    uploaded = _upload(c, alice_csrf, "alice.txt")
    link_id = _links_for(c, uploaded["file_id"])[0]["id"]

    denied = c.delete(f"/links/{link_id}", headers={"X-CSRF-Token": alice_csrf})
    assert denied.status_code == 403
    assert len(_links_for(c, uploaded["file_id"])) == 1


def test_master_bypasses_link_delete_permission(master_session):
    c, csrf, _ = master_session
    uploaded = _upload(c, csrf)
    link_id = _links_for(c, uploaded["file_id"])[0]["id"]

    ok = c.delete(f"/links/{link_id}", headers={"X-CSRF-Token": csrf})

    assert ok.status_code == 200, ok.text
    assert _links_for(c, uploaded["file_id"]) == []
