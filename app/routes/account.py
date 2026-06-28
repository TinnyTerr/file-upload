from __future__ import annotations

import io
import os

from fastapi import APIRouter, Depends, HTTPException, Request, UploadFile, File as FastAPIFile
from fastapi.responses import Response
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.audit.log import record
from app.deps import client_ip, current_session, get_db, require_active_user
from app.models.session import SessionRow
from app.models.user import User
from app.security.csrf import require_csrf
from app.security.passwords import hash_password, verify_password

router = APIRouter(prefix="/account", tags=["account"])

# ---------------------------------------------------------------------------
# Allowed avatar MIME types.  We store raw bytes so the browser gets the
# original encoded image; we don't need to re-encode server-side.
# ---------------------------------------------------------------------------
_ALLOWED_AVATAR_TYPES = {
    "image/jpeg",
    "image/png",
    "image/gif",
    "image/webp",
}
_AVATAR_MAX_BYTES = 2 * 1024 * 1024  # 2 MiB


# ---------------------------------------------------------------------------
# Existing: change credentials
# ---------------------------------------------------------------------------

class ChangeCredsBody(BaseModel):
    new_username: str
    current_password: str
    new_password: str


@router.post("/change-credentials")
def change_credentials(body: ChangeCredsBody, request: Request,
                       session_row: SessionRow = Depends(require_csrf),
                       db: Session = Depends(get_db)) -> dict:
    if len(body.new_password) < 12:
        raise HTTPException(status_code=400, detail="new password too short")
    user = db.get(User, session_row.user_id)
    if user is None or not verify_password(body.current_password, user.password_hash):
        raise HTTPException(status_code=401, detail="invalid current password")
    existing = db.query(User).filter_by(username=body.new_username).one_or_none()
    if existing is not None and existing.id != user.id:
        raise HTTPException(status_code=409, detail="username taken")
    actor = user.username
    user.username = body.new_username
    user.password_hash = hash_password(body.new_password)
    user.must_change_credentials = False
    db.query(SessionRow).filter(
        SessionRow.user_id == user.id,
        SessionRow.id != session_row.id,
    ).delete()
    record(db, actor=actor, action="account.credentials_changed",
           target=f"user:{user.id}", ip=client_ip(request))
    db.commit()
    return {"status": "updated"}


# ---------------------------------------------------------------------------
# /me
# ---------------------------------------------------------------------------

@router.get("/me")
def me(user: User = Depends(require_active_user), db: Session = Depends(get_db)) -> dict:
    from app.permissions.policy import ensure_permissions
    from app.models.file import FileObject
    from sqlalchemy import func
    perm = ensure_permissions(db, user.id, master=(user.role == "master"))
    used = db.query(func.sum(FileObject.stored_size_bytes)).filter_by(owner_id=user.id).scalar() or 0
    db.commit()
    return {
        "id": user.id,
        "username": user.username,
        "role": user.role,
        "has_avatar": user.avatar_data is not None,
        "quota_bytes": perm.quota_bytes,
        "max_file_bytes": perm.max_file_bytes,
        "used_bytes": used,
        "can_upload": perm.can_upload,
        "can_use_api_keys": perm.can_use_api_keys,
        "can_upload_client_encrypted": perm.can_upload_client_encrypted,
        "can_delete": perm.can_delete,
        "can_regenerate_links": perm.can_regenerate_links,
        "can_delete_links": perm.can_delete_links,
        "can_create_directories": perm.can_create_directories,
        "can_manage_lifecycle": perm.can_manage_lifecycle,
        "can_use_p2p": perm.can_use_p2p,
        "can_view_admin": perm.can_view_admin,
        "can_manage_users": perm.can_manage_users,
        "can_manage_storage": perm.can_manage_storage,
        "can_manage_api_keys": perm.can_manage_api_keys,
    }


# ---------------------------------------------------------------------------
# Avatar upload / serve
# ---------------------------------------------------------------------------

@router.post("/avatar")
async def upload_avatar(
    request: Request,
    file: UploadFile = FastAPIFile(...),
    session_row: SessionRow = Depends(require_csrf),
    db: Session = Depends(get_db),
) -> dict:
    """Upload a profile picture (JPEG/PNG/GIF/WebP, max 2 MiB)."""
    # Validate content-type from upload header
    ct = (file.content_type or "").lower().split(";")[0].strip()
    if ct not in _ALLOWED_AVATAR_TYPES:
        raise HTTPException(
            status_code=415,
            detail=f"unsupported image type: {ct}. Allowed: jpeg, png, gif, webp",
        )

    # Read with hard size cap — don't trust Content-Length
    data = await file.read(_AVATAR_MAX_BYTES + 1)
    if len(data) > _AVATAR_MAX_BYTES:
        raise HTTPException(
            status_code=413,
            detail="avatar must be ≤ 2 MiB",
        )
    if len(data) == 0:
        raise HTTPException(status_code=400, detail="empty file")

    # Sniff magic bytes as a secondary check (Content-Type can be spoofed)
    detected = _sniff_image_type(data)
    if detected not in _ALLOWED_AVATAR_TYPES:
        raise HTTPException(status_code=415, detail="file does not match a supported image format")

    user = db.get(User, session_row.user_id)
    if user is None:
        raise HTTPException(status_code=401, detail="not authenticated")

    user.avatar_data = data
    user.avatar_content_type = detected
    record(db, actor=user.username, action="account.avatar_updated",
           target=f"user:{user.id}", ip=client_ip(request))
    db.commit()
    return {"status": "updated"}


