from __future__ import annotations

import shutil
from datetime import datetime, timezone

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.file import FileObject
from app.models.content_blob import ContentBlob
from app.models.permission import Permission
from app.models.storage_settings import StorageSettings
from app.storage.paths import storage_root

_GB = 1024 ** 3
DEFAULT_GLOBAL_STORAGE_QUOTA_BYTES = 500 * _GB


def ensure_storage_settings(db: Session) -> StorageSettings:
    settings = db.get(StorageSettings, 1)
    if settings is not None:
        return settings
    settings = StorageSettings(
        id=1,
        global_storage_quota_bytes=DEFAULT_GLOBAL_STORAGE_QUOTA_BYTES,
    )
    db.add(settings)
    db.flush()
    return settings


def used_storage_bytes(db: Session) -> int:
    return int(db.query(func.sum(ContentBlob.stored_size_bytes)).scalar() or 0)


def used_storage_bytes_for_user(db: Session, user_id: int) -> int:
    return int(
        db.query(func.sum(FileObject.size_bytes))
        .filter_by(owner_id=user_id)
        .scalar()
        or 0
    )


def logical_storage_bytes(db: Session) -> int:
    return int(db.query(func.sum(FileObject.size_bytes)).scalar() or 0)


def dedup_saved_bytes(db: Session) -> int:
    return max(0, logical_storage_bytes(db) - used_storage_bytes(db))


def allocated_quota_bytes(db: Session) -> int:
    return int(db.query(func.sum(Permission.quota_bytes)).scalar() or 0)


def allocated_quota_bytes_with_override(
    db: Session,
    *,
    user_id: int,
    quota_bytes: int,
) -> int:
    total = 0
    for perm in db.query(Permission).all():
        total += int(quota_bytes if perm.user_id == user_id else perm.quota_bytes)
    return total


def physical_storage_capacity_bytes() -> int | None:
    try:
        return int(shutil.disk_usage(str(storage_root())).total)
    except OSError:
        return None


def validate_allocated_quota_capacity(db: Session, allocated_bytes: int) -> None:
    from fastapi import HTTPException

    capacity = physical_storage_capacity_bytes()
    if capacity is not None and allocated_bytes > capacity:
        raise HTTPException(
            400,
            detail="user quotas would exceed available disk space",
        )


def validate_global_storage_cap(db: Session, cap_bytes: int) -> None:
    from fastapi import HTTPException

    used = used_storage_bytes(db)
    allocated = allocated_quota_bytes(db)
    minimum = max(used, allocated)
    if cap_bytes < minimum:
        raise HTTPException(
            400,
            detail=(
                "global storage cap cannot be below current usage "
                "or allocated user quotas"
            ),
        )
    capacity = physical_storage_capacity_bytes()
    if capacity is not None and cap_bytes > capacity:
        raise HTTPException(
            400,
            detail="global storage cap cannot exceed available disk space",
        )


def enforce_global_upload_capacity(db: Session, incoming_bytes: int) -> None:
    from fastapi import HTTPException

    settings = ensure_storage_settings(db)
    if used_storage_bytes(db) + incoming_bytes > settings.global_storage_quota_bytes:
        raise HTTPException(413, detail="upload would exceed global storage allocation")
    try:
        if shutil.disk_usage(str(storage_root())).free < incoming_bytes:
            raise HTTPException(507, detail="not enough free disk space")
    except OSError:
        pass


def set_global_storage_cap(db: Session, cap_bytes: int) -> StorageSettings:
    validate_global_storage_cap(db, cap_bytes)
    settings = ensure_storage_settings(db)
    settings.global_storage_quota_bytes = cap_bytes
    settings.updated_at = datetime.now(timezone.utc)
    db.flush()
    return settings
