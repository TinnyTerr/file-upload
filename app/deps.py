from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Callable, Iterator

from fastapi import Depends, HTTPException, Request
from sqlalchemy.orm import Session

from app.config import Settings
from app.models.session import SessionRow
from app.models.user import User
from app.security.lockout import LockoutPolicy
from app.security.sessions import COOKIE_NAME, SessionManager


@dataclass
class AppState:
    settings: Settings
    session_factory: object
    session_manager: SessionManager
    lockout: LockoutPolicy
    bootstrap_password: str | None = None
    # Current cluster/monitoring firehose token. Seeded from settings; may be
    # rotated at runtime by a master via the admin API.
    cluster_token: str = ""


def get_state(request: Request) -> AppState:
    return request.app.state.app_state


def get_db(request: Request) -> Iterator[Session]:
    state = get_state(request)
    db = state.session_factory()
    try:
        yield db
    finally:
        db.close()


def client_ip(request: Request) -> str:
    state = request.app.state.app_state
    if getattr(state.settings, "trust_proxy", False):
        xff = request.headers.get("x-forwarded-for")
        if xff:
            # Leftmost entry is the original client when behind a trusted proxy.
            return xff.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def current_session(request: Request, db: Session = Depends(get_db)) -> SessionRow:
    state = get_state(request)
    cookie = request.cookies.get(COOKIE_NAME)
    row = state.session_manager.resolve(db, cookie)
    if row is None:
        raise HTTPException(status_code=401, detail="not authenticated")
    return row


def require_active_user(session_row: SessionRow = Depends(current_session),
                        db: Session = Depends(get_db)) -> User:
    user = db.get(User, session_row.user_id)
    if user is None:
        raise HTTPException(status_code=401, detail="not authenticated")
    if user.must_change_credentials:
        raise HTTPException(status_code=403, detail="must change credentials")
    return user


def require_master(user: User = Depends(require_active_user)) -> User:
    if user.role != "master":
        raise HTTPException(status_code=403, detail="master only")
    return user


def require_permission(name: str) -> Callable[..., User]:
    from app.permissions.policy import ensure_permissions, has_permission

    def _dep(user: User = Depends(require_active_user),
             db: Session = Depends(get_db)) -> User:
        perm = ensure_permissions(db, user.id, master=(user.role == "master"))
        db.commit()
        if not has_permission(perm, name):
            raise HTTPException(status_code=403, detail="permission denied")
        return user

    return _dep


def get_upload_user(request: Request, db: Session = Depends(get_db)) -> "User":
    """Session+CSRF auth OR Bearer API key auth. Returns authenticated User."""
    from datetime import timezone
    from app.models.session import SessionRow
    from app.permissions.policy import ensure_permissions, has_permission
    from app.security.sessions import COOKIE_NAME

    auth_header = request.headers.get("authorization", "")
    if auth_header.startswith("Bearer "):
        from app.models.api_key import ApiKey
        from app.security.api_keys import hash_key, bind_or_reject
        from app.audit.log import record

        raw = auth_header[len("Bearer "):].strip()
        api_key = db.query(ApiKey).filter_by(key_hash=hash_key(raw), active=True).one_or_none()
        if api_key is None:
            raise HTTPException(status_code=401, detail="invalid api key")
        ip = client_ip(request)
        if not bind_or_reject(api_key, ip, datetime.now(timezone.utc)):
            record(db, actor=f"apikey:{api_key.id}", action="apikey.ip_rejected",
                   target=f"apikey:{api_key.id}", ip=ip)
            db.commit()
            raise HTTPException(status_code=403, detail="api key ip mismatch")
        db.commit()
        user = db.get(User, api_key.owner_id)
        if user is None or user.must_change_credentials:
            raise HTTPException(status_code=401, detail="invalid api key owner")
        perm = ensure_permissions(db, user.id, master=(user.role == "master"))
        if not has_permission(perm, "can_upload"):
            raise HTTPException(status_code=403, detail="permission denied")
        return user
    else:
        state = get_state(request)
        cookie = request.cookies.get(COOKIE_NAME)
        row = state.session_manager.resolve(db, cookie)
        if row is None:
            raise HTTPException(status_code=401, detail="not authenticated")
        csrf = request.headers.get("x-csrf-token", "")
        if not csrf or csrf != row.csrf_token:
            raise HTTPException(status_code=403, detail="invalid or missing CSRF token")
        user = db.get(User, row.user_id)
        if user is None or user.must_change_credentials:
            raise HTTPException(status_code=401, detail="not authenticated")
        perm = ensure_permissions(db, user.id, master=(user.role == "master"))
        if not has_permission(perm, "can_upload"):
            raise HTTPException(status_code=403, detail="permission denied")
        return user


def require_api_key(request: Request, db: Session = Depends(get_db)):
    from app.models.api_key import ApiKey
    from app.security.api_keys import hash_key, bind_or_reject
    from app.audit.log import record

    header = request.headers.get("authorization", "")
    if not header.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="missing api key")
    raw = header[len("Bearer "):].strip()
    if not raw:
        raise HTTPException(status_code=401, detail="missing api key")

    api_key = (
        db.query(ApiKey)
        .filter_by(key_hash=hash_key(raw), active=True)
        .one_or_none()
    )
    if api_key is None:
        raise HTTPException(status_code=401, detail="invalid api key")

    ip = client_ip(request)
    if not bind_or_reject(api_key, ip, datetime.now(timezone.utc)):
        record(db, actor=f"apikey:{api_key.id}", action="apikey.ip_rejected",
               target=f"apikey:{api_key.id}", ip=ip)
        db.commit()
        raise HTTPException(status_code=403, detail="api key ip mismatch")
    db.commit()
    return api_key
