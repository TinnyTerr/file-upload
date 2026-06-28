from __future__ import annotations

import logging
import os
import shutil
from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.audit.log import record
from app.deps import client_ip, get_db, require_active_user, require_master
from app.jobs.lifecycle import (
    archive_idle_job,
    delete_idle_job,
    link_expiry_job,
    reconcile_stale_states,
    temp_expiry_job,
)
from app.models.api_key import ApiKey
from app.models.audit import AuditEntry
from app.models.directory import Directory
from app.models.directory_collaborator import DirectoryCollaborator
from app.models.file import FileObject
from app.models.link import Link
from app.models.permission import Permission
from app.models.remote_upload_job import RemoteUploadJob
from app.models.session import SessionRow
from app.models.user import User
from app.permissions.policy import ensure_permissions, has_permission
from app.security.csrf import require_csrf
from app.storage.accounting import (
    allocated_quota_bytes,
    dedup_saved_bytes,
    ensure_storage_settings,
    set_global_storage_cap,
    used_storage_bytes,
    used_storage_bytes_for_user,
)
from app.storage.blobs import release_blob
from app.storage.paths import safe_join, storage_root

router = APIRouter(prefix="/admin", tags=["admin"])
_log = logging.getLogger(__name__)


class StorageSettingsBody(BaseModel):
    global_storage_quota_bytes: int = Field(..., ge=0)


class BulkActionBody(BaseModel):
    action: str
    ids: list[int] = Field(default_factory=list)
    owner_id: int | None = Field(None, ge=1)
    confirm: str | None = None


def _pct(part: int, total: int | None) -> float:
    if not total or total <= 0:
        return 0.0
    return round((part / total) * 100, 2)


def _link_status(link: Link, now: datetime) -> str:
    if not link.active:
        return "inactive"
    if link.expires_at is not None and link.expires_at < now:
        return "expired"
    if link.max_uses is not None and link.use_count >= link.max_uses:
        return "used_up"
    return "active"


