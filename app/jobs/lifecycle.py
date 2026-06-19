from __future__ import annotations

import logging
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path

_log = logging.getLogger(__name__)
_DEFAULT_ARCHIVE_IDLE_DAYS = 5


def _now() -> datetime:
    return datetime.now(timezone.utc)


def archive_idle_job(session_factory, storage_root: Path) -> None:
    from sqlalchemy.orm import Session
    from app.models.file import FileObject
    from app.storage.compress import compress_file, should_compress

    with session_factory() as db:
        cutoff = _now() - timedelta(days=_DEFAULT_ARCHIVE_IDLE_DAYS)
        candidates = (
            db.query(FileObject)
            .filter(
                FileObject.lifecycle_state == "active",
                FileObject.archived == False,
                FileObject.encryption_mode != "client",
            )
            .all()
        )
        for f in candidates:
            idle_days = f.archive_after_idle_days or _DEFAULT_ARCHIVE_IDLE_DAYS
            threshold = _now() - timedelta(days=idle_days)
            last = f.last_downloaded_at or f.created_at
            if last > threshold:
                continue
            if not should_compress(f.content_type):
                continue
            src = storage_root / f.storage_path
            if not src.exists():
                continue
            tmp = src.with_suffix(".arch.tmp")
            try:
                f.lifecycle_state = "archiving"
                db.commit()
                compress_file(src, tmp)
                tmp.replace(src)
                f.stored_size_bytes = src.stat().st_size
                f.archived = True
                f.archive_codec = "zstd"
                f.lifecycle_state = "archived"
                db.commit()
                _log.info("archived file %d", f.id)
            except Exception as exc:
                _log.error("archive failed for file %d: %s", f.id, exc)
                tmp.unlink(missing_ok=True)
                f.lifecycle_state = "active"
                db.commit()


def delete_idle_job(session_factory, storage_root: Path) -> None:
    from app.models.file import FileObject
    from app.models.link import Link

    with session_factory() as db:
        files = db.query(FileObject).filter(FileObject.delete_if_idle_days.isnot(None)).all()
        for f in files:
            last = f.last_downloaded_at or f.created_at
            if (_now() - last).days < f.delete_if_idle_days:
                continue
            _delete_file(db, f, storage_root)
        db.commit()


def temp_expiry_job(session_factory, storage_root: Path) -> None:
    from app.models.file import FileObject

    with session_factory() as db:
        files = (
            db.query(FileObject)
            .filter(FileObject.is_permanent == False, FileObject.expires_at < _now())
            .all()
        )
        for f in files:
            _delete_file(db, f, storage_root)
        db.commit()


def link_expiry_job(session_factory) -> None:
    from app.models.link import Link

    with session_factory() as db:
        (
            db.query(Link)
            .filter(Link.expires_at < _now(), Link.active == True)
            .update({Link.active: False})
        )
        db.commit()


def _delete_file(db, f, storage_root: Path) -> None:
    from app.models.link import Link

    path = storage_root / f.storage_path
    try:
        path.unlink(missing_ok=True)
    except OSError:
        pass
    db.query(Link).filter_by(file_id=f.id).delete()
    db.delete(f)


def reconcile_stale_states(session_factory, storage_root: Path) -> None:
    from app.models.file import FileObject

    with session_factory() as db:
        stale = db.query(FileObject).filter(
            FileObject.lifecycle_state.in_(["archiving", "unarchiving"])
        ).all()
        for f in stale:
            _log.warning("resetting stale lifecycle_state for file %d", f.id)
            f.lifecycle_state = "archived" if f.archived else "active"
        if stale:
            db.commit()
