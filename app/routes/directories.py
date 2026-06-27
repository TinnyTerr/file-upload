from __future__ import annotations

import os
import secrets as _secrets
import tempfile
import zipfile
import html
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.orm import Session
from starlette.background import BackgroundTask

from app.audit.log import record
from app.deps import client_ip, get_db, require_active_user, require_master, require_permission
from app.links.slugs import new_slug
from app.security.csrf import require_csrf
from app.models.directory import Directory
from app.models.content_blob import ContentBlob
from app.models.directory_collaborator import DirectoryCollaborator
from app.models.file import FileObject
from app.models.link import Link
from app.models.session import SessionRow
from app.models.user import User
from app.spa import render_spa
from app.storage.blobs import release_blob, unlink_queued
from app.storage.accounting import used_storage_bytes_for_user
from app.storage.paths import safe_join, storage_root

router = APIRouter(tags=["directories"])

# Same hardened headers as the single-file download page: the directory page
# decrypts end-to-end bundles in a Web Worker and zips them in the browser.
_CSP = (
    "default-src 'self'; "
    "script-src 'self'; "
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
    "font-src 'self' https://fonts.gstatic.com; "
    "img-src 'self' data: blob:; "
    "media-src 'self' blob:; "
    "frame-src 'self'; "
    "worker-src 'self' blob:; "
    "connect-src 'self'; "
    "object-src 'none'"
)
_SECURITY = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": _CSP,
}


def _dir_url(request: Request, slug: str) -> str:
    return f"{str(request.base_url).rstrip('/')}/d/{slug}"


def _master_key(request: Request) -> bytes:
    from app.config import get_master_key
    return get_master_key(request.app.state.app_state.settings)


def _recover_access_key(request: Request, d: Directory) -> str | None:
    if d.encryption_mode != "server" or not d.enc_access_blob:
        return None
    try:
        from app.security.secretbox import open_box
        return open_box(_master_key(request), d.enc_access_blob).decode()
    except Exception:
        return None


def _verify_access_key(request: Request, d: Directory, ek: str | None) -> bool:
    if d.encryption_mode != "server":
        return True
    expected = _recover_access_key(request, d)
    if expected is None:
        return False
    if not ek:
        return False
    return _secrets.compare_digest(ek, expected)


def _resolve(db: Session, slug: str) -> Directory:
    d = db.query(Directory).filter_by(slug=slug).first()
    if d is None:
        raise HTTPException(404, detail="not found")
    if d.expires_at is not None and d.expires_at < datetime.now(timezone.utc):
        raise HTTPException(404, detail="directory expired")
    return d


def _is_editor(db: Session, d: Directory, user: User) -> bool:
    if user.role == "master" or d.owner_id == user.id:
        return True
    return (
        db.query(DirectoryCollaborator.id)
        .filter_by(directory_id=d.id, user_id=user.id, role="editor")
        .first()
        is not None
    )


def _directory_role(db: Session, d: Directory, user: User) -> str | None:
    if user.role == "master" or d.owner_id == user.id:
        return "owner"
    collaborator = (
        db.query(DirectoryCollaborator)
        .filter_by(directory_id=d.id, user_id=user.id)
        .first()
    )
    return collaborator.role if collaborator else None


class CreateDirBody(BaseModel):
    title: str = "Untitled folder"
    encryption_mode: str = "none"
    expires_in_seconds: int | None = None