@router.get("/storage")
def storage_details(
    _master: User = Depends(require_master),
    db: Session = Depends(get_db),
) -> dict:
    settings = ensure_storage_settings(db)
    used = used_storage_bytes(db)
    allocated = allocated_quota_bytes(db)
    users = db.query(User).order_by(User.created_at).all()
    user_rows = []
    for u in users:
        perm = db.query(Permission).filter_by(user_id=u.id).one_or_none()
        user_used = used_storage_bytes_for_user(db, u.id)
        link_count = (
            db.query(func.count(Link.id))
            .join(FileObject, Link.file_id == FileObject.id)
            .filter(FileObject.owner_id == u.id)
            .scalar()
            or 0
        )
        user_rows.append({
            "id": u.id,
            "username": u.username,
            "role": u.role,
            "used_bytes": user_used,
            "quota_bytes": perm.quota_bytes if perm else None,
            "quota_percent": _pct(user_used, perm.quota_bytes if perm else None),
            "file_count": db.query(func.count(FileObject.id)).filter_by(owner_id=u.id).scalar() or 0,
            "link_count": link_count,
            "api_key_count": db.query(func.count(ApiKey.id)).filter_by(owner_id=u.id).scalar() or 0,
        })

    lifecycle_counts = {
        state: count
        for state, count in db.query(FileObject.lifecycle_state, func.count(FileObject.id))
        .group_by(FileObject.lifecycle_state)
        .all()
    }
    content_type_counts = [
        {
            "content_type": ct or "application/octet-stream",
            "count": count,
            "stored_bytes": stored or 0,
            "size_bytes": size or 0,
        }
        for ct, count, stored, size in db.query(
            FileObject.content_type,
            func.count(FileObject.id),
            func.sum(FileObject.stored_size_bytes),
            func.sum(FileObject.size_bytes),
        )
        .group_by(FileObject.content_type)
        .order_by(func.count(FileObject.id).desc())
        .all()
    ]
    now = datetime.now(timezone.utc)
    link_status_counts = {"active": 0, "inactive": 0, "expired": 0, "used_up": 0}
    for link in db.query(Link).all():
        link_status_counts[_link_status(link, now)] += 1

    # Deleted keys are soft-deleted (active=False) so their per-user numbers stay
    # stable, but a revoked key isn't an operational "inactive" key — count the
    # live-key breakdown and surface revoked keys separately.
    api_key_status_counts = {
        "active": db.query(func.count(ApiKey.id)).filter_by(active=True).scalar() or 0,
        "inactive": 0,
        "revoked": db.query(func.count(ApiKey.id)).filter_by(active=False).scalar() or 0,
        "bound": db.query(func.count(ApiKey.id)).filter(ApiKey.active.is_(True), ApiKey.bound_ip.is_not(None)).scalar() or 0,
        "unbound": db.query(func.count(ApiKey.id)).filter(ApiKey.active.is_(True), ApiKey.bound_ip.is_(None)).scalar() or 0,
    }
    recent_audit_counts = [
        {"action": action, "count": count}
        for action, count in db.query(AuditEntry.action, func.count(AuditEntry.id))
        .group_by(AuditEntry.action)
        .order_by(func.count(AuditEntry.id).desc(), AuditEntry.action.asc())
        .limit(12)
        .all()
    ]
    try:
        disk_usage = shutil.disk_usage(str(storage_root()))
        disk = {
            "total_bytes": disk_usage.total,
            "used_bytes": disk_usage.used,
            "free_bytes": disk_usage.free,
        }
    except OSError:
        disk = {"total_bytes": 0, "used_bytes": 0, "free_bytes": 0}

    db.commit()
    dedup_saved = dedup_saved_bytes(db)
    top_downloaded_files = [
        {
            "id": file_id,
            "filename": filename,
            "owner_id": owner_id,
            "downloads": int(downloads or 0),
        }
        for file_id, filename, owner_id, downloads in db.query(
            FileObject.id,
            FileObject.original_filename,
            FileObject.owner_id,
            func.coalesce(func.sum(Link.use_count), 0),
        )
        .outerjoin(Link, Link.file_id == FileObject.id)
        .group_by(FileObject.id, FileObject.original_filename, FileObject.owner_id)
        .order_by(func.coalesce(func.sum(Link.use_count), 0).desc(), FileObject.id.asc())
        .limit(10)
        .all()
    ]
    biggest_files = [
        {
            "id": f.id,
            "filename": f.original_filename,
            "owner_id": f.owner_id,
            "size_bytes": f.size_bytes,
            "stored_size_bytes": f.stored_size_bytes,
        }
        for f in db.query(FileObject).order_by(FileObject.size_bytes.desc(), FileObject.id.asc()).limit(10).all()
    ]
    source_type_counts = {
        source or "upload": int(count)
        for source, count in db.query(FileObject.source_type, func.count(FileObject.id))
        .group_by(FileObject.source_type)
        .all()
    }
    file_type_counts = {
        ct or "application/octet-stream": {
            "count": int(count),
            "bytes": int(size or 0),
            "stored_bytes": int(stored or 0),
        }
        for ct, count, size, stored in db.query(
            FileObject.content_type,
            func.count(FileObject.id),
            func.sum(FileObject.size_bytes),
            func.sum(FileObject.stored_size_bytes),
        )
        .group_by(FileObject.content_type)
        .all()
    }
    fun_stats = {
        "dedup_saved_bytes": dedup_saved,
        "archive_saved_bytes": db.query(func.sum(FileObject.archive_saved_bytes)).scalar() or 0,
        "top_downloaded_files": top_downloaded_files,
        "top_storage_users": sorted(user_rows, key=lambda row: row["used_bytes"], reverse=True)[:10],
        "biggest_files": biggest_files,
        "file_type_counts": file_type_counts,
        "source_type_counts": source_type_counts,
        "remote_upload_counts": {
            status or "unknown": int(count)
            for status, count in db.query(RemoteUploadJob.status, func.count(RemoteUploadJob.id))
            .group_by(RemoteUploadJob.status)
            .all()
        },
        "dropbox_upload_count": source_type_counts.get("dropbox", 0),
        "remote_upload_count": source_type_counts.get("remote", 0),
        "collaborator_count": db.query(func.count(DirectoryCollaborator.id)).scalar() or 0,
        "busiest_directories": [
            {
                "id": d.id,
                "title": d.title,
                "owner_id": d.owner_id,
                "file_count": db.query(func.count(FileObject.id)).filter_by(directory_id=d.id).scalar() or 0,
                "total_bytes": d.total_bytes,
            }
            for d in db.query(Directory).order_by(Directory.total_bytes.desc(), Directory.id.asc()).limit(10).all()
        ],
    }
    return {
        "global_storage_quota_bytes": settings.global_storage_quota_bytes,
        "used_bytes": used,
        "allocated_quota_bytes": allocated,
        "storage_summary": {
            "used_percent": _pct(used, settings.global_storage_quota_bytes),
            "allocated_percent": _pct(allocated, settings.global_storage_quota_bytes),
            "free_under_cap_bytes": max(0, settings.global_storage_quota_bytes - used),
            "unallocated_quota_bytes": max(0, settings.global_storage_quota_bytes - allocated),
        },
        "disk": disk,
        "archive_saved_bytes": db.query(func.sum(FileObject.archive_saved_bytes)).scalar() or 0,
        "dedup_saved_bytes": dedup_saved,
        "total_files": db.query(func.count(FileObject.id)).scalar() or 0,
        "total_links": db.query(func.count(Link.id)).scalar() or 0,
        "active_links": db.query(func.count(Link.id)).filter_by(active=True).scalar() or 0,
        "total_api_keys": db.query(func.count(ApiKey.id)).scalar() or 0,
        "users": user_rows,
        "lifecycle_counts": lifecycle_counts,
        "content_type_counts": content_type_counts,
        "link_status_counts": link_status_counts,
        "api_key_status_counts": api_key_status_counts,
        "recent_audit_counts": recent_audit_counts,
        "fun_stats": fun_stats,
    }


