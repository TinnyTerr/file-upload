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
    user.username = body.new_username
    user.password_hash = hash_password(body.new_password)
    user.must_change_credentials = False
    record(db, actor=user.username, action="account.credentials_changed",
           target=f"user:{user.id}", ip=client_ip(request))
    db.commit()
    return {"status": "updated"}


@router.get("/me")
def me(user: User = Depends(require_active_user)) -> dict:
    return {"id": user.id, "username": user.username, "role": user.role}
