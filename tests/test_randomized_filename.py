from __future__ import annotations

import re


def _upload(c, csrf, *, name: str, randomize: bool, directory_id: int | None = None):
    data = {
        "original_filename": name,
        "randomize_filename": "true" if randomize else "false",
    }
    if directory_id is not None:
        data["directory_id"] = str(directory_id)
    r = c.post(
        "/files/upload",
        files={"file": (name, b"payload", "application/pdf")},
        data=data,
        headers={"X-CSRF-Token": csrf},
    )
    assert r.status_code == 200, r.text
    return r.json()


def _create_dir(c, csrf):
    r = c.post(
        "/directories",
        json={"title": "docs", "encryption_mode": "none"},
        headers={"X-CSRF-Token": csrf},
    )
    assert r.status_code == 200, r.text
    return r.json()


def test_randomized_loose_file_name_replaces_original_basename(master_session):
    c, csrf, _ = master_session
    uploaded = _upload(c, csrf, name="secret-client-list.pdf", randomize=True)

    info = c.get(f"/file/{uploaded['slug']}/info").json()

    assert info["filename"] != "secret-client-list.pdf"
    assert "secret-client-list" not in info["filename"]
    assert re.fullmatch(r"[0-9a-f]{32}\.pdf", info["filename"])


def test_directory_member_name_ignores_randomize_filename(master_session):
    c, csrf, _ = master_session
    directory = _create_dir(c, csrf)
    _upload(
        c,
        csrf,
        name="docs/secret-client-list.pdf",
        randomize=True,
        directory_id=directory["id"],
    )
    _upload(
        c,
        csrf,
        name="docs/another-file.pdf",
        randomize=True,
        directory_id=directory["id"],
    )

    info = c.get(f"/d/{directory['slug']}/info").json()

    assert [f["filename"] for f in info["files"]] == [
        "docs/secret-client-list.pdf",
        "docs/another-file.pdf",
    ]