@router.patch("/storage")
def update_storage_settings(
    body: StorageSettingsBody,
    request: Request,
    _csrf: SessionRow = Depends(require_csrf),
    master: User = Depends(require_master),
    db: Session = Depends(get_db),
) -> dict:
    settings = set_global_storage_cap(db, body.global_storage_quota_bytes)
    record(db, actor=master.username, action="storage.global_quota_updated",
           target="storage:global", ip=client_ip(request))
    _log.warning(
        "global storage cap updated actor_id=%s cap_bytes=%s",
        master.id,
        body.global_storage_quota_bytes,
    )
    db.commit()
    return {
        "global_storage_quota_bytes": settings.global_storage_quota_bytes,
        "used_bytes": used_storage_bytes(db),
        "allocated_quota_bytes": allocated_quota_bytes(db),
    }


@router.get("/backend/logs")
def backend_logs(
    q: str | None = Query(None, max_length=200),
    level: str | None = Query(None, max_length=16),
    limit: int = Query(200, ge=1, le=1000),
    _master: User = Depends(require_master),
) -> dict:
    from app.observability.log_buffer import query_backend_logs

    return query_backend_logs(q=q, level=level, limit=limit)


@router.post("/backend/restart-workers")
def restart_backend_workers(
    request: Request,
    _csrf: SessionRow = Depends(require_csrf),
    master: User = Depends(require_master),
) -> dict:
    restart = getattr(request.app.state, "restart_backend_workers", None)
    if restart is None:
        raise HTTPException(503, detail="backend worker restart is not available")
    _log.warning("backend worker restart requested actor_id=%s", master.id)
    result = restart()
    _log.warning("backend worker restart completed actor_id=%s jobs=%s", master.id, result.get("jobs"))
    return result


def _get_file(db: Session, file_id: int) -> FileObject:
    f = db.get(FileObject, file_id)
    if f is None:
        raise HTTPException(404, detail="not found")
    return f


def _serialize_file_lifecycle(f: FileObject) -> dict:
    return {
        "id": f.id,
        "archived": f.archived,
        "lifecycle_state": f.lifecycle_state,
        "stored_size_bytes": f.stored_size_bytes,
        "archive_original_stored_size_bytes": f.archive_original_stored_size_bytes,
        "archive_saved_bytes": f.archive_saved_bytes,
    }


def _bulk_action_permission(action: str) -> str:
    permissions = {
        "delete_api_keys": "can_manage_api_keys",
        "reset_api_key_ips": "can_manage_api_keys",
        "delete_inactive_links": "can_delete_links",
        "delete_files": "can_manage_storage",
        "delete_directories": "can_manage_storage",
        "archive_files": "can_manage_lifecycle",
        "unarchive_files": "can_manage_lifecycle",
        "run_cleanup_jobs": "can_manage_lifecycle",
    }
    try:
        return permissions[action]
    except KeyError:
        raise HTTPException(400, detail="unknown bulk action")


def _require_bulk_permission(action: str, user: User, db: Session) -> None:
    if user.role == "master":
        return
    perm = ensure_permissions(db, user.id, master=False)
    if not perm.can_view_admin or not has_permission(perm, _bulk_action_permission(action)):
        raise HTTPException(403, detail="permission denied")


