from __future__ import annotations

import base64 as _b64
import os
import secrets as _secrets
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, Form, HTTPException, Request, UploadFile
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.audit.log import record
from app.deps import client_ip, get_db, get_upload_user, require_active_user, require_master, require_permission
from app.links.slugs import new_slug
from app.models.file import FileObject
from app.models.link import Link
from app.models.session import SessionRow
from app.models.user import User
from app.permissions.policy import ensure_permissions
from app.security.csrf import require_csrf
from app.storage.paths import safe_join, storage_root

_UNSAFE_CT = frozenset({
    "text/html", "text/xhtml", "text/xhtml+xml",
    "image/svg+xml", "application/xhtml+xml",
})

_NO_ENCRYPT_COMPRESS = frozenset({"client"})  # ciphertext won't shrink

router = APIRouter(tags=["files"])

_CHUNK = 256 * 1024  # 256 KiB read buffer


def _used_bytes(db: Session, user_id: int) -> int:
    result = db.query(func.sum(FileObject.stored_size_bytes)).filter_by(owner_id=user_id).scalar()
    return result or 0


def _file_url(request: Request, slug: str) -> str:
    base = str(request.base_url).rstrip("/")
    return f"{base}/file/{slug}"


@router.post("/files/upload")
async def upload_file(
    request: Request,
    file: UploadFile,
    original_filename: str = Form(..., max_length=1024),
    max_uses: Optional[int] = Form(None, ge=1),
    expires_in_seconds: Optional[int] = Form(None, ge=1),
    encryption_mode: str = Form("none"),
    compress: bool = Form(False),
    is_permanent: bool = Form(True),
    temp_days: Optional[int] = Form(None, ge=1),
    delete_if_idle_days: Optional[int] = Form(None, ge=1),
    archive_after_idle_days: Optional[int] = Form(None, ge=1),
    auto_unarchive_on_download: bool = Form(True),
    randomize_filename: bool = Form(False),
    user: User = Depends(get_upload_user),
    db: Session = Depends(get_db),
) -> dict:
    from app.crypto.aead import encrypt_file as _encrypt_file
    from app.storage.compress import compress_file as _compress_file, should_compress
    from app.security.secretbox import seal
    from app.config import get_master_key

    if encryption_mode not in ("none", "server", "client"):
        raise HTTPException(400, detail="invalid encryption_mode")

    perm = ensure_permissions(db, user.id, master=(user.role == "master"))

    if encryption_mode == "client" and not perm.can_upload_client_encrypted:
        raise HTTPException(403, detail="client-side encryption not permitted")

    content_length = request.headers.get("content-length")
    if content_length:
        declared = int(content_length)
        if declared > perm.max_file_bytes:
            raise HTTPException(413, detail="file exceeds max file size")
        if _used_bytes(db, user.id) + declared > perm.quota_bytes:
            raise HTTPException(413, detail="upload would exceed your quota")

    rand = _secrets.token_hex(32)
    rel_path = f"{rand[:2]}/{rand[2:4]}/{rand[4:]}"
    base_path = storage_root() / rel_path
    base_path.parent.mkdir(parents=True, exist_ok=True)
    work = base_path.with_suffix(".work")

    stored = 0
    try:
        with open(work, "wb") as fh:
            while True:
                chunk = await file.read(_CHUNK)
                if not chunk:
                    break
                stored += len(chunk)
                if stored > perm.max_file_bytes:
                    raise HTTPException(413, detail="file exceeds max file size")
                fh.write(chunk)
    except HTTPException:
        work.unlink(missing_ok=True)
        raise

    if _used_bytes(db, user.id) + stored > perm.quota_bytes:
        work.unlink(missing_ok=True)
        raise HTTPException(413, detail="upload would exceed your quota")

    size_bytes = stored
    file_compressed = False
    current = work

    try:
        # Compression (only for non-client-encrypted modes and eligible types)
        ct = (file.content_type or "application/octet-stream").lower().split(";")[0].strip()
        if ct in _UNSAFE_CT:
            ct = "application/octet-stream"

        if compress and encryption_mode != "client" and should_compress(ct):
            compressed = base_path.with_suffix(".zst.work")
            _compress_file(current, compressed)
            current.unlink()
            current = compressed
            file_compressed = True

        # Create DB record (need ID before server-side encryption)
        display_name = _secrets.token_hex(8) + "_" + original_filename if randomize_filename else original_filename
        expires_at: datetime | None = None
        if not is_permanent and temp_days:
            expires_at = datetime.now(timezone.utc) + timedelta(days=temp_days)

        file_obj = FileObject(
            owner_id=user.id,
            storage_path=rel_path,
            original_filename=display_name,
            size_bytes=size_bytes,
            stored_size_bytes=0,
            content_type=ct,
            encryption_mode=encryption_mode,
            compressed=file_compressed,
            is_permanent=is_permanent,
            expires_at=expires_at,
            delete_if_idle_days=delete_if_idle_days,
            archive_after_idle_days=archive_after_idle_days,
            auto_unarchive_on_download=auto_unarchive_on_download,
        )
        db.add(file_obj)
        db.flush()

        enc_key_blob_val: bytes | None = None
        file_key_b64: str | None = None

        # Server-side encryption
        if encryption_mode == "server":
            per_file_key = _secrets.token_bytes(32)
            encrypted = base_path.with_suffix(".fupl.work")
            _encrypt_file(per_file_key, current, encrypted)
            current.unlink()
            current = encrypted
            state = request.app.state.app_state
            enc_key_blob_val = seal(get_master_key(state.settings), per_file_key)
            file_key_b64 = _b64.urlsafe_b64encode(per_file_key).rstrip(b"=").decode()

        # Finalize: rename work file to storage path
        current.rename(base_path)
        file_obj.stored_size_bytes = base_path.stat().st_size
        file_obj.enc_key_blob = enc_key_blob_val

    except Exception:
        for p in [work, base_path.with_suffix(".zst.work"), base_path.with_suffix(".fupl.work"), base_path]:
            p.unlink(missing_ok=True)
        db.rollback()
        raise

    expires_link: datetime | None = None
    if expires_in_seconds is not None:
        expires_link = datetime.now(timezone.utc) + timedelta(seconds=expires_in_seconds)

    slug = new_slug()
    link = Link(file_id=file_obj.id, slug=slug, max_uses=max_uses, expires_at=expires_link)
    db.add(link)

    record(db, actor=user.username, action="file.uploaded",
           target=f"file:{file_obj.id}", ip=client_ip(request))
    db.commit()

    base_url = _file_url(request, slug)
    share_url = base_url + (f"?ek={file_key_b64}" if encryption_mode == "server" else "")
    raw_base = _file_url(request, slug) + "/raw"
    raw_url = raw_base + (f"?ek={file_key_b64}" if encryption_mode == "server" else "")

    return {
        "file_id": file_obj.id,
        "slug": slug,
        "url": share_url,
        "raw_url": raw_url,
        "encryption_mode": encryption_mode,
        "file_key": file_key_b64,
        "max_uses": max_uses,
        "expires_at": expires_link.isoformat() if expires_link else None,
        "compressed": file_compressed,
    }


