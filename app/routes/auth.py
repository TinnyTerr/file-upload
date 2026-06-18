from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.audit.log import record
from app.deps import AppState, client_ip, get_db, get_state
from app.models.user import User
from app.security.passwords import verify_password
from app.security.sessions import COOKIE_NAME

router = APIRouter(prefix="/auth", tags=["auth"])


class LoginBody(BaseModel):
    username: str
    password: str


@router.post("/login")
def login(body: LoginBody, request: Request, response: Response,
          db: Session = Depends(get_db)) -> dict:
    state: AppState = get_state(request)
    ip = client_ip(request)

    if not state.lockout.check_login_allowed(db, body.username, ip):
        record(db, actor=body.username, action="login.locked_out", ip=ip)
        raise HTTPException(status_code=429, detail="too many attempts, try later")

    user = db.query(User).filter_by(username=body.username).one_or_none()
    if user is None or not verify_password(body.password, user.password_hash):
        state.lockout.register_failure(db, body.username, "user")
        state.lockout.register_failure(db, ip, "ip")
        record(db, actor=body.username, action="login.failure", ip=ip)
        raise HTTPException(status_code=401, detail="invalid credentials")

    state.lockout.reset(db, body.username, "user")
    state.lockout.reset(db, ip, "ip")
    cookie_value, csrf = state.session_manager.create(db, user.id)
    response.set_cookie(COOKIE_NAME, cookie_value, **state.session_manager.cookie_params())
    record(db, actor=user.username, action="login.success", target=f"user:{user.id}", ip=ip)
    return {"csrf_token": csrf, "must_change_credentials": user.must_change_credentials}


@router.post("/logout")
def logout(request: Request, response: Response, db: Session = Depends(get_db)) -> dict:
    state: AppState = get_state(request)
    cookie = request.cookies.get(COOKIE_NAME)
    state.session_manager.destroy(db, cookie)
    response.delete_cookie(COOKIE_NAME, path="/")
    return {"status": "logged_out"}