def _dedupe_ids(ids: list[int]) -> list[int]:
    seen: set[int] = set()
    out: list[int] = []
    for raw in ids:
        if raw > 0 and raw not in seen:
            seen.add(raw)
            out.append(raw)
    return out


def _bulk_label(obj) -> str:
    if isinstance(obj, ApiKey):
        return f"API key #{obj.user_key_number or obj.id}"
    if isinstance(obj, Link):
        return f"link:{obj.id}"
    if isinstance(obj, FileObject):
        return obj.original_filename
    if isinstance(obj, Directory):
        return obj.title or f"folder:{obj.id}"
    return str(getattr(obj, "id", obj))


def _bulk_candidates(action: str, body: BulkActionBody, db: Session) -> list:
    _bulk_action_permission(action)
    ids = _dedupe_ids(body.ids)

    if action == "delete_api_keys":
        q = db.query(ApiKey)
        if ids:
            q = q.filter(ApiKey.id.in_(ids))
        if body.owner_id is not None:
            q = q.filter(ApiKey.owner_id == body.owner_id)
        return q.order_by(ApiKey.owner_id.asc(), ApiKey.user_key_number.asc(), ApiKey.id.asc()).all()

    if action == "reset_api_key_ips":
        q = db.query(ApiKey).filter(ApiKey.bound_ip.is_not(None))
        if ids:
            q = q.filter(ApiKey.id.in_(ids))
        if body.owner_id is not None:
            q = q.filter(ApiKey.owner_id == body.owner_id)
        return q.order_by(ApiKey.owner_id.asc(), ApiKey.user_key_number.asc(), ApiKey.id.asc()).all()

    if action == "delete_inactive_links":
        q = db.query(Link).join(FileObject, Link.file_id == FileObject.id)
        if ids:
            q = q.filter(Link.id.in_(ids))
        if body.owner_id is not None:
            q = q.filter(FileObject.owner_id == body.owner_id)
        now = datetime.now(timezone.utc)
        return [
            link for link in q.order_by(Link.id.asc()).all()
            if _link_status(link, now) != "active"
        ]

    if action in {"delete_files", "archive_files", "unarchive_files"}:
        q = db.query(FileObject)
        if ids:
            q = q.filter(FileObject.id.in_(ids))
        if body.owner_id is not None:
            q = q.filter(FileObject.owner_id == body.owner_id)
        if action == "archive_files":
            q = q.filter(FileObject.archived.is_(False), FileObject.encryption_mode != "client")
        elif action == "unarchive_files":
            q = q.filter(FileObject.archived.is_(True))
        return q.order_by(FileObject.id.asc()).all()

    if action == "delete_directories":
        q = db.query(Directory)
        if ids:
            q = q.filter(Directory.id.in_(ids))
        if body.owner_id is not None:
            q = q.filter(Directory.owner_id == body.owner_id)
        return q.order_by(Directory.id.asc()).all()

    if action == "run_cleanup_jobs":
        return ["temp-expiry", "idle-delete", "link-expiry", "reconcile"]

    raise HTTPException(400, detail="unknown bulk action")


def _bulk_preview_payload(action: str, candidates: list) -> dict:
    count = len(candidates)
    return {
        "action": action,
        "affected_count": count,
        "confirmation_phrase": f"CONFIRM {count}",
        "items": [
            {"id": getattr(item, "id", idx + 1), "label": _bulk_label(item)}
            for idx, item in enumerate(candidates[:50])
        ],
    }


def _queue_file_delete(db: Session, file_obj: FileObject) -> str | None:
    db.query(Link).filter_by(file_id=file_obj.id).delete()
    if file_obj.directory_id is not None:
        directory = db.get(Directory, file_obj.directory_id)
        if directory is not None:
            directory.total_bytes = max(
                0,
                (directory.total_bytes or 0) - (file_obj.size_bytes or 0),
            )
    full_path = release_blob(db, file_obj)
    db.delete(file_obj)
    return str(full_path) if full_path is not None else None


def _unlink_queued(paths: list[str | None]) -> None:
    for path in paths:
        if not path:
            continue
        try:
            if os.path.exists(path):
                os.unlink(path)
        except OSError:
            pass