@router.post("/directories")
def create_directory(
    body: CreateDirBody,
    request: Request,
    _csrf: SessionRow = Depends(require_csrf),
    user: User = Depends(require_active_user),
    db: Session = Depends(get_db),
) -> dict:
    if body.encryption_mode not in ("none", "server", "client"):
        raise HTTPException(400, detail="invalid encryption_mode")

    from app.permissions.policy import ensure_permissions
    perm = ensure_permissions(db, user.id, master=(user.role == "master"))
    if not perm.can_create_directories:
        raise HTTPException(403, detail="directory creation not permitted")

    if body.encryption_mode == "client":
        if not perm.can_upload_client_encrypted:
            raise HTTPException(403, detail="client-side encryption not permitted")

    title = (body.title or "Untitled folder").strip()[:512] or "Untitled folder"
    expires_at = None
    if body.expires_in_seconds is not None and body.expires_in_seconds >= 1:
        try:
            expires_at = datetime.now(timezone.utc) + timedelta(seconds=body.expires_in_seconds)
        except OverflowError:
            raise HTTPException(400, detail="expires_in_seconds is too large")

    enc_key_blob = None
    enc_access_blob = None
    access_key = None
    if body.encryption_mode == "server":
        from app.security.secretbox import seal
        master_key = _master_key(request)
        dir_key = _secrets.token_bytes(32)
        access_key = _secrets.token_urlsafe(18)
        enc_key_blob = seal(master_key, dir_key)
        enc_access_blob = seal(master_key, access_key.encode())

    slug = new_slug()
    d = Directory(
        owner_id=user.id,
        slug=slug,
        title=title,
        encryption_mode=body.encryption_mode,
        enc_key_blob=enc_key_blob,
        enc_access_blob=enc_access_blob,
        expires_at=expires_at,
    )
    db.add(d)
    db.flush()
    record(db, actor=user.username, action="directory.created",
           target=f"directory:{d.id}", ip=client_ip(request))
    db.commit()

    return {
        "id": d.id,
        "slug": slug,
        "url": _dir_url(request, slug),
        "encryption_mode": d.encryption_mode,
        # client-side keys are generated in the browser and never sent here.
        "access_key": access_key,
    }


@router.get("/directories/")
def list_directories(
    request: Request,
    user: User = Depends(require_active_user),
    db: Session = Depends(get_db),
) -> dict:
    owned = (
        db.query(Directory)
        .filter_by(owner_id=user.id)
        .all()
    )
    collaborated = (
        db.query(Directory)
        .join(DirectoryCollaborator, DirectoryCollaborator.directory_id == Directory.id)
        .filter(DirectoryCollaborator.user_id == user.id)
        .all()
    )
    by_id = {d.id: d for d in owned}
    for d in collaborated:
        by_id.setdefault(d.id, d)
    dirs = sorted(by_id.values(), key=lambda d: d.created_at, reverse=True)
    return {"directories": _serialize_directories(request, db, dirs, user=user)}


@router.get("/admin/directories")
def list_admin_directories(
    request: Request,
    _master: User = Depends(require_master),
    db: Session = Depends(get_db),
) -> dict:
    dirs = db.query(Directory).order_by(Directory.created_at.desc()).all()
    return {"directories": _serialize_directories(request, db, dirs)}


def _serialize_directories(
    request: Request,
    db: Session,
    dirs: list[Directory],
    *,
    user: User | None = None,
) -> list[dict]:
    result = []
    for d in dirs:
        file_count = db.query(func.count(FileObject.id)).filter_by(directory_id=d.id).scalar() or 0
        result.append({
            "id": d.id,
            "owner_id": d.owner_id,
            "slug": d.slug,
            "title": d.title,
            "url": _dir_url(request, d.slug),
            "encryption_mode": d.encryption_mode,
            "access_key": _recover_access_key(request, d),
            "file_count": file_count,
            "total_bytes": d.total_bytes,
            "expires_at": d.expires_at.isoformat() if d.expires_at else None,
            "created_at": d.created_at.isoformat(),
            "role": _directory_role(db, d, user) if user is not None else None,
        })
    return result


def _get_owned_directory(db: Session, dir_id: int, user: User) -> Directory:
    d = db.get(Directory, dir_id)
    if d is None:
        raise HTTPException(404, detail="not found")
    if user.role != "master" and d.owner_id != user.id:
        raise HTTPException(403, detail="not your directory")
    return d


def _get_editable_directory(db: Session, dir_id: int, user: User) -> Directory:
    d = db.get(Directory, dir_id)
    if d is None:
        raise HTTPException(404, detail="not found")
    if not _is_editor(db, d, user):
        raise HTTPException(403, detail="not your directory")
    return d


