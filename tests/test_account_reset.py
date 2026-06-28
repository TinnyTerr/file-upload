from __future__ import annotations

from app.models.directory import Directory
from app.models.directory_link import DirectoryLink


def test_reset_account_removes_owned_directories_and_links(master_session):
    c, csrf, password = master_session

    created = c.post(
        "/directories",
        json={"title": "Reset me", "encryption_mode": "none"},
        headers={"X-CSRF-Token": csrf},
    )
    assert created.status_code == 200, created.text

    reset = c.post(
        "/account/reset",
        json={"current_password": password},
        headers={"X-CSRF-Token": csrf},
    )

    assert reset.status_code == 200, reset.text
    assert reset.json() == {"status": "reset"}
    assert c.get("/directories/").json()["directories"] == []

    state = c.app.state.app_state
    with state.session_factory() as db:
        assert db.query(Directory).count() == 0
        assert db.query(DirectoryLink).count() == 0
