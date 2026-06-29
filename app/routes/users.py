from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.audit.log import record
from app.deps import client_ip, get_db, require_master
from app.security.csrf import require_csrf
from app.models.permission import Permission
from app.models.session import SessionRow
from app.models.user import User
from app.permissions.policy import ensure_permissions
from app.security.passwords import hash_password
from app.storage.accounting import (
    allocated_quota_bytes,
    allocated_quota_bytes_with_override,
    ensure_storage_settings,
    used_storage_bytes_for_user,
    validate_allocated_quota_capacity,
)

router = APIRouter(prefix="/users", tags=["users"])
_log = logging.getLogger(__name__)


class CreateUserBody(BaseModel):
    username: str = Field(..., max_length=255)
    password: str
    role: str = "user"
    can_upload: bool = True
    can_upload_client_encrypted: bool | None = None
    can_delete: bool | None = None
    can_regenerate_links: bool | None = None
    can_delete_links: bool | None = None
    can_create_directories: bool | None = None
    can_manage_lifecycle: bool | None = None
    can_use_api_keys: bool | None = None
    quota_bytes: int | None = None
    max_file_bytes: int | None = None


class UpdatePermissionsBody(BaseModel):
    can_upload: bool | None = None
    can_upload_client_encrypted: bool | None = None
    can_delete: bool | None = None
    can_regenerate_links: bool | None = None
    can_delete_links: bool | None = None
    can_create_directories: bool | None = None
    can_manage_lifecycle: bool | None = None
    can_use_api_keys: bool | None = None
    can_view_admin: bool | None = None
    can_manage_users: bool | None = None
    can_manage_storage: bool | None = None
    can_manage_api_keys: bool | None = None
    can_manage_cluster: bool | None = None
    quota_bytes: int | None = None
    max_file_bytes: int | None = None


class PatchUserBody(BaseModel):
    username: str | None = Field(None, max_length=255)
    password: str | None = None
    role: str | None = None


@router.get("/")
def list_users(
    master: User = Depends(require_master),
    db: Session = Depends(get_db),
) -> dict:
    users = db.query(User).order_by(User.created_at).all()
    result = []
    for u in users:
        perm = db.query(Permission).filter_by(user_id=u.id).one_or_none()
        result.append({
            "id": u.id,
            "username": u.username,
            "role": u.role,
            "has_avatar": u.avatar_data is not None,
            "must_change_credentials": u.must_change_credentials,
            "created_at": u.created_at.isoformat(),
            "permissions": {
                "can_upload": perm.can_upload,
                "can_upload_client_encrypted": perm.can_upload_client_encrypted,
                "can_delete": perm.can_delete,
                "can_regenerate_links": perm.can_regenerate_links,
                "can_delete_links": perm.can_delete_links,
                "can_create_directories": perm.can_create_directories,
                "can_manage_lifecycle": perm.can_manage_lifecycle,
                "can_use_api_keys": perm.can_use_api_keys,
                "can_view_admin": perm.can_view_admin,
                "can_manage_users": perm.can_manage_users,
                "can_manage_storage": perm.can_manage_storage,
                "can_manage_api_keys": perm.can_manage_api_keys,
                "can_manage_cluster": perm.can_manage_cluster,
                "quota_bytes": perm.quota_bytes,
                "max_file_bytes": perm.max_file_bytes,
            } if perm else None,
        })
    return {"users": result}