@router.get("/directories/{dir_id}/files")
def list_directory_files(
    dir_id: int,
    user: User = Depends(require_active_user),
    db: Session = Depends(get_db),
) -> dict:
    d = _get_editable_directory(db, dir_id, user)
    members = (
        db.query(FileObject)
        .filter_by(directory_id=d.id)
        .order_by(FileObject.created_at.asc())
        .all()
    )

    files = []
    for f in members:
        link = (
            db.query(Link)
            .filter_by(file_id=f.id, active=True)
            .order_by(Link.created_at.desc())
            .first()
        )
        files.append({
            "id": f.id,
            "slug": link.slug if link else None,
            "filename": f.original_filename,
            "size_bytes": f.size_bytes,
            "stored_size_bytes": f.stored_size_bytes,
            "content_type": f.content_type,
            "encryption_mode": f.encryption_mode,
            "created_at": f.created_at.isoformat(),
        })
    return {"files": files}


@router.delete("/directories/{dir_id}/files/{file_id}")
def delete_directory_file(
    dir_id: int,
    file_id: int,
    request: Request,
    _csrf: SessionRow = Depends(require_csrf),
    user: User = Depends(require_active_user),
    db: Session = Depends(get_db),
) -> dict:
    d = _get_editable_directory(db, dir_id, user)
    file_obj = db.get(FileObject, file_id)
    if file_obj is None or file_obj.directory_id != d.id:
        raise HTTPException(404, detail="not found")

    db.query(Link).filter_by(file_id=file_obj.id).delete()
    d.total_bytes = max(0, (d.total_bytes or 0) - (file_obj.size_bytes or 0))
    unlink_after_commit = [release_blob(db, file_obj)]
    db.delete(file_obj)
    record(db, actor=user.username, action="directory.file_deleted",
           target=f"file:{file_id}", ip=client_ip(request))
    db.commit()
    unlink_queued(unlink_after_commit)
    return {"status": "deleted"}


class CollaboratorBody(BaseModel):
    username: str


@router.post("/directories/{dir_id}/collaborators")
def add_collaborator(
    dir_id: int,
    body: CollaboratorBody,
    request: Request,
    _csrf: SessionRow = Depends(require_csrf),
    user: User = Depends(require_active_user),
    db: Session = Depends(get_db),
) -> dict:
    d = _get_owned_directory(db, dir_id, user)
    target = db.query(User).filter_by(username=body.username.strip()).first()
    if target is None:
        raise HTTPException(404, detail="user not found")
    if target.id == d.owner_id:
        raise HTTPException(400, detail="owner is already a collaborator")
    existing = (
        db.query(DirectoryCollaborator)
        .filter_by(directory_id=d.id, user_id=target.id)
        .first()
    )
    if existing is None:
        existing = DirectoryCollaborator(
            directory_id=d.id,
            user_id=target.id,
            invited_by_id=user.id,
            role="editor",
        )
        db.add(existing)
        db.flush()
    record(db, actor=user.username, action="directory.collaborator_added",
           target=f"directory:{d.id}:user:{target.id}", ip=client_ip(request))
    db.commit()
    return {
        "id": existing.id,
        "directory_id": d.id,
        "user_id": target.id,
        "username": target.username,
        "role": existing.role,
    }


@router.delete("/directories/{dir_id}/collaborators/{user_id}")
def remove_collaborator(
    dir_id: int,
    user_id: int,
    request: Request,
    _csrf: SessionRow = Depends(require_csrf),
    user: User = Depends(require_active_user),
    db: Session = Depends(get_db),
) -> dict:
    d = _get_owned_directory(db, dir_id, user)
    row = (
        db.query(DirectoryCollaborator)
        .filter_by(directory_id=d.id, user_id=user_id)
        .first()
    )
    if row is None:
        raise HTTPException(404, detail="not found")
    db.delete(row)
    record(db, actor=user.username, action="directory.collaborator_removed",
           target=f"directory:{d.id}:user:{user_id}", ip=client_ip(request))
    db.commit()
    return {"status": "removed"}


@router.delete("/directories/{dir_id}")
def delete_directory(
    dir_id: int,
    request: Request,
    _csrf: SessionRow = Depends(require_csrf),
    user: User = Depends(require_active_user),
    db: Session = Depends(get_db),
) -> dict:
    d = db.get(Directory, dir_id)
    if d is None:
        raise HTTPException(404, detail="not found")
    if user.role != "master" and d.owner_id != user.id:
        raise HTTPException(403, detail="not your directory")

    members = db.query(FileObject).filter_by(directory_id=d.id).all()
    unlink_after_commit: list[str | None] = []
    for f in members:
        db.query(Link).filter_by(file_id=f.id).delete()
        unlink_after_commit.append(release_blob(db, f))
        db.delete(f)

    # Without an ORM relationship, the unit of work won't order child deletes
    # before the parent — flush the member removals first so the directory's
    # foreign keys are clear before we drop it.
    db.flush()
    db.query(DirectoryCollaborator).filter_by(directory_id=d.id).delete()
    db.delete(d)
    record(db, actor=user.username, action="directory.deleted",
           target=f"directory:{dir_id}", ip=client_ip(request))
    db.commit()
    unlink_queued(unlink_after_commit)
    return {"status": "deleted", "files_removed": len(members)}