@router.get("/files/")
def list_files(
    user: User = Depends(require_active_user),
    db: Session = Depends(get_db),
) -> dict:
    if user.role == "master":
        files = db.query(FileObject).order_by(FileObject.created_at.desc()).all()
    else:
        files = (
            db.query(FileObject)
            .filter_by(owner_id=user.id)
            .order_by(FileObject.created_at.desc())
            .all()
        )

    result = []
    for f in files:
        links = db.query(Link).filter_by(file_id=f.id).all()
        result.append({
            "id": f.id,
            "owner_id": f.owner_id,
            "original_filename": f.original_filename,
            "size_bytes": f.size_bytes,
            "content_type": f.content_type,
            "encryption_mode": f.encryption_mode,
            "created_at": f.created_at.isoformat(),
            "links": [
                {
                    "id": lk.id,
                    "slug": lk.slug,
                    "max_uses": lk.max_uses,
                    "use_count": lk.use_count,
                    "expires_at": lk.expires_at.isoformat() if lk.expires_at else None,
                    "active": lk.active,
                }
                for lk in links
            ],
        })
    return {"files": result}


@router.delete("/files/{file_id}")
def delete_file(
    file_id: int,
    request: Request,
    _csrf: SessionRow = Depends(require_csrf),
    user: User = Depends(require_permission("can_delete")),
    db: Session = Depends(get_db),
) -> dict:
    file_obj = db.get(FileObject, file_id)
    if file_obj is None:
        raise HTTPException(404, detail="not found")
    if user.role != "master" and file_obj.owner_id != user.id:
        raise HTTPException(403, detail="not your file")

    try:
        full_path = safe_join(storage_root(), file_obj.storage_path)
        if full_path.exists():
            os.unlink(full_path)
    except OSError:
        pass

    db.query(Link).filter_by(file_id=file_obj.id).delete()
    db.delete(file_obj)
    record(db, actor=user.username, action="file.deleted",
           target=f"file:{file_id}", ip=client_ip(request))
    db.commit()
    return {"status": "deleted"}