@router.post("/")
def create_user(
    body: CreateUserBody,
    request: Request,
    _csrf: SessionRow = Depends(require_csrf),
    master: User = Depends(require_master),
    db: Session = Depends(get_db),
) -> dict:
    if len(body.password) < 12:
        raise HTTPException(400, detail="password must be at least 12 characters")
    if body.role not in ("user", "master"):
        raise HTTPException(400, detail="role must be 'user' or 'master'")
    if db.query(User).filter_by(username=body.username).one_or_none() is not None:
        raise HTTPException(409, detail="username taken")

    user = User(
        username=body.username,
        password_hash=hash_password(body.password),
        role=body.role,
        must_change_credentials=False,
    )
    db.add(user)
    db.flush()

    perm = ensure_permissions(db, user.id, master=(body.role == "master"))
    perm.can_upload = body.can_upload
    for field, value in body.model_dump(exclude_none=True).items():
        if hasattr(perm, field):
            setattr(perm, field, value)
    if body.role == "master":
        for field in (
            "can_upload", "can_upload_client_encrypted", "can_delete",
            "can_regenerate_links", "can_delete_links", "can_create_directories",
            "can_manage_lifecycle", "can_use_api_keys",
            "can_view_admin", "can_manage_users", "can_manage_storage",
            "can_manage_api_keys",
        ):
            setattr(perm, field, True)
    settings = ensure_storage_settings(db)
    if allocated_quota_bytes(db) > settings.global_storage_quota_bytes:
        raise HTTPException(
            400,
            detail="user quotas would exceed global storage allocation",
        )
    if body.quota_bytes is not None:
        validate_allocated_quota_capacity(db, allocated_quota_bytes(db))

    record(db, actor=master.username, action="user.created",
           target=f"user:{user.id}", ip=client_ip(request))
    _log.info(
        "admin user created target_user_id=%s role=%s actor_id=%s",
        user.id,
        user.role,
        master.id,
    )
    db.commit()
    return {"id": user.id, "username": user.username, "role": user.role}


def _master_count(db: Session) -> int:
    return int(db.query(func.count(User.id)).filter_by(role="master").scalar() or 0)


@router.patch("/{user_id}")
def patch_user(
    user_id: int,
    body: PatchUserBody,
    request: Request,
    _csrf: SessionRow = Depends(require_csrf),
    master: User = Depends(require_master),
    db: Session = Depends(get_db),
) -> dict:
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(404, detail="not found")

    changes = body.model_dump(exclude_none=True)
    if "username" in changes:
        username = (body.username or "").strip()
        if not username:
            raise HTTPException(400, detail="username is required")
        existing = db.query(User).filter_by(username=username).one_or_none()
        if existing is not None and existing.id != user.id:
            raise HTTPException(409, detail="username taken")
        user.username = username
        _log.info("admin user rename target_user_id=%s actor_id=%s", user.id, master.id)

    if body.password is not None:
        if len(body.password) < 12:
            raise HTTPException(400, detail="password must be at least 12 characters")
        user.password_hash = hash_password(body.password)
        db.query(SessionRow).filter_by(user_id=user.id).delete()
        _log.warning(
            "admin password reset target_user_id=%s actor_id=%s sessions_revoked=true",
            user.id,
            master.id,
        )

    if body.role is not None:
        if body.role not in ("user", "master"):
            raise HTTPException(400, detail="role must be 'user' or 'master'")
        if user.role == "master" and body.role != "master" and _master_count(db) <= 1:
            raise HTTPException(400, detail="cannot demote the last master")
        user.role = body.role
        _log.warning("admin role changed target_user_id=%s role=%s actor_id=%s", user.id, body.role, master.id)
        perm = ensure_permissions(db, user.id, master=(body.role == "master"))
        if body.role == "master":
            for field in (
                "can_upload", "can_upload_client_encrypted", "can_delete",
                "can_regenerate_links", "can_delete_links", "can_create_directories",
                "can_manage_lifecycle", "can_use_api_keys",
                "can_view_admin", "can_manage_users", "can_manage_storage",
                "can_manage_api_keys", "can_manage_cluster",
            ):
                setattr(perm, field, True)

    record(db, actor=master.username, action="user.updated",
           target=f"user:{user_id}", ip=client_ip(request))
    db.commit()
    return {"id": user.id, "username": user.username, "role": user.role}