def _public_files(db: Session, d: Directory) -> list[tuple[FileObject, Link]]:
    """Member files paired with their (most recent active) link slug."""
    out = []
    members = (
        db.query(FileObject)
        .filter_by(directory_id=d.id)
        .order_by(FileObject.created_at.asc())
        .all()
    )
    for f in members:
        link = (
            db.query(Link)
            .filter_by(file_id=f.id, active=True)
            .order_by(Link.created_at.desc())
            .first()
        )
        if link is not None:
            out.append((f, link))
    return out


@router.get("/d/{slug}/info")
def directory_info(slug: str, db: Session = Depends(get_db)) -> dict:
    d = _resolve(db, slug)
    pairs = _public_files(db, d)
    return {
        "title": d.title,
        "encryption_mode": d.encryption_mode,
        "file_count": len(pairs),
        "total_bytes": sum(f.size_bytes for f, _ in pairs),
        "files": [
            {
                "slug": lk.slug,
                "filename": f.original_filename,
                "size_bytes": f.size_bytes,
                "content_type": f.content_type,
            }
            for f, lk in pairs
        ],
    }


def _preview_group(content_type: str, filename: str) -> str:
    ct = (content_type or "application/octet-stream").lower()
    name = filename.lower()
    if ct.startswith("image/"):
        return "images"
    if ct.startswith("video/"):
        return "videos"
    if ct.startswith("audio/"):
        return "audio"
    if ct.startswith("text/") or name.endswith((".txt", ".md", ".json", ".csv", ".log")):
        return "text"
    if ct == "application/pdf" or name.endswith(".pdf"):
        return "pdfs"
    if ct in {"application/zip", "application/x-zip-compressed"} or name.endswith(".zip"):
        return "archives"
    return "other"


def _archive_preview(f: FileObject) -> dict:
    if f.encryption_mode != "none" or f.compressed or f.archived:
        return {"status": "unreadable", "reason": "encrypted or transformed archive"}
    try:
        path = safe_join(storage_root(), f.storage_path)
        with zipfile.ZipFile(path) as zf:
            encrypted = any(info.flag_bits & 0x1 for info in zf.infolist())
            if encrypted:
                return {"status": "unreadable", "reason": "encrypted archive"}
            return {
                "status": "readable",
                "entries": zf.namelist()[:100],
                "entry_count": len(zf.infolist()),
            }
    except Exception:
        return {"status": "unreadable", "reason": "corrupt or unsupported archive"}


@router.get("/d/{slug}/preview-manifest")
def directory_preview_manifest(slug: str, db: Session = Depends(get_db)) -> dict:
    d = _resolve(db, slug)
    groups = {
        "images": [],
        "videos": [],
        "audio": [],
        "text": [],
        "pdfs": [],
        "archives": [],
        "other": [],
    }
    for f, link in _public_files(db, d):
        row = {
            "id": f.id,
            "slug": link.slug,
            "filename": f.original_filename,
            "size_bytes": f.size_bytes,
            "content_type": f.content_type,
            "encryption_mode": f.encryption_mode,
            "preview_url": f"/file/{link.slug}/preview",
            "download_url": f"/file/{link.slug}/raw",
        }
        group = _preview_group(f.content_type, f.original_filename)
        if group == "archives":
            row["preview"] = _archive_preview(f)
        groups[group].append(row)
    return {
        "id": d.id,
        "title": d.title,
        "slug": d.slug,
        "encryption_mode": d.encryption_mode,
        "file_count": sum(len(v) for v in groups.values()),
        "groups": groups,
    }


