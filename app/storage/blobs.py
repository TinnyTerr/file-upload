from __future__ import annotations

import hashlib
import os
from pathlib import Path

from sqlalchemy.orm import Session

from app.models.content_blob import ContentBlob
from app.models.file import FileObject
from app.storage.paths import safe_join, storage_root

_READ_SIZE = 1024 * 1024


def hash_file(path: Path) -> dict[str, str]:
    sha256 = hashlib.sha256()
    sha1 = hashlib.sha1()
    md5 = hashlib.md5()
    blake2b = hashlib.blake2b()
    with open(path, "rb") as fh:
        while True:
            chunk = fh.read(_READ_SIZE)
            if not chunk:
                break
            sha256.update(chunk)
            sha1.update(chunk)
            md5.update(chunk)
            blake2b.update(chunk)
    return {
        "sha256": sha256.hexdigest(),
        "sha1": sha1.hexdigest(),
        "md5": md5.hexdigest(),
        "blake2b": blake2b.hexdigest(),
    }


def attach_blob(
    db: Session,
    *,
    final_path: Path,
    rel_path: str,
    logical_size: int,
    content_type: str,
    hashes: dict[str, str],
    stored_hashes: dict[str, str] | None = None,
    transform_key: str = "plain",
) -> ContentBlob:
    """Register a stored file as a content blob, reusing an existing blob when
    the stored-content hash and transform key match.

    The upload pipeline has already renamed the work file to `final_path`.
    When a duplicate blob exists this removes the new duplicate bytes and
    returns the existing canonical row.
    """
    stored_sha256 = (stored_hashes or hashes)["sha256"]
    existing = (
        db.query(ContentBlob)
        .filter_by(stored_sha256=stored_sha256, transform_key=transform_key)
        .first()
    )
    if existing is not None:
        existing.ref_count = (existing.ref_count or 0) + 1
        try:
            final_path.unlink(missing_ok=True)
        except OSError:
            pass
        return existing

    blob = ContentBlob(
        storage_path=rel_path,
        content_type=content_type,
        size_bytes=logical_size,
        stored_size_bytes=final_path.stat().st_size,
        sha256=hashes["sha256"],
        sha1=hashes["sha1"],
        md5=hashes["md5"],
        blake2b=hashes["blake2b"],
        stored_sha256=stored_sha256,
        transform_key=transform_key,
        ref_count=1,
    )
    db.add(blob)
    db.flush()
    return blob


def file_hashes(db: Session, file_obj: FileObject) -> dict[str, str]:
    blob = db.get(ContentBlob, file_obj.blob_id) if getattr(file_obj, "blob_id", None) else None
    if blob is None:
        return {}
    return {
        "sha256": blob.sha256,
        "sha1": blob.sha1,
        "md5": blob.md5,
        "blake2b": blob.blake2b,
    }


def release_blob(db: Session, file_obj: FileObject) -> str | None:
    """Queue deletion of physical bytes only when the last logical reference is
    removed. Returns an absolute path to unlink after the DB commit.
    """
    blob = db.get(ContentBlob, file_obj.blob_id) if getattr(file_obj, "blob_id", None) else None
    if blob is None:
        try:
            return str(safe_join(storage_root(), file_obj.storage_path))
        except ValueError:
            return None

    blob.ref_count = max(0, (blob.ref_count or 0) - 1)
    if blob.ref_count > 0:
        return None

    try:
        full = safe_join(storage_root(), blob.storage_path)
    except ValueError:
        full = None
    # Clear the current row's FK before deleting the blob row. SQLAlchemy has no
    # relationship here to infer delete ordering, so an explicit flush prevents
    # SQLite from seeing a live files.blob_id reference during blob deletion.
    file_obj.blob_id = None
    db.flush()
    db.delete(blob)
    return str(full) if full is not None else None


def unlink_queued(paths: list[str | None]) -> None:
    for path in paths:
        if not path:
            continue
        try:
            if os.path.exists(path):
                os.unlink(path)
        except OSError:
            pass