@router.delete("/{user_id}")
def delete_user(
    user_id: int,
    request: Request,
    _csrf: SessionRow = Depends(require_csrf),
    master: User = Depends(require_master),
    db: Session = Depends(get_db),
) -> dict:
    if user_id == master.id:
        raise HTTPException(400, detail="cannot delete yourself")
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(404, detail="not found")
    if user.role == "master" and _master_count(db) <= 1:
        raise HTTPException(400, detail="cannot delete the last master")

    from app.models.api_key import ApiKey
    from app.models.directory import Directory
    from app.models.directory_collaborator import DirectoryCollaborator
    from app.models.dropbox_link import DropboxUploadLink
    from app.models.file import FileObject
    from app.models.link import Link
    from app.models.remote_upload_job import RemoteUploadJob
    from app.storage.blobs import release_blob, unlink_queued

    # Foreign keys are enforced (PRAGMA foreign_keys=ON) and none of the dependent
    # tables cascade, so every row that references this user must be removed first
    # or the delete fails with an IntegrityError. Files owned by the user — plus
    # any files a master uploaded into the user's directories — have their bytes
    # released through the shared-blob ref counter so deduplicated content other
    # users still reference is never destroyed.
    dirs = db.query(Directory).filter_by(owner_id=user_id).all()
    dir_ids = [d.id for d in dirs]

    files = db.query(FileObject).filter_by(owner_id=user_id).all()
    if dir_ids:
        files += db.query(FileObject).filter(FileObject.directory_id.in_(dir_ids)).all()
    files = list({ff.id: ff for ff in files}.values())
    file_ids = [f.id for f in files]

    unlink_after_commit: list[str | None] = []
    # Detach rows in other users' data that point at the files/user we're removing,
    # so the deletes don't trip foreign keys (independent of DB-level ON DELETE).
    if file_ids:
        db.query(FileObject).filter(FileObject.saved_from_file_id.in_(file_ids)).update(
            {FileObject.saved_from_file_id: None}, synchronize_session=False
        )
        db.query(RemoteUploadJob).filter(RemoteUploadJob.file_id.in_(file_ids)).update(
            {RemoteUploadJob.file_id: None}, synchronize_session=False
        )
    db.query(DirectoryCollaborator).filter_by(invited_by_id=user_id).update(
        {DirectoryCollaborator.invited_by_id: None}, synchronize_session=False
    )

    for f in files:
        db.query(Link).filter_by(file_id=f.id).delete()
        unlink_after_commit.append(release_blob(db, f))
        db.delete(f)
    db.flush()

    # Rows that reference the user's directories or the user directly.
    if dir_ids:
        db.query(DropboxUploadLink).filter(DropboxUploadLink.target_directory_id.in_(dir_ids)).delete(
            synchronize_session=False
        )
        db.query(DirectoryCollaborator).filter(DirectoryCollaborator.directory_id.in_(dir_ids)).delete(
            synchronize_session=False
        )
    for d in dirs:
        db.delete(d)
    db.query(DirectoryCollaborator).filter_by(user_id=user_id).delete()
    db.query(DropboxUploadLink).filter_by(owner_id=user_id).delete()
    db.query(RemoteUploadJob).filter_by(owner_id=user_id).delete()
    db.query(ApiKey).filter_by(owner_id=user_id).delete()
    db.query(SessionRow).filter_by(user_id=user_id).delete()
    db.query(Permission).filter_by(user_id=user_id).delete()
    db.flush()

    record(db, actor=master.username, action="user.deleted",
           target=f"user:{user_id}", ip=client_ip(request))
    _log.warning(
        "admin user deleted target_user_id=%s actor_id=%s files_removed=%s directories_removed=%s",
        user_id,
        master.id,
        len(files),
        len(dirs),
    )
    db.delete(user)
    db.commit()
    unlink_queued(unlink_after_commit)
    return {"status": "deleted"}


@router.post("/{user_id}/permissions")
def update_permissions(
    user_id: int,
    body: UpdatePermissionsBody,
    request: Request,
    _csrf: SessionRow = Depends(require_csrf),
    master: User = Depends(require_master),
    db: Session = Depends(get_db),
) -> dict:
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(404, detail="not found")
    perm = ensure_permissions(db, user_id, master=(user.role == "master"))
    db.flush()

    values = body.model_dump(exclude_none=True)
    if "quota_bytes" in values:
        quota_bytes = int(values["quota_bytes"])
        used = used_storage_bytes_for_user(db, user_id)
        if quota_bytes < used:
            raise HTTPException(400, detail="quota cannot be below current user storage")
        settings = ensure_storage_settings(db)
        allocated = allocated_quota_bytes_with_override(
            db, user_id=user_id, quota_bytes=quota_bytes
        )
        if allocated > settings.global_storage_quota_bytes:
            raise HTTPException(
                400,
                detail="user quotas would exceed global storage allocation",
            )
        validate_allocated_quota_capacity(db, allocated)

    for field, value in values.items():
        setattr(perm, field, value)

    record(db, actor=master.username, action="permissions.updated",
           target=f"user:{user_id}", ip=client_ip(request))
    _log.info(
        "admin permissions updated target_user_id=%s actor_id=%s fields=%s",
        user_id,
        master.id,
        sorted(values),
    )
    db.commit()
    return {"status": "updated"}
