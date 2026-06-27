from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.audit.log import record
from app.deps import client_ip, current_session, get_db, require_active_user
from app.models.session import SessionRow
from app.models.user import User
from app.security.csrf import require_csrf
from app.security.passwords import hash_password, verify_password

router = APIRouter(prefix="/account", tags=["account"])


class ChangeCredsBody(BaseModel):
    new_username: str
    current_password: str
    new_password: str


@router.post("/change-credentials")
def change_credentials(body: ChangeCredsBody, request: Request,
                       session_row: SessionRow = Depends(require_csrf),
                       db: Session = Depends(get_db)) -> dict:
    if len(body.new_password) < 12:
        raise HTTPException(status_code=400, detail="new password too short")
    user = db.get(User, session_row.user_id)
    if user is None or not verify_password(body.current_password, user.password_hash):
        raise HTTPException(status_code=401, detail="invalid current password")
    existing = db.query(User).filter_by(username=body.new_username).one_or_none()
    if existing is not None and existing.id != user.id:
        raise HTTPException(status_code=409, detail="username taken")
    # Capture the authenticating identity before the rename so the audit log
    # records who performed the change, not the new name they chose.
    actor = user.username
    user.username = body.new_username
    user.password_hash = hash_password(body.new_password)
    user.must_change_credentials = False
    # Revoke every other session for this user so a previously stolen/leaked
    # cookie can't outlive the password change. Keep the current one alive.
    db.query(SessionRow).filter(
        SessionRow.user_id == user.id,
        SessionRow.id != session_row.id,
    ).delete()
    record(db, actor=actor, action="account.credentials_changed",
           target=f"user:{user.id}", ip=client_ip(request))
    db.commit()
    return {"status": "updated"}


@router.get("/me")
def me(user: User = Depends(require_active_user), db: Session = Depends(get_db)) -> dict:
    from app.permissions.policy import ensure_permissions
    from app.models.file import FileObject
    from sqlalchemy import func
    perm = ensure_permissions(db, user.id, master=(user.role == "master"))
    used = db.query(func.sum(FileObject.stored_size_bytes)).filter_by(owner_id=user.id).scalar() or 0
    db.commit()
    return {
        "id": user.id,
        "username": user.username,
        "role": user.role,
        "quota_bytes": perm.quota_bytes,
        "max_file_bytes": perm.max_file_bytes,
        "used_bytes": used,
        "can_upload": perm.can_upload,
        "can_use_api_keys": perm.can_use_api_keys,
        "can_upload_client_encrypted": perm.can_upload_client_encrypted,
        "can_delete": perm.can_delete,
        "can_regenerate_links": perm.can_regenerate_links,
        "can_delete_links": perm.can_delete_links,
        "can_create_directories": perm.can_create_directories,
        "can_manage_lifecycle": perm.can_manage_lifecycle,
        "can_use_p2p": perm.can_use_p2p,
        "can_view_admin": perm.can_view_admin,
        "can_manage_users": perm.can_manage_users,
        "can_manage_storage": perm.can_manage_storage,
        "can_manage_api_keys": perm.can_manage_api_keys,
    }
