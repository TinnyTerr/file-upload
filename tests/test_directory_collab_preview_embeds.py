from __future__ import annotations

import io
import zipfile


def _login(c, username: str, password: str) -> str:
    r = c.post("/auth/login", json={"username": username, "password": password})
    assert r.status_code == 200, r.text
    return r.json()["csrf_token"]


def _create_user(c, csrf, username: str, password: str = "user-pass-1234") -> int:
    r = c.post(
        "/users/",
        json={"username": username, "password": password, "role": "user", "can_upload": True},
        headers={"X-CSRF-Token": csrf},
    )
    assert r.status_code == 200, r.text
    return r.json()["id"]


def _create_dir(c, csrf, title="team", mode="none"):
    r = c.post(
        "/directories",
        json={"title": title, "encryption_mode": mode},
        headers={"X-CSRF-Token": csrf},
    )
    assert r.status_code == 200, r.text
    return r.json()


def _upload(c, csrf, payload: bytes, name: str, content_type: str, **data):
    form = {"original_filename": name, **{k: str(v) for k, v in data.items() if v is not None}}
    r = c.post(
        "/files/upload",
        files={"file": (name, payload, content_type)},
        data=form,
        headers={"X-CSRF-Token": csrf},
    )
    assert r.status_code == 200, r.text
    return r.json()


def test_directory_collaborator_can_upload_and_delete_but_not_manage_invites(master_session):
    c, owner_csrf, _ = master_session
    alice_id = _create_user(c, owner_csrf, "alice")
    _create_user(c, owner_csrf, "bob", "bob-pass-1234")
    directory = _create_dir(c, owner_csrf)

    invite = c.post(
        f"/directories/{directory['id']}/collaborators",
        json={"username": "alice"},
        headers={"X-CSRF-Token": owner_csrf},
    )
    assert invite.status_code == 200, invite.text
    assert invite.json()["user_id"] == alice_id

    alice_csrf = _login(c, "alice", "user-pass-1234")
    dirs = c.get("/directories/").json()["directories"]
    match = next(d for d in dirs if d["id"] == directory["id"])
    assert match["role"] == "editor"

    uploaded = _upload(
        c,
        alice_csrf,
        b"collab",
        "collab.txt",
        "text/plain",
        directory_id=directory["id"],
    )
    members = c.get(f"/directories/{directory['id']}/files").json()["files"]
    assert [m["filename"] for m in members] == ["collab.txt"]

    blocked_invite = c.post(
        f"/directories/{directory['id']}/collaborators",
        json={"username": "bob"},
        headers={"X-CSRF-Token": alice_csrf},
    )
    assert blocked_invite.status_code == 403

    deleted = c.delete(
        f"/directories/{directory['id']}/files/{members[0]['id']}",
        headers={"X-CSRF-Token": alice_csrf},
    )
    assert deleted.status_code == 200, deleted.text
    assert c.get(f"/file/{uploaded['slug']}/raw").status_code == 404


def test_directory_preview_manifest_groups_media_and_archive_status(master_session):
    c, csrf, _ = master_session
    directory = _create_dir(c, csrf)

    zip_buffer = io.BytesIO()
    with zipfile.ZipFile(zip_buffer, "w", zipfile.ZIP_STORED) as zf:
        zf.writestr("inside.txt", "hello")

    _upload(c, csrf, b"\x89PNG\r\n\x1a\n", "photo.png", "image/png", directory_id=directory["id"])
    _upload(c, csrf, b"plain text", "note.txt", "text/plain", directory_id=directory["id"])
    _upload(c, csrf, zip_buffer.getvalue(), "archive.zip", "application/zip", directory_id=directory["id"])
    _upload(c, csrf, b"not a zip", "broken.zip", "application/zip", directory_id=directory["id"])

    manifest = c.get(f"/d/{directory['slug']}/preview-manifest")
    assert manifest.status_code == 200, manifest.text
    groups = manifest.json()["groups"]

    assert [f["filename"] for f in groups["images"]] == ["photo.png"]
    assert [f["filename"] for f in groups["text"]] == ["note.txt"]
    archives = {f["filename"]: f for f in groups["archives"]}
    assert archives["archive.zip"]["preview"]["status"] == "readable"
    assert archives["archive.zip"]["preview"]["entries"] == ["inside.txt"]
    assert archives["broken.zip"]["preview"]["status"] == "unreadable"


def test_preview_route_does_not_consume_limited_links_and_blocks_limited_media(master_session):
    c, csrf, _ = master_session
    uploaded = _upload(
        c,
        csrf,
        b"image bytes",
        "photo.png",
        "image/png",
        max_uses=1,
    )

    preview = c.get(f"/file/{uploaded['slug']}/preview")
    assert preview.status_code == 403

    info = c.get(f"/file/{uploaded['slug']}/info").json()
    assert info["use_count"] == 0

    raw = c.get(f"/file/{uploaded['slug']}/raw")
    assert raw.status_code == 200
    assert c.get(f"/file/{uploaded['slug']}/raw").status_code == 404


def test_download_pages_emit_discord_media_metadata_only_when_safe(master_session):
    c, csrf, _ = master_session
    image = _upload(c, csrf, b"plain image", "plain.png", "image/png")
    encrypted = _upload(c, csrf, b"secret", "secret.png", "image/png", encryption_mode="server")

    image_page = c.get(f"/file/{image['slug']}")
    assert image_page.status_code == 200
    assert 'property="og:image"' in image_page.text
    assert f"/file/{image['slug']}/preview" in image_page.text

    encrypted_page = c.get(f"/file/{encrypted['slug']}")
    assert encrypted_page.status_code == 200
    assert 'property="og:image"' not in encrypted_page.text
    assert 'property="og:title"' in encrypted_page.text

