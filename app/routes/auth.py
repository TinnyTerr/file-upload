from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.audit.log import record
from app.deps import AppState, client_ip, get_db, get_state
from app.models.session import SessionRow
from app.models.user import User
from app.security.csrf import require_csrf
from app.security.passwords import verify_password, hash_password
from app.security.sessions import COOKIE_NAME

router = APIRouter(prefix="/auth", tags=["auth"])

# Constant-time sink for timing-oracle protection — ensures a missing-user path
# costs the same as a wrong-password path (Argon2 verification time).
_DUMMY_HASH = hash_password("__timing_dummy_password_never_valid__")


class LoginBody(BaseModel):
    username: str
    password: str


class PasswordConfirmBody(BaseModel):
    current_password: str


@router.post("/login")
def login(body: LoginBody, request: Request, response: Response,
          db: Session = Depends(get_db)) -> dict:
    state: AppState = get_state(request)
    ip = client_ip(request)

    if not state.lockout.check_login_allowed(db, body.username, ip):
        record(db, actor=body.username, action="login.locked_out", ip=ip)
        db.commit()
        raise HTTPException(status_code=429, detail="too many attempts, try later")

    user = db.query(User).filter_by(username=body.username).one_or_none()
    # Always run Argon2 even if user is absent — equalises response time so
    # response latency cannot reveal whether a username exists (timing oracle).
    hash_to_check = user.password_hash if user is not None else _DUMMY_HASH
    password_ok = verify_password(body.password, hash_to_check)

    if user is None or not password_ok:
        state.lockout.register_failure(db, body.username, identifier_type="user")
        state.lockout.register_failure(db, ip, identifier_type="ip")
        record(db, actor=body.username, action="login.failure", ip=ip)
        db.commit()
        raise HTTPException(status_code=401, detail="invalid credentials")

    # Only reset the per-user counter on success; leaving the IP counter intact
    # prevents an attacker with one valid credential from clearing the IP throttle
    # for brute-force attempts against other accounts from the same IP.
    state.lockout.reset(db, body.username, identifier_type="user")
    ua = request.headers.get("user-agent", "")
    cookie_value, csrf = state.session_manager.create(db, user.id, ip=ip, user_agent=ua)
    response.set_cookie(COOKIE_NAME, cookie_value, **state.session_manager.cookie_params())
    record(db, actor=user.username, action="login.success", target=f"user:{user.id}", ip=ip)
    db.commit()
    return {"csrf_token": csrf, "must_change_credentials": user.must_change_credentials}


@router.post("/logout")
def logout(request: Request, response: Response,
           session_row: SessionRow = Depends(require_csrf),
           db: Session = Depends(get_db)) -> dict:
    state: AppState = get_state(request)
    cookie = request.cookies.get(COOKIE_NAME)
    state.session_manager.destroy(db, cookie)
    response.delete_cookie(COOKIE_NAME, path="/")
    record(db, actor=str(session_row.user_id), action="logout", ip=client_ip(request))
    db.commit()
    return {"status": "logged_out"}


@router.get("/sessions")
def list_sessions(
    session_row: SessionRow = Depends(require_csrf),
    db: Session = Depends(get_db),
) -> dict:
    sessions = db.query(SessionRow).filter_by(user_id=session_row.user_id).all()
    now_ts = None
    from datetime import datetime, timezone
    now_ts = datetime.now(timezone.utc)
    return {
        "sessions": [
            {
                "id": s.id,
                "ip_address": s.ip_address,
                "user_agent": s.user_agent,
                "created_at": s.created_at.isoformat(),
                "last_seen_at": s.last_seen_at.isoformat() if hasattr(s, "last_seen_at") and s.last_seen_at else s.created_at.isoformat(),
                "expires_at": s.expires_at.isoformat(),
                "is_current": s.id == session_row.id,
            }
            for s in sessions
            if (s.expires_at.replace(tzinfo=timezone.utc) if s.expires_at.tzinfo is None else s.expires_at) > now_ts
        ]
    }


@router.delete("/sessions/{session_id}")
def revoke_session(
    session_id: str,
    body: PasswordConfirmBody,
    request: Request,
    session_row: SessionRow = Depends(require_csrf),
    db: Session = Depends(get_db),
) -> dict:
    user = db.get(User, session_row.user_id)
    if user is None or not verify_password(body.current_password, user.password_hash):
        raise HTTPException(status_code=401, detail="invalid password")
    target = db.get(SessionRow, session_id)
    if target is None or target.user_id != session_row.user_id:
        raise HTTPException(status_code=404, detail="session not found")
    db.delete(target)
    record(db, actor=user.username, action="session.revoked",
           target=f"session:{session_id}", ip=client_ip(request))
    db.commit()
    return {"status": "revoked"}


@router.delete("/sessions")
def revoke_all_sessions(
    body: PasswordConfirmBody,
    request: Request,
    response: Response,
    session_row: SessionRow = Depends(require_csrf),
    db: Session = Depends(get_db),
) -> dict:
    user = db.get(User, session_row.user_id)
    if user is None or not verify_password(body.current_password, user.password_hash):
        raise HTTPException(status_code=401, detail="invalid password")
    db.query(SessionRow).filter_by(user_id=session_row.user_id).delete()
    response.delete_cookie(COOKIE_NAME, path="/")
    record(db, actor=user.username, action="session.revoked_all",
           target=f"user:{user.id}", ip=client_ip(request))
    db.commit()
    return {"status": "all_revoked"}