def _shared_blob(db: Session, f: FileObject):
    """Return the file's ContentBlob iff its physical bytes are shared (ref>1).

    Archiving/unarchiving rewrites bytes in place; doing so on a deduplicated blob
    would corrupt every other file that points at it, so those operations must
    refuse shared blobs.
    """
    from app.models.content_blob import ContentBlob

    if not f.blob_id:
        return None
    blob = db.get(ContentBlob, f.blob_id)
    if blob is not None and (blob.ref_count or 1) > 1:
        return blob
    return None


def _archive_file_core(db: Session, request: Request, actor: str, f: FileObject) -> dict:
    """Archive one file. Shared by the master-only route and the bulk runner;
    authorization is enforced by each caller's own dependency."""
    from app.models.content_blob import ContentBlob
    from app.storage.compress import compress_file, should_compress

    _log.info("archive requested file_id=%s owner_id=%s actor=%s", f.id, f.owner_id, actor)
    if f.archived:
        return _serialize_file_lifecycle(f)
    if f.encryption_mode == "client":
        raise HTTPException(400, detail="client-side encrypted files cannot be archived server-side")
    if f.compressed or not should_compress(f.content_type) or _shared_blob(db, f) is not None:
        # Already compact, incompressible, or backed by deduplicated bytes we must
        # not rewrite — retire it from the active scan set without touching bytes.
        f.lifecycle_state = "archived"
        db.commit()
        _log.info("archive marked file archived without recompressing file_id=%s", f.id)
        return _serialize_file_lifecycle(f)

    blob = db.get(ContentBlob, f.blob_id) if f.blob_id else None
    src = safe_join(storage_root(), f.storage_path)
    if not src.exists():
        raise HTTPException(500, detail="file missing from storage")
    original = f.stored_size_bytes or src.stat().st_size
    tmp = src.with_suffix(".manual-archive.tmp")
    try:
        f.lifecycle_state = "archiving"
        db.commit()
        compress_file(src, tmp)
        tmp.replace(src)
        stored = src.stat().st_size
        f.stored_size_bytes = stored
        f.archive_original_stored_size_bytes = original
        f.archive_saved_bytes = max(0, original - stored)
        f.archived = True
        f.archive_codec = "zstd"
        f.lifecycle_state = "archived"
        # Keep global storage accounting (sum of ContentBlob.stored_size_bytes) in
        # step with the now-compressed bytes on disk.
        if blob is not None:
            blob.stored_size_bytes = stored
            blob.transform_key = f"{blob.transform_key}|archived"[:64]
        record(db, actor=actor, action="file.archived",
               target=f"file:{f.id}", ip=client_ip(request))
        db.commit()
        _log.info(
            "archive completed file_id=%s original_bytes=%s stored_bytes=%s saved_bytes=%s",
            f.id,
            original,
            stored,
            f.archive_saved_bytes,
        )
        return _serialize_file_lifecycle(f)
    except Exception:
        tmp.unlink(missing_ok=True)
        f.lifecycle_state = "active"
        db.commit()
        _log.exception("archive failed file_id=%s", f.id)
        raise


def _unarchive_file_core(db: Session, request: Request, actor: str, f: FileObject) -> dict:
    from app.models.content_blob import ContentBlob
    from app.storage.compress import decompress_stream

    _log.info("unarchive requested file_id=%s owner_id=%s actor=%s", f.id, f.owner_id, actor)
    if not f.archived:
        return _serialize_file_lifecycle(f)
    if _shared_blob(db, f) is not None:
        raise HTTPException(409, detail="file shares deduplicated storage with other files and cannot be unarchived")
    blob = db.get(ContentBlob, f.blob_id) if f.blob_id else None
    src = safe_join(storage_root(), f.storage_path)
    if not src.exists():
        raise HTTPException(500, detail="file missing from storage")

    original = f.archive_original_stored_size_bytes or f.size_bytes
    extra_needed = max(0, original - (f.stored_size_bytes or src.stat().st_size))
    perm = db.query(Permission).filter_by(user_id=f.owner_id).one_or_none()
    owner_used_after = used_storage_bytes_for_user(db, f.owner_id) + extra_needed
    if perm is not None and owner_used_after > perm.quota_bytes:
        raise HTTPException(413, detail="unarchive would exceed user quota")
    settings = ensure_storage_settings(db)
    if used_storage_bytes(db) + extra_needed > settings.global_storage_quota_bytes:
        raise HTTPException(413, detail="unarchive would exceed global storage allocation")
    if shutil.disk_usage(str(storage_root())).free < extra_needed:
        raise HTTPException(507, detail="not enough free disk space to unarchive")

    tmp = src.with_suffix(".manual-unarchive.tmp")
    try:
        f.lifecycle_state = "unarchiving"
        db.commit()
        with open(tmp, "wb") as out:
            for chunk in decompress_stream(src, original):
                out.write(chunk)
        tmp.replace(src)
        f.stored_size_bytes = src.stat().st_size
        f.archived = False
        f.archive_codec = None
        f.archive_original_stored_size_bytes = 0
        f.archive_saved_bytes = 0
        f.lifecycle_state = "active"
        f.last_downloaded_at = datetime.now(timezone.utc)
        if blob is not None:
            blob.stored_size_bytes = f.stored_size_bytes
        record(db, actor=actor, action="file.unarchived",
               target=f"file:{f.id}", ip=client_ip(request))
        db.commit()
        _log.info("unarchive completed file_id=%s restored_bytes=%s", f.id, f.stored_size_bytes)
        return _serialize_file_lifecycle(f)
    except Exception:
        tmp.unlink(missing_ok=True)
        f.lifecycle_state = "archived"
        db.commit()
        _log.exception("unarchive failed file_id=%s", f.id)
        raise


