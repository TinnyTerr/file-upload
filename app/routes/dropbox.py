from __future__ import annotations

import base64
import hashlib
import json
import logging
import os
import secrets
import shutil
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional
from urllib.parse import quote

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
from app.routes.files import (
    _chunk_upload_size,
    _expected_chunk_len,
    _finalize_stored_file,
    _master_key,
    _num_chunks,
    _parts_dir,
    _precheck_declared_size,
    _received_indices,
    _used_bytes,
)
from app.security.csrf import require_csrf
from app.storage.paths import storage_root

router = APIRouter(tags=["dropbox"])
_log = logging.getLogger(__name__)
_CHUNK = 256 * 1024
_DROPBOX_CHUNK_TOKEN_AAD = b"dropbox-chunked-upload-v1"


class DropboxLinkBody(BaseModel):
    target_directory_id: int | None = Field(None, ge=1)
    expires_in_seconds: int = Field(3600, ge=60, le=60 * 60 * 24 * 30)


class DropboxChunkedInitBody(BaseModel):
    original_filename: str = Field(..., max_length=1024)
    total_size: int = Field(..., ge=0)
    content_type: Optional[str] = None


class DropboxChunkedFinalizeBody(BaseModel):
    upload_id: str


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

    # Deactivate existing active links for this exact target to prevent unbounded accumulation
    existing = db.query(DropboxUploadLink).filter_by(
        owner_id=owner_id,
        target_directory_id=body.target_directory_id,
        active=True,
    ).all()
    for elink in existing:
        elink.active = False
        record(db, actor="system", action="dropbox_link.cancelled", target=f"dropbox:{elink.id}", ip="127.0.0.1")

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
        "url": f"{base}/?receive={quote(token, safe='')}",
        "upload_url": f"{base}/dropbox/{token}/upload",
        "target_directory_id": body.target_directory_id,
        "expires_at": expires_at.isoformat(),
    }


@router.delete("/dropbox-links/{token}")
def cancel_dropbox_link(
    token: str,
    request: Request,
    _csrf: SessionRow = Depends(require_csrf),
    user: User = Depends(require_active_user),
    db: Session = Depends(get_db),
) -> dict:
    """Deactivate a dropbox link before it is used."""
    row = db.query(DropboxUploadLink).filter_by(token_hash=_token_hash(token)).first()
    if row is None:
        raise HTTPException(404, detail="not found")
    if row.owner_id != user.id and user.role != "master":
        raise HTTPException(403, detail="not your link")
    if not row.active:
        raise HTTPException(410, detail="link already inactive")
    row.active = False
    record(db, actor=user.username, action="dropbox_link.cancelled",
           target=f"dropbox:{row.id}", ip=client_ip(request))
    db.commit()
    return {"status": "cancelled"}


def _resolve_dropbox(db: Session, token: str) -> DropboxUploadLink:
    row = db.query(DropboxUploadLink).filter_by(token_hash=_token_hash(token)).with_for_update().first()
    if row is None:
        raise HTTPException(404, detail="not found")
    if not row.active or row.used_at is not None:
        raise HTTPException(410, detail="dropbox link has already been used")
    if row.expires_at is not None and row.expires_at < datetime.now(timezone.utc):
        raise HTTPException(410, detail="dropbox link expired")
    return row


def _seal_dropbox_upload_token(request: Request, meta: dict) -> str:
    from app.security.secretbox import seal

    raw = json.dumps(meta, separators=(",", ":")).encode()
    return base64.urlsafe_b64encode(seal(_master_key(request), raw, _DROPBOX_CHUNK_TOKEN_AAD)).decode()


def _open_dropbox_upload_token(request: Request, token: str, upload_id: str, db: Session) -> tuple[DropboxUploadLink, dict]:
    from app.security.secretbox import open_box

    try:
        blob = base64.urlsafe_b64decode(upload_id.encode())
        meta = json.loads(open_box(_master_key(request), blob, _DROPBOX_CHUNK_TOKEN_AAD))
    except Exception:
        raise HTTPException(400, detail="invalid upload token")

    row = _resolve_dropbox(db, token)
    if meta.get("did") != row.id or meta.get("th") != row.token_hash:
        raise HTTPException(403, detail="upload token does not match receive link")
    if meta.get("exp", 0) < time.time():
        shutil.rmtree(_parts_dir(meta.get("rel", "")), ignore_errors=True)
        raise HTTPException(410, detail="upload session expired")
    return row, meta


def _dropbox_upload_context(db: Session, row: DropboxUploadLink) -> tuple[User, Directory | None, object]:
    owner = db.get(User, row.owner_id)
    if owner is None:
        raise HTTPException(404, detail="owner not found")
    directory = db.get(Directory, row.target_directory_id) if row.target_directory_id else None
    if row.target_directory_id is not None and directory is None:
        raise HTTPException(404, detail="directory not found")
    perm = ensure_permissions(db, owner.id, master=(owner.role == "master"))
    return owner, directory, perm


@router.get("/dropbox/{token}")
def dropbox_info(token: str, db: Session = Depends(get_db)) -> dict:
    row = _resolve_dropbox(db, token)
    return {
        "status": "active",
        "target_directory_id": row.target_directory_id,
        "expires_at": row.expires_at.isoformat() if row.expires_at else None,
    }


