from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.audit.log import record
from app.deps import client_ip, get_db, require_active_user, require_master, require_permission
from app.models.api_key import ApiKey
from app.models.session import SessionRow
from app.models.user import User
from app.security.api_keys import generate_key, hash_key
from app.security.csrf import require_csrf
from app.security.passwords import verify_password

router = APIRouter(prefix="/keys", tags=["keys"])
admin_router = APIRouter(tags=["keys"])

# Cap on simultaneously-active keys per user. Keys are never hard-deleted (only
# deactivated), so without a ceiling a user could grow the table without bound.
_MAX_ACTIVE_KEYS_PER_USER = 20


@router.post("/")
def create_key(
    request: Request,
    _csrf: SessionRow = Depends(require_csrf),
    user: User = Depends(require_permission("can_use_api_keys")),
    db: Session = Depends(get_db),
) -> dict:
    active_count = db.query(ApiKey).filter_by(owner_id=user.id, active=True).count()
    if active_count >= _MAX_ACTIVE_KEYS_PER_USER:
        raise HTTPException(
            429,
            detail=f"active API key limit reached ({_MAX_ACTIVE_KEYS_PER_USER}); revoke one first",
        )
    next_number = (
        db.query(func.max(ApiKey.user_key_number))
        .filter_by(owner_id=user.id)
        .scalar()
        or 0
    ) + 1
    raw = generate_key()
    key = ApiKey(owner_id=user.id, user_key_number=next_number, key_hash=hash_key(raw))
    db.add(key)
    db.flush()
    record(db, actor=user.username, action="apikey.created",
           target=f"apikey:{key.id}", ip=client_ip(request))
    db.commit()
    return {"id": key.id, "user_key_number": key.user_key_number, "key": raw}


@router.get("/")
def list_keys(
    user: User = Depends(require_active_user),
    db: Session = Depends(get_db),
) -> dict:
    keys = (
        db.query(ApiKey)
        .filter_by(owner_id=user.id)
        .order_by(ApiKey.user_key_number.asc())
        .all()
    )
    return {"keys": [_serialize_key(k) for k in keys]}


@admin_router.get("/admin/keys")
def list_admin_keys(
    _master: User = Depends(require_master),
    db: Session = Depends(get_db),
) -> dict:
    users = {u.id: u.username for u in db.query(User).all()}
    keys = (
        db.query(ApiKey)
        .order_by(ApiKey.owner_id.asc(), ApiKey.user_key_number.asc(), ApiKey.id.asc())
        .all()
    )
    return {
        "keys": [
            {**_serialize_key(k), "owner_username": users.get(k.owner_id)}
            for k in keys
        ]
    }


def _serialize_key(k: ApiKey) -> dict:
    return {
        "id": k.id,
        "owner_id": k.owner_id,
        "user_key_number": k.user_key_number,
        "bound_ip": k.bound_ip,
        "active": k.active,
        "created_at": k.created_at.isoformat(),
        "last_used_at": k.last_used_at.isoformat() if k.last_used_at else None,
    }


@router.delete("/{key_id}")
def deactivate_key(
    key_id: int,
    request: Request,
    _csrf: SessionRow = Depends(require_csrf),
    user: User = Depends(require_active_user),
    db: Session = Depends(get_db),
) -> dict:
    key = db.get(ApiKey, key_id)
    if key is None:
        raise HTTPException(404, detail="not found")
    if user.role != "master" and key.owner_id != user.id:
        raise HTTPException(403, detail="not your key")
    key.active = False
    record(db, actor=user.username, action="apikey.deactivated",
           target=f"apikey:{key_id}", ip=client_ip(request))
    db.commit()
    return {"status": "deactivated"}


class ResetIpBody(BaseModel):
    password: str


@router.post("/{key_id}/reset-ip")
def reset_key_ip(
    key_id: int,
    body: ResetIpBody,
    request: Request,
    _csrf: SessionRow = Depends(require_csrf),
    user: User = Depends(require_active_user),
    db: Session = Depends(get_db),
) -> dict:
    key = db.get(ApiKey, key_id)
    if key is None:
        raise HTTPException(404, detail="not found")
    if user.role != "master" and key.owner_id != user.id:
        raise HTTPException(403, detail="not your key")
    if not verify_password(body.password, user.password_hash):
        raise HTTPException(401, detail="invalid password")
    key.bound_ip = None
    record(db, actor=user.username, action="apikey.ip_reset",
           target=f"apikey:{key_id}", ip=client_ip(request))
    db.commit()
    return {"status": "ip_reset"}
