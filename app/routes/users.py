from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.audit.log import record
from app.deps import client_ip, get_db, require_master
from app.security.csrf import require_csrf
from app.models.permission import Permission
from app.models.session import SessionRow
from app.models.user import User
from app.permissions.policy import ensure_permissions
from app.security.passwords import hash_password

router = APIRouter(prefix="/users", tags=["users"])


class CreateUserBody(BaseModel):
    username: str
    password: str
    role: str = "user"
    can_upload: bool = True
    quota_bytes: int | None = None
    max_file_bytes: int | None = None


class UpdatePermissionsBody(BaseModel):
    can_upload: bool | None = None
    can_upload_client_encrypted: bool | None = None
    can_delete: bool | None = None
    can_regenerate_links: bool | None = None
    can_use_api_keys: bool | None = None
    can_use_p2p: bool | None = None
    quota_bytes: int | None = None
    max_file_bytes: int | None = None


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
            "must_change_credentials": u.must_change_credentials,
            "created_at": u.created_at.isoformat(),
            "permissions": {
                "can_upload": perm.can_upload,
                "can_upload_client_encrypted": perm.can_upload_client_encrypted,
                "can_delete": perm.can_delete,
                "can_regenerate_links": perm.can_regenerate_links,
                "can_use_api_keys": perm.can_use_api_keys,
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
    if body.quota_bytes is not None:
        perm.quota_bytes = body.quota_bytes
    if body.max_file_bytes is not None:
        perm.max_file_bytes = body.max_file_bytes

    record(db, actor=master.username, action="user.created",
           target=f"user:{user.id}", ip=client_ip(request))
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

    db.query(SessionRow).filter_by(user_id=user_id).delete()
    db.query(Permission).filter_by(user_id=user_id).delete()
    record(db, actor=master.username, action="user.deleted",
           target=f"user:{user_id}", ip=client_ip(request))
    db.delete(user)
    db.commit()
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

    for field, value in body.model_dump(exclude_none=True).items():
        setattr(perm, field, value)

    record(db, actor=master.username, action="permissions.updated",
           target=f"user:{user_id}", ip=client_ip(request))
    db.commit()
    return {"status": "updated"}