@router.post("/dropbox/{token}/upload/init")
def init_dropbox_upload(
    token: str,
    body: DropboxChunkedInitBody,
    request: Request,
    db: Session = Depends(get_db),
) -> dict:
    row = _resolve_dropbox(db, token)
    owner, directory, perm = _dropbox_upload_context(db, row)
    _precheck_declared_size(db, owner, perm, body.total_size)

    chunk_size = _chunk_upload_size()
    n = _num_chunks(body.total_size, chunk_size)
    rand = secrets.token_hex(32)
    rel_path = f"{rand[:2]}/{rand[2:4]}/{rand[4:]}"
    base_path = storage_root() / rel_path
    base_path.parent.mkdir(parents=True, exist_ok=True)
    _parts_dir(rel_path).mkdir(parents=True, exist_ok=True)

    meta = {
        "v": 1,
        "did": row.id,
        "th": row.token_hash,
        "owner": owner.id,
        "rel": rel_path,
        "total": body.total_size,
        "cs": chunk_size,
        "n": n,
        "fn": body.original_filename,
        "ct": body.content_type,
        "enc": directory.encryption_mode if directory else "none",
        "dir": directory.id if directory is not None else None,
        "exp": int(time.time()) + 12 * 3600,
    }
    _log.info(
        "dropbox chunked upload initialized id=%s owner_id=%s total_bytes=%s chunks=%s chunk_size=%s",
        row.id,
        owner.id,
        body.total_size,
        n,
        chunk_size,
    )
    return {
        "upload_id": _seal_dropbox_upload_token(request, meta),
        "chunk_size": chunk_size,
        "num_chunks": n,
        "total": body.total_size,
        "received": [],
    }


@router.get("/dropbox/{token}/upload/status")
def dropbox_upload_status(
    token: str,
    upload_id: str,
    request: Request,
    db: Session = Depends(get_db),
) -> dict:
    _row, meta = _open_dropbox_upload_token(request, token, upload_id, db)
    parts = _parts_dir(meta["rel"])
    if not parts.exists():
        raise HTTPException(410, detail="upload session gone")
    n = int(meta["n"])
    return {
        "upload_id": upload_id,
        "total": int(meta["total"]),
        "chunk_size": int(meta["cs"]),
        "num_chunks": n,
        "received": _received_indices(parts, n),
    }


@router.post("/dropbox/{token}/upload/chunk")
async def upload_dropbox_chunk(
    token: str,
    upload_id: str,
    index: int,
    request: Request,
    db: Session = Depends(get_db),
) -> dict:
    _row, meta = _open_dropbox_upload_token(request, token, upload_id, db)
    parts = _parts_dir(meta["rel"])
    if not parts.exists():
        raise HTTPException(410, detail="upload session gone")

    total, chunk_size, n = int(meta["total"]), int(meta["cs"]), int(meta["n"])
    expected = _expected_chunk_len(index, total, chunk_size, n)
    if expected < 0:
        raise HTTPException(400, detail="invalid chunk index")

    tmp = parts / f"{index}.{secrets.token_hex(8)}.tmp"
    written = 0
    try:
        with open(tmp, "wb") as fh:
            async for data in request.stream():
                if not data:
                    continue
                written += len(data)
                if written > expected:
                    raise HTTPException(413, detail="chunk exceeds expected size")
                fh.write(data)
        if written != expected:
            raise HTTPException(400, detail="incomplete chunk")
        os.replace(tmp, parts / str(index))
    except BaseException:
        tmp.unlink(missing_ok=True)
        _log.exception(
            "dropbox chunk failed index=%s expected_bytes=%s written_bytes=%s",
            index,
            expected,
            written,
        )
        raise
    return {"index": index, "num_chunks": n}


@router.post("/dropbox/{token}/upload/finalize")
def finalize_dropbox_upload(
    token: str,
    body: DropboxChunkedFinalizeBody,
    request: Request,
    db: Session = Depends(get_db),
) -> dict:
    row, meta = _open_dropbox_upload_token(request, token, body.upload_id, db)
    owner, directory, perm = _dropbox_upload_context(db, row)

    rel_path = meta["rel"]
    parts = _parts_dir(rel_path)
    if not parts.exists():
        raise HTTPException(410, detail="upload session gone")

    total, n = int(meta["total"]), int(meta["n"])
    received = set(_received_indices(parts, n))
    missing = [i for i in range(n) if i not in received]
    if missing:
        raise HTTPException(409, detail={"error": "upload incomplete", "missing": missing[:512]})

    work = (storage_root() / rel_path).with_suffix(".dropbox.part")
    try:
        with open(work, "wb") as out:
            for i in range(n):
                with open(parts / str(i), "rb") as pf:
                    shutil.copyfileobj(pf, out, length=1024 * 1024)
        stored = work.stat().st_size
        if stored != total:
            work.unlink(missing_ok=True)
            raise HTTPException(400, detail="assembled size mismatch")
    except HTTPException:
        raise
    except OSError:
        work.unlink(missing_ok=True)
        raise HTTPException(500, detail="assembly failed")

    result = _finalize_stored_file(
        request=request,
        db=db,
        user=owner,
        perm=perm,
        directory=directory,
        work_path=work,
        rel_path=rel_path,
        stored=stored,
        content_type=meta.get("ct"),
        encryption_mode=meta["enc"],
        compress=False,
        randomize_filename=False,
        original_filename=meta["fn"],
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
    shutil.rmtree(parts, ignore_errors=True)
    _log.info("dropbox chunked upload completed id=%s file_id=%s owner_id=%s", row.id, result["file_id"], owner.id)
    return result


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

