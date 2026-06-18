from __future__ import annotations

from dataclasses import dataclass
from typing import Iterator

from fastapi import Depends, HTTPException, Request
from sqlalchemy.orm import Session

from app.config import Settings
from app.security.lockout import LockoutPolicy
from app.security.sessions import COOKIE_NAME, SessionManager
from app.models.session import SessionRow


@dataclass
class AppState:
    settings: Settings
    session_factory: object
    session_manager: SessionManager
    lockout: LockoutPolicy
    bootstrap_password: str | None = None


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
    xff = request.headers.get("x-forwarded-for")
    if xff:
        # Trust exactly one proxy hop: rightmost entry is the proxy's view of the client.
        return xff.split(",")[-1].strip()
    return request.client.host if request.client else "unknown"


def current_session(request: Request, db: Session = Depends(get_db)) -> SessionRow:
    state = get_state(request)
    cookie = request.cookies.get(COOKIE_NAME)
    row = state.session_manager.resolve(db, cookie)
    if row is None:
        raise HTTPException(status_code=401, detail="not authenticated")
    return row


def require_active_user(session_row: SessionRow = Depends(current_session),
                        db: Session = Depends(get_db)) -> "User":
    from app.models.user import User
    user = db.get(User, session_row.user_id)
    if user is None:
        raise HTTPException(status_code=401, detail="not authenticated")
    if user.must_change_credentials:
        raise HTTPException(status_code=403, detail="must change credentials")
    return user