@router.delete("/avatar")
def delete_avatar(
    request: Request,
    session_row: SessionRow = Depends(require_csrf),
    db: Session = Depends(get_db),
) -> dict:
    """Remove the current profile picture."""
    user = db.get(User, session_row.user_id)
    if user is None:
        raise HTTPException(status_code=401, detail="not authenticated")
    user.avatar_data = None
    user.avatar_content_type = None
    record(db, actor=user.username, action="account.avatar_removed",
           target=f"user:{user.id}", ip=client_ip(request))
    db.commit()
    return {"status": "removed"}


@router.get("/avatar/{user_id}")
def serve_avatar(user_id: int, db: Session = Depends(get_db)) -> Response:
    """Serve the avatar bytes for a given user. Public endpoint (no auth) so
    avatars can be embedded in img tags easily; the user_id is not sensitive."""
    user = db.get(User, user_id)
    if user is None or user.avatar_data is None:
        raise HTTPException(status_code=404, detail="no avatar")
    ct = user.avatar_content_type or "image/jpeg"
    return Response(
        content=user.avatar_data,
        media_type=ct,
        headers={
            # Short cache — allow the browser to reuse within the session but
            # pick up a new avatar quickly after upload.
            "Cache-Control": "private, max-age=60",
        },
    )


def _sniff_image_type(data: bytes) -> str:
    """Detect image MIME type from magic bytes."""
    if data[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return "application/octet-stream"


# ---------------------------------------------------------------------------
# Reset account (wipe files/dirs/links/keys; keep account)
# ---------------------------------------------------------------------------

class PasswordConfirmBody(BaseModel):
    current_password: str


@router.post("/reset")
def reset_account(
    body: PasswordConfirmBody,
    request: Request,
    session_row: SessionRow = Depends(require_csrf),
    db: Session = Depends(get_db),
) -> dict:
    """Delete all of the user's files, folders, links, and API keys.
    The account itself (and the current session) remain intact.
    """
    user = db.get(User, session_row.user_id)
    if user is None or not verify_password(body.current_password, user.password_hash):
        raise HTTPException(status_code=401, detail="invalid password")

    actor = user.username
    paths_to_unlink = _purge_user_data(db, user.id)

    record(db, actor=actor, action="account.reset",
           target=f"user:{user.id}", ip=client_ip(request))
    db.commit()

    # Delete physical files only after the transaction succeeds
    from app.storage.blobs import unlink_queued
    unlink_queued(paths_to_unlink)

    return {"status": "reset"}


# ---------------------------------------------------------------------------
# Delete account (wipe data then delete the user row)
# ---------------------------------------------------------------------------

@router.delete("")
def delete_account(
    body: PasswordConfirmBody,
    request: Request,
    session_row: SessionRow = Depends(require_csrf),
    db: Session = Depends(get_db),
) -> dict:
    """Permanently delete the account and all associated data.

    Blocked if this is the only master account — deleting the last admin
    would permanently lock everyone out of the application.
    """
    user = db.get(User, session_row.user_id)
    if user is None or not verify_password(body.current_password, user.password_hash):
        raise HTTPException(status_code=401, detail="invalid password")

    # Protect the last master account
    if user.role == "master":
        master_count = db.query(User).filter_by(role="master").count()
        if master_count <= 1:
            raise HTTPException(
                status_code=409,
                detail="cannot delete the only master account — promote another user first",
            )

    actor = user.username
    user_id = user.id

    # Purge all owned data
    paths_to_unlink = _purge_user_data(db, user_id)

    # Revoke all sessions (including current — client must handle the 401)
    db.query(SessionRow).filter_by(user_id=user_id).delete()

    # Remove permission row if it exists
    from app.models.permission import Permission
    db.query(Permission).filter_by(user_id=user_id).delete()

    # Audit log before deleting the user row (so actor name is captured)
    record(db, actor=actor, action="account.deleted",
           target=f"user:{user_id}", ip=client_ip(request))

    # Finally delete the user
    db.delete(user)
    db.commit()

    from app.storage.blobs import unlink_queued
    unlink_queued(paths_to_unlink)

    return {"status": "deleted"}


# ---------------------------------------------------------------------------
# Shared helper: purge all data owned by a user (files, dirs, links, keys)
# Returns a list of filesystem paths to unlink after the DB transaction.
# ---------------------------------------------------------------------------

def _purge_user_data(db: Session, user_id: int) -> list[str | None]:
    from app.models.file import FileObject
    from app.models.link import Link
    from app.models.directory import Directory
    from app.models.directory_collaborator import DirectoryCollaborator
    from app.models.api_key import ApiKey
    from app.models.dropbox_link import DropboxUploadLink
    from app.storage.blobs import release_blob

    # Collect all files to delete (may span directories and standalone files)
    files = db.query(FileObject).filter_by(owner_id=user_id).all()

    # Delete share links for those files first (FK → files.id)
    if files:
        file_ids = [f.id for f in files]
        db.query(Link).filter(Link.file_id.in_(file_ids)).delete(synchronize_session="fetch")

    # Release each file's blob reference and collect paths
    paths: list[str | None] = []
    for f in files:
        paths.append(release_blob(db, f))
        db.delete(f)
    db.flush()

    # Delete dropbox links owned by user
    db.query(DropboxUploadLink).filter_by(owner_id=user_id).delete()

    # Delete directory collaborator entries where this user is a member
    db.query(DirectoryCollaborator).filter_by(user_id=user_id).delete()

    # Delete directories owned by user (files inside already deleted above)
    db.query(Directory).filter_by(owner_id=user_id).delete()

    # Revoke API keys
    db.query(ApiKey).filter_by(owner_id=user_id).delete()

    # Clear the permission row (will be recreated fresh by ensure_permissions)
    from app.models.permission import Permission
    db.query(Permission).filter_by(user_id=user_id).delete()

    db.flush()
    return paths