@router.post("/files/{file_id}/archive")
def archive_file(
    file_id: int,
    request: Request,
    _csrf: SessionRow = Depends(require_csrf),
    master: User = Depends(require_master),
    db: Session = Depends(get_db),
) -> dict:
    f = _get_file(db, file_id)
    return _archive_file_core(db, request, master.username, f)


@router.post("/files/{file_id}/unarchive")
def unarchive_file(
    file_id: int,
    request: Request,
    _csrf: SessionRow = Depends(require_csrf),
    master: User = Depends(require_master),
    db: Session = Depends(get_db),
) -> dict:
    f = _get_file(db, file_id)
    return _unarchive_file_core(db, request, master.username, f)


@router.post("/lifecycle/temp-expiry")
def run_temp_expiry(
    request: Request,
    _csrf: SessionRow = Depends(require_csrf),
    _master: User = Depends(require_master),
) -> dict:
    _log.info("manual lifecycle temp expiry started")
    processed = temp_expiry_job(request.app.state.app_state.session_factory, storage_root())
    _log.info("manual lifecycle temp expiry completed processed=%s", processed)
    return {"processed": processed}


@router.post("/lifecycle/link-expiry")
def run_link_expiry(
    request: Request,
    _csrf: SessionRow = Depends(require_csrf),
    _master: User = Depends(require_master),
) -> dict:
    _log.info("manual lifecycle link expiry started")
    processed = link_expiry_job(request.app.state.app_state.session_factory)
    _log.info("manual lifecycle link expiry completed processed=%s", processed)
    return {"processed": processed}


@router.post("/lifecycle/reconcile")
def run_reconcile(
    request: Request,
    _csrf: SessionRow = Depends(require_csrf),
    _master: User = Depends(require_master),
) -> dict:
    _log.info("manual lifecycle reconcile started")
    processed = reconcile_stale_states(request.app.state.app_state.session_factory, storage_root())
    _log.info("manual lifecycle reconcile completed processed=%s", processed)
    return {"processed": processed}


@router.post("/lifecycle/archive-idle")
def run_archive_idle_real(
    request: Request,
    _csrf: SessionRow = Depends(require_csrf),
    _master: User = Depends(require_master),
) -> dict:
    _log.info("manual lifecycle archive idle scan started")
    processed = archive_idle_job(request.app.state.app_state.session_factory, storage_root())
    _log.info("manual lifecycle archive idle scan completed processed=%s", processed)
    return {"processed": processed}


@router.post("/bulk/preview")
def bulk_preview(
    body: BulkActionBody,
    _csrf: SessionRow = Depends(require_csrf),
    user: User = Depends(require_active_user),
    db: Session = Depends(get_db),
) -> dict:
    _require_bulk_permission(body.action, user, db)
    candidates = _bulk_candidates(body.action, body, db)
    _log.info(
        "bulk preview action=%s actor_id=%s candidate_count=%s explicit_ids=%s owner_id=%s",
        body.action,
        user.id,
        len(candidates),
        len(body.ids),
        body.owner_id,
    )
    return _bulk_preview_payload(body.action, candidates)


