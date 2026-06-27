from __future__ import annotations

import hashlib
import logging
import secrets
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, Form, HTTPException, Request, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.audit.log import record
from app.deps import client_ip, get_db, require_active_user
from app.models.directory import Directory
from app.models.directory_collaborator import DirectoryCollaborator
from app.models.dropbox_link import DropboxUploadLink
from app.models.session import SessionRow
from app.models.user import User
from app.permissions.policy import ensure_permissions
from app.routes.files import _finalize_stored_file, _used_bytes
from app.security.csrf import require_csrf
from app.storage.paths import storage_root

router = APIRouter(tags=["dropbox"])
_log = logging.getLogger(__name__)
_CHUNK = 256 * 1024


class DropboxLinkBody(BaseModel):
    target_directory_id: int | None = Field(None, ge=1)
    expires_in_seconds: int = Field(3600, ge=60, le=60 * 60 * 24 * 30)


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _can_edit_directory(db: Session, d: Directory, user: User) -> bool:
    if user.role == "master" or d.owner_id == user.id:
        return True
    return (
        db.query(DirectoryCollaborator.id)
        .filter_by(directory_id=d.id, user_id=user.id, role="editor")
        .first()
        is not None
    )


@router.post("/dropbox-links")
def create_dropbox_link(
    body: DropboxLinkBody,
    request: Request,
    _csrf: SessionRow = Depends(require_csrf),
    user: User = Depends(require_active_user),
    db: Session = Depends(get_db),
) -> dict:
    directory = None
    owner_id = user.id
    if body.target_directory_id is not None:
        directory = db.get(Directory, body.target_directory_id)
        if directory is None:
            raise HTTPException(404, detail="directory not found")
        if not _can_edit_directory(db, directory, user):
            raise HTTPException(403, detail="not your directory")
        owner_id = directory.owner_id

    token = secrets.token_urlsafe(32)
    expires_at = datetime.now(timezone.utc) + timedelta(seconds=body.expires_in_seconds)
    row = DropboxUploadLink(
        owner_id=owner_id,
        target_directory_id=body.target_directory_id,
        token_hash=_token_hash(token),
        expires_at=expires_at,
    )
    db.add(row)
    db.flush()
    record(db, actor=user.username, action="dropbox_link.created",
           target=f"dropbox:{row.id}", ip=client_ip(request))
    db.commit()
    _log.info(
        "dropbox link created id=%s owner_id=%s directory_id=%s expires_at=%s",
        row.id,
        owner_id,
        body.target_directory_id,
        expires_at.isoformat(),
    )
    base = str(request.base_url).rstrip("/")
    return {
        "id": row.id,
        "token": token,
        "url": f"{base}/dropbox/{token}",
        "upload_url": f"{base}/dropbox/{token}/upload",
        "target_directory_id": body.target_directory_id,
        "expires_at": expires_at.isoformat(),
    }


def _resolve_dropbox(db: Session, token: str) -> DropboxUploadLink:
    row = db.query(DropboxUploadLink).filter_by(token_hash=_token_hash(token)).first()
    if row is None:
        raise HTTPException(404, detail="not found")
    if not row.active or row.used_at is not None:
        raise HTTPException(410, detail="dropbox link has already been used")
    if row.expires_at is not None and row.expires_at < datetime.now(timezone.utc):
        raise HTTPException(410, detail="dropbox link expired")
    return row


@router.get("/dropbox/{token}")
def dropbox_info(token: str, db: Session = Depends(get_db)) -> dict:
    row = _resolve_dropbox(db, token)
    return {
        "status": "active",
        "target_directory_id": row.target_directory_id,
        "expires_at": row.expires_at.isoformat() if row.expires_at else None,
    }


@router.post("/dropbox/{token}/upload")
async def upload_to_dropbox(
    token: str,
    request: Request,
    file: UploadFile,
    original_filename: str = Form(..., max_length=1024),
    db: Session = Depends(get_db),
) -> dict:
    row = _resolve_dropbox(db, token)
    owner = db.get(User, row.owner_id)
    if owner is None:
        raise HTTPException(404, detail="owner not found")
    directory = db.get(Directory, row.target_directory_id) if row.target_directory_id else None
    if row.target_directory_id is not None and directory is None:
        raise HTTPException(404, detail="directory not found")
    perm = ensure_permissions(db, owner.id, master=(owner.role == "master"))

    rand = secrets.token_hex(32)
    rel_path = f"{rand[:2]}/{rand[2:4]}/{rand[4:]}"
    base_path = storage_root() / rel_path
    base_path.parent.mkdir(parents=True, exist_ok=True)
    work = base_path.with_suffix(".dropbox.work")
    written = 0
    try:
        with open(work, "wb") as fh:
            while True:
                chunk = await file.read(_CHUNK)
                if not chunk:
                    break
                written += len(chunk)
                if written > perm.max_file_bytes:
                    raise HTTPException(413, detail="file exceeds max file size")
                fh.write(chunk)
        if _used_bytes(db, owner.id) + written > perm.quota_bytes:
            raise HTTPException(413, detail="upload would exceed owner quota")
        result = _finalize_stored_file(
            request=request,
            db=db,
            user=owner,
            perm=perm,
            directory=directory,
            work_path=work,
            rel_path=rel_path,
            stored=written,
            content_type=file.content_type,
            encryption_mode=directory.encryption_mode if directory else "none",
            compress=False,
            randomize_filename=False,
            original_filename=original_filename,
            is_permanent=True,
            temp_days=None,
            delete_if_idle_days=None,
            archive_after_idle_days=None,
            auto_unarchive_on_download=True,
            max_uses=None,
            expires_in_seconds=None,
            source_type="dropbox",
        )
        row.active = False
        row.used_at = datetime.now(timezone.utc)
        record(db, actor="dropbox", action="dropbox.uploaded",
               target=f"dropbox:{row.id}:file:{result['file_id']}", ip=client_ip(request))
        db.commit()
        _log.info("dropbox upload completed id=%s file_id=%s owner_id=%s", row.id, result["file_id"], owner.id)
        return result
    except Exception:
        work.unlink(missing_ok=True)
        _log.exception("dropbox upload failed id=%s owner_id=%s bytes=%s", row.id, owner.id, written)
        raise