@router.post("/d/{slug}/save")
def save_directory(
    slug: str,
    request: Request,
    _csrf: SessionRow = Depends(require_csrf),
    user: User = Depends(require_active_user),
    db: Session = Depends(get_db),
) -> dict:
    from app.permissions.policy import ensure_permissions

    source_dir = _resolve(db, slug)
    pairs = _public_files(db, source_dir)
    logical_bytes = sum(f.size_bytes for f, _ in pairs)
    perm = ensure_permissions(db, user.id, master=(user.role == "master"))
    if used_storage_bytes_for_user(db, user.id) + logical_bytes > perm.quota_bytes:
        raise HTTPException(413, detail="save would exceed your quota")

    new_dir = Directory(
        owner_id=user.id,
        slug=new_slug(),
        title=source_dir.title,
        encryption_mode=source_dir.encryption_mode,
        enc_key_blob=source_dir.enc_key_blob,
        enc_access_blob=source_dir.enc_access_blob,
        total_bytes=logical_bytes,
    )
    db.add(new_dir)
    db.flush()
    saved_files = 0
    for source, _link in pairs:
        blob = db.get(ContentBlob, source.blob_id) if source.blob_id else None
        if blob is not None:
            blob.ref_count = (blob.ref_count or 0) + 1
        copied = FileObject(
            owner_id=user.id,
            directory_id=new_dir.id,
            blob_id=source.blob_id,
            storage_path=source.storage_path,
            original_filename=source.original_filename,
            source_type="saved",
            saved_from_file_id=source.id,
            size_bytes=source.size_bytes,
            stored_size_bytes=source.stored_size_bytes,
            content_type=source.content_type,
            encryption_mode=source.encryption_mode,
            enc_key_blob=source.enc_key_blob,
            enc_access_blob=source.enc_access_blob,
            compressed=source.compressed,
            archived=source.archived,
            archive_codec=source.archive_codec,
            archive_original_stored_size_bytes=source.archive_original_stored_size_bytes,
            archive_saved_bytes=source.archive_saved_bytes,
            archive_after_idle_days=source.archive_after_idle_days,
            lifecycle_state=source.lifecycle_state,
            is_permanent=True,
            delete_if_idle_days=source.delete_if_idle_days,
            auto_unarchive_on_download=source.auto_unarchive_on_download,
        )
        db.add(copied)
        db.flush()
        db.add(Link(file_id=copied.id, slug=new_slug()))
        saved_files += 1
    record(db, actor=user.username, action="directory.saved",
           target=f"directory:{source_dir.id}->directory:{new_dir.id}", ip=client_ip(request))
    db.commit()
    return {
        "id": new_dir.id,
        "slug": new_dir.slug,
        "url": _dir_url(request, new_dir.slug),
        "saved_files": saved_files,
        "source_type": "saved",
        "access_key": _recover_access_key(request, new_dir),
    }


def _new_tempfile(suffix: str) -> Path:
    fd, p = tempfile.mkstemp(suffix=suffix)
    os.close(fd)
    return Path(p)


def _member_source(request: Request, f: FileObject) -> tuple[Path, bool]:
    """Resolve a member to a path holding its plaintext bytes.

    Returns (path, is_temp); the caller unlinks when is_temp is True. Everything
    streams through temp files instead of buffering whole members in RAM.

    Members are only ever compressed by the archive lifecycle job, which wraps the
    (already server-encrypted) bytes — so decompression must run BEFORE decryption.
    """
    full = safe_join(storage_root(), f.storage_path)
    if not full.exists():
        raise HTTPException(500, detail="file missing from storage")

    needs_decompress = bool(f.compressed or f.archived)
    needs_decrypt = f.encryption_mode == "server"
    if not needs_decompress and not needs_decrypt:
        return full, False

    src = full
    intermediate: Path | None = None
    try:
        if needs_decompress:
            from app.storage.compress import decompress_stream
            dec = _new_tempfile(".dec")
            intermediate = dec
            with open(dec, "wb") as out:
                for chunk in decompress_stream(src, f.size_bytes):
                    out.write(chunk)
            src = dec

        if needs_decrypt:
            from app.crypto.aead import decrypt_stream
            from app.security.secretbox import open_box
            if not f.enc_key_blob:
                raise HTTPException(500, detail="encryption key not stored")
            key = open_box(_master_key(request), f.enc_key_blob)
            plain = _new_tempfile(".plain")
            try:
                with open(plain, "wb") as out:
                    for chunk in decrypt_stream(key, src):
                        out.write(chunk)
            except Exception:
                plain.unlink(missing_ok=True)
                raise
            if intermediate is not None:
                intermediate.unlink(missing_ok=True)
            return plain, True

        return src, True
    except Exception:
        if intermediate is not None:
            intermediate.unlink(missing_ok=True)
        raise