@router.post("/bulk/run")
def bulk_run(
    body: BulkActionBody,
    request: Request,
    _csrf: SessionRow = Depends(require_csrf),
    user: User = Depends(require_active_user),
    db: Session = Depends(get_db),
) -> dict:
    _require_bulk_permission(body.action, user, db)
    candidates = _bulk_candidates(body.action, body, db)
    _log.warning(
        "bulk run requested action=%s actor_id=%s candidate_count=%s explicit_ids=%s owner_id=%s",
        body.action,
        user.id,
        len(candidates),
        len(body.ids),
        body.owner_id,
    )
    expected = f"CONFIRM {len(candidates)}"
    if body.confirm != expected:
        _log.warning("bulk run rejected confirmation action=%s actor_id=%s", body.action, user.id)
        raise HTTPException(400, detail=f'type "{expected}" to confirm')

    processed = 0
    unlink_after_commit: list[str | None] = []

    if body.action == "delete_api_keys":
        for key in candidates:
            db.delete(key)
            processed += 1
        if processed:
            record(db, actor=user.username, action="bulk.apikeys_deleted",
                   target=f"api_keys:{processed}", ip=client_ip(request))
        db.commit()

    elif body.action == "reset_api_key_ips":
        for key in candidates:
            key.bound_ip = None
            processed += 1
        if processed:
            record(db, actor=user.username, action="bulk.apikey_ips_reset",
                   target=f"api_keys:{processed}", ip=client_ip(request))
        db.commit()

    elif body.action == "delete_inactive_links":
        for link in candidates:
            db.delete(link)
            processed += 1
        if processed:
            record(db, actor=user.username, action="bulk.links_deleted",
                   target=f"links:{processed}", ip=client_ip(request))
        db.commit()

    elif body.action == "delete_files":
        for file_obj in candidates:
            unlink_after_commit.append(_queue_file_delete(db, file_obj))
            processed += 1
        if processed:
            record(db, actor=user.username, action="bulk.files_deleted",
                   target=f"files:{processed}", ip=client_ip(request))
        db.commit()
        _unlink_queued(unlink_after_commit)

    elif body.action == "delete_directories":
        from app.models.dropbox_link import DropboxUploadLink
        for directory in candidates:
            members = db.query(FileObject).filter_by(directory_id=directory.id).all()
            for member in members:
                unlink_after_commit.append(_queue_file_delete(db, member))
            db.flush()
            # Clear rows that FK-reference the directory before deleting it, or the
            # commit fails with an IntegrityError (FKs are enforced).
            db.query(DropboxUploadLink).filter_by(target_directory_id=directory.id).delete()
            db.query(DirectoryCollaborator).filter_by(directory_id=directory.id).delete()
            db.delete(directory)
            processed += 1
        if processed:
            record(db, actor=user.username, action="bulk.directories_deleted",
                   target=f"directories:{processed}", ip=client_ip(request))
        db.commit()
        _unlink_queued(unlink_after_commit)

    elif body.action == "archive_files":
        for file_obj in candidates:
            _archive_file_core(db, request, user.username, file_obj)
            processed += 1
        if processed:
            record(db, actor=user.username, action="bulk.files_archived",
                   target=f"files:{processed}", ip=client_ip(request))
            db.commit()

    elif body.action == "unarchive_files":
        for file_obj in candidates:
            try:
                _unarchive_file_core(db, request, user.username, file_obj)
            except HTTPException:
                # Skip files that can't be unarchived in bulk (e.g. shared
                # deduplicated storage) rather than aborting the whole batch.
                continue
            processed += 1
        if processed:
            record(db, actor=user.username, action="bulk.files_unarchived",
                   target=f"files:{processed}", ip=client_ip(request))
            db.commit()

    elif body.action == "run_cleanup_jobs":
        factory = request.app.state.app_state.session_factory
        processed = (
            temp_expiry_job(factory, storage_root())
            + delete_idle_job(factory, storage_root())
            + link_expiry_job(factory)
            + reconcile_stale_states(factory, storage_root())
        )
        record(db, actor=user.username, action="bulk.cleanup_ran",
               target=f"jobs:{processed}", ip=client_ip(request))
        db.commit()

    else:
        raise HTTPException(400, detail="unknown bulk action")

    _log.warning(
        "bulk run completed action=%s actor_id=%s processed=%s affected=%s",
        body.action,
        user.id,
        processed,
        len(candidates),
    )
    return {
        "action": body.action,
        "processed_count": processed,
        "affected_count": len(candidates),
    }
