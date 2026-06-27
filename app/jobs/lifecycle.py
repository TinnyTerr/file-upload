from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from pathlib import Path

_log = logging.getLogger(__name__)
_DEFAULT_ARCHIVE_IDLE_DAYS = 5


def _now() -> datetime:
    return datetime.now(timezone.utc)


def archive_idle_job(session_factory, storage_root: Path) -> int:
    from app.models.file import FileObject
    from app.storage.compress import compress_file, should_compress

    processed = 0
    scanned = 0
    skipped_recent = 0
    with session_factory() as db:
        candidates = (
            db.query(FileObject)
            .filter(
                FileObject.lifecycle_state == "active",
                FileObject.archived == False,
                FileObject.encryption_mode != "client",
            )
            .all()
        )
        _log.info("archive idle job started candidates=%s", len(candidates))
        for f in candidates:
            scanned += 1
            idle_days = f.archive_after_idle_days or _DEFAULT_ARCHIVE_IDLE_DAYS
            threshold = _now() - timedelta(days=idle_days)
            last = f.last_downloaded_at or f.created_at
            if last > threshold:
                skipped_recent += 1
                continue
            processed += 1
            if f.compressed or not should_compress(f.content_type):
                # Nothing to archive — either already compressed at upload, or an
                # incompressible type. Retire it from the "active" scan set so the
                # job stops re-examining it on every run. Leave `archived` False so
                # the download path's auto-unarchive gate is unaffected.
                f.lifecycle_state = "archived"
                db.commit()
                _log.info("archive idle job marked archived file_id=%s reason=already_compressed_or_incompressible", f.id)
                continue
            src = storage_root / f.storage_path
            if not src.exists():
                # The bytes vanished from under the DB row — drop the stale record
                # instead of looping on it forever.
                _log.warning("archive: storage missing for file %d; removing stale record", f.id)
                _delete_file(db, f, storage_root)
                db.commit()
                continue
            tmp = src.with_suffix(".arch.tmp")
            try:
                f.lifecycle_state = "archiving"
                db.commit()
                original = f.stored_size_bytes or src.stat().st_size
                compress_file(src, tmp)
                tmp.replace(src)
                stored = src.stat().st_size
                f.stored_size_bytes = stored
                f.archive_original_stored_size_bytes = original
                f.archive_saved_bytes = max(0, original - stored)
                f.archived = True
                f.archive_codec = "zstd"
                f.lifecycle_state = "archived"
                db.commit()
                _log.info(
                    "archive idle job archived file_id=%s original_bytes=%s stored_bytes=%s saved_bytes=%s",
                    f.id,
                    original,
                    stored,
                    f.archive_saved_bytes,
                )
            except Exception as exc:
                _log.error("archive failed for file %d: %s", f.id, exc)
                tmp.unlink(missing_ok=True)
                f.lifecycle_state = "active"
                db.commit()
    _log.info("archive idle job completed scanned=%s skipped_recent=%s processed=%s", scanned, skipped_recent, processed)
    return processed


def delete_idle_job(session_factory, storage_root: Path) -> int:
    from app.models.file import FileObject
    from app.models.link import Link

    processed = 0
    scanned = 0
    with session_factory() as db:
        files = db.query(FileObject).filter(FileObject.delete_if_idle_days.isnot(None)).all()
        _log.info("idle delete job started candidates=%s", len(files))
        for f in files:
            scanned += 1
            last = f.last_downloaded_at or f.created_at
            if (_now() - last) < timedelta(days=f.delete_if_idle_days):
                continue
            if _delete_file(db, f, storage_root):
                processed += 1
        db.commit()
    _log.info("idle delete job completed scanned=%s processed=%s", scanned, processed)
    return processed


def temp_expiry_job(session_factory, storage_root: Path) -> int:
    from app.models.file import FileObject

    processed = 0
    with session_factory() as db:
        files = (
            db.query(FileObject)
            .filter(FileObject.is_permanent == False, FileObject.expires_at < _now())
            .all()
        )
        _log.info("temp expiry job started candidates=%s", len(files))
        for f in files:
            if _delete_file(db, f, storage_root):
                processed += 1
        db.commit()
    _log.info("temp expiry job completed processed=%s", processed)
    return processed


def link_expiry_job(session_factory) -> int:
    from app.models.link import Link

    with session_factory() as db:
        _log.info("link expiry job started")
        result = (
            db.query(Link)
            .filter(Link.expires_at < _now(), Link.active == True)
            .update({Link.active: False})
        )
        db.commit()
        processed = int(result or 0)
        _log.info("link expiry job completed processed=%s", processed)
        return processed


def _delete_file(db, f, storage_root: Path) -> bool:
    from app.models.link import Link
    from app.storage.paths import safe_join

    try:
        path = safe_join(storage_root, f.storage_path)
    except ValueError:
        # A storage_path that escapes the root should never have been written;
        # refuse to touch the filesystem but still clear the DB rows.
        path = None

    if path is not None:
        try:
            path.unlink(missing_ok=True)
        except OSError as exc:
            # On Windows a file that is still open/locked can't be unlinked. Keep
            # the DB rows so a later run retries, rather than orphaning the bytes
            # with no record pointing at them.
            _log.warning("deferred delete for file %d (storage locked?): %s", f.id, exc)
            return False

    db.query(Link).filter_by(file_id=f.id).delete()
    db.delete(f)
    _log.info("lifecycle deleted file file_id=%s storage_path=%s", f.id, f.storage_path)
    return True


def reconcile_stale_states(session_factory, storage_root: Path) -> int:
    from app.models.file import FileObject

    with session_factory() as db:
        stale = db.query(FileObject).filter(
            FileObject.lifecycle_state.in_(["archiving", "unarchiving"])
        ).all()
        _log.info("lifecycle reconcile started stale=%s", len(stale))
        for f in stale:
            _log.warning("resetting stale lifecycle_state for file %d", f.id)
            f.lifecycle_state = "archived" if f.archived else "active"
        if stale:
            db.commit()
        _log.info("lifecycle reconcile completed processed=%s", len(stale))
        return len(stale)