@router.get("/d/{slug}/zip")
def directory_zip(slug: str, request: Request, ek: str | None = None, db: Session = Depends(get_db)):
    d = _resolve(db, slug)
    if d.encryption_mode == "client":
        # End-to-end bundles can only be assembled in the browser (the server
        # never holds the key). The directory page zips them client-side.
        raise HTTPException(400, detail="end-to-end encrypted bundle — download from the directory page")
    if not _verify_access_key(request, d, ek):
        raise HTTPException(401, detail="missing or invalid access key (?ek=)")

    pairs = _public_files(db, d)
    if not pairs:
        raise HTTPException(404, detail="directory is empty")

    fd, tmp_path = tempfile.mkstemp(suffix=".zip")
    os.close(fd)
    tmp = Path(tmp_path)
    try:
        seen: set[str] = set()
        with zipfile.ZipFile(tmp, "w", zipfile.ZIP_STORED) as zf:
            for f, _lk in pairs:
                name = _safe_arcname(f.original_filename, seen)
                # Stream each member from disk (zf.write) instead of loading its
                # full plaintext into memory (zf.writestr) — a bundle of large
                # files would otherwise exhaust server RAM.
                src, is_temp = _member_source(request, f)
                try:
                    zf.write(src, name)
                finally:
                    if is_temp:
                        src.unlink(missing_ok=True)
    except Exception:
        tmp.unlink(missing_ok=True)
        raise

    try:
        record(db, actor="anonymous", action="directory.downloaded",
               target=f"directory:{d.id}", ip=client_ip(request))
        db.commit()
    except Exception:
        db.rollback()

    zip_name = (d.title or "bundle").strip().replace('"', "") or "bundle"
    return FileResponse(
        str(tmp),
        media_type="application/zip",
        filename=f"{zip_name}.zip",
        headers=_SECURITY,
        background=BackgroundTask(lambda p=tmp: p.unlink(missing_ok=True)),
    )


def _safe_arcname(name: str, seen: set[str]) -> str:
    """Flatten to a safe in-zip name and de-duplicate collisions.

    Probes generated candidates against everything already emitted (not just the
    original clean names), so a synthesized "file (1).txt" can't silently collide
    with a real "file (1).txt" that exists in the same bundle.
    """
    base = os.path.basename(name.replace("\\", "/")).strip() or "file"
    base = "".join(c for c in base if ord(c) >= 0x20)
    stem, dot, ext = base.partition(".")
    candidate = base
    counter = 1
    while candidate in seen:
        candidate = f"{stem} ({counter}){dot}{ext}" if dot else f"{base} ({counter})"
        counter += 1
    seen.add(candidate)
    return candidate


def _directory_page_meta(request: Request, d: Directory, db: Session) -> str:
    pairs = _public_files(db, d)
    title = html.escape(d.title or "Shared folder", quote=True)
    desc = html.escape(
        f"{len(pairs)} files, {sum(f.size_bytes for f, _ in pairs)} bytes",
        quote=True,
    )
    url = html.escape(str(request.url), quote=True)
    return "\n".join(
        [
            f'<meta property="og:title" content="{title}">',
            f'<meta property="og:description" content="{desc}">',
            f'<meta property="og:url" content="{url}">',
            '<meta property="og:type" content="website">',
            f'<meta name="twitter:title" content="{title}">',
            f'<meta name="twitter:description" content="{desc}">',
        ]
    )


@router.get("/d/{slug}")
def directory_page(slug: str, request: Request, db: Session = Depends(get_db)):
    d = _resolve(db, slug)
    # Serve the React SPA shell with server-rendered OG meta tags injected (link
    # unfurlers don't run JS); the client renders the directory view.
    content = render_spa(_directory_page_meta(request, d, db))
    return HTMLResponse(content, headers=_SECURITY)