class MintLinkBody(BaseModel):
    max_uses: int | None = None
    expires_in_seconds: int | None = None

    from pydantic import field_validator
    @field_validator("max_uses", "expires_in_seconds", mode="before")
    @classmethod
    def _positive(cls, v):
        if v is not None and v < 1:
            raise ValueError("must be >= 1")
        return v


class EditLinkBody(BaseModel):
    max_uses: int | None = None
    expires_in_seconds: int | None = None
    active: bool | None = None


@router.post("/files/{file_id}/links")
def mint_link(
    file_id: int,
    body: MintLinkBody,
    request: Request,
    _csrf: SessionRow = Depends(require_csrf),
    user: User = Depends(require_permission("can_regenerate_links")),
    db: Session = Depends(get_db),
) -> dict:
    file_obj = db.get(FileObject, file_id)
    if file_obj is None:
        raise HTTPException(404, detail="not found")
    if user.role != "master" and file_obj.owner_id != user.id:
        raise HTTPException(403, detail="not your file")

    expires_at: datetime | None = None
    if body.expires_in_seconds is not None:
        expires_at = datetime.now(timezone.utc) + timedelta(seconds=body.expires_in_seconds)

    slug = new_slug()
    link = Link(file_id=file_id, slug=slug, max_uses=body.max_uses, expires_at=expires_at)
    db.add(link)
    db.flush()

    record(db, actor=user.username, action="link.created",
           target=f"link:{link.id}", ip=client_ip(request))
    db.commit()

    return {
        "slug": slug,
        "url": _file_url(request, slug),
        "raw_url": _file_url(request, slug) + "/raw",
    }


@router.delete("/links/{link_id}")
def deactivate_link(
    link_id: int,
    request: Request,
    _csrf: SessionRow = Depends(require_csrf),
    user: User = Depends(require_active_user),
    db: Session = Depends(get_db),
) -> dict:
    link = db.get(Link, link_id)
    if link is None:
        raise HTTPException(404, detail="not found")
    file_obj = db.get(FileObject, link.file_id)
    if file_obj is None or (user.role != "master" and file_obj.owner_id != user.id):
        raise HTTPException(403, detail="not your file")
    link.active = False
    record(db, actor=user.username, action="link.deactivated",
           target=f"link:{link_id}", ip=client_ip(request))
    db.commit()
    return {"status": "deactivated"}


@router.patch("/links/{link_id}")
def edit_link(
    link_id: int,
    body: EditLinkBody,
    request: Request,
    _csrf: SessionRow = Depends(require_csrf),
    user: User = Depends(require_permission("can_regenerate_links")),
    db: Session = Depends(get_db),
) -> dict:
    link = db.get(Link, link_id)
    if link is None:
        raise HTTPException(404, detail="not found")
    file_obj = db.get(FileObject, link.file_id)
    if file_obj is None or (user.role != "master" and file_obj.owner_id != user.id):
        raise HTTPException(403, detail="not your file")

    # max_uses: only update when explicitly provided
    if body.max_uses is not None:
        link.max_uses = body.max_uses
    if body.expires_in_seconds is not None:
        link.expires_at = datetime.now(timezone.utc) + timedelta(seconds=body.expires_in_seconds)
    if body.active is not None:
        link.active = body.active

    record(db, actor=user.username, action="link.edited",
           target=f"link:{link_id}", ip=client_ip(request))
    db.commit()
    return {"status": "updated"}


@router.get("/files/disk-stats")
def disk_stats(
    user: User = Depends(require_master),
    db: Session = Depends(get_db),
) -> dict:
    total_bytes = db.query(func.sum(FileObject.stored_size_bytes)).scalar() or 0
    total_files = db.query(func.count(FileObject.id)).scalar() or 0
    total_links = db.query(func.count(Link.id)).filter_by(active=True).scalar() or 0
    from app.models.user import User as UserModel
    total_users = db.query(func.count(UserModel.id)).scalar() or 0
    return {
        "total_bytes": total_bytes,
        "total_files": total_files,
        "total_links": total_links,
        "total_users": total_users,
    }


@router.get("/files/usage")
def file_usage(
    user: User = Depends(require_active_user),
    db: Session = Depends(get_db),
) -> dict:
    from app.permissions.policy import ensure_permissions
    perm = ensure_permissions(db, user.id, master=(user.role == "master"))
    db.commit()
    used = _used_bytes(db, user.id)
    return {
        "used_bytes": used,
        "quota_bytes": perm.quota_bytes,
        "max_file_bytes": perm.max_file_bytes,
    }
