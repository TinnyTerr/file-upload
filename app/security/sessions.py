from __future__ import annotations

import secrets
from datetime import datetime, timedelta, timezone

from itsdangerous import BadData, URLSafeSerializer
from sqlalchemy.orm import Session

from app.models.session import SessionRow

COOKIE_NAME = "fu_session"
SESSION_TTL_SECONDS = 86400


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class SessionManager:
    def __init__(self, secret_key: str, secure: bool):
        self._serializer = URLSafeSerializer(secret_key, salt="session")
        self._secure = secure

    def create(self, session: Session, user_id: int) -> tuple[str, str]:
        sid = secrets.token_urlsafe(32)
        csrf = secrets.token_urlsafe(32)
        row = SessionRow(
            id=sid, user_id=user_id, csrf_token=csrf,
            expires_at=_utcnow() + timedelta(seconds=SESSION_TTL_SECONDS),
        )
        session.add(row)
        session.commit()
        return self._serializer.dumps(sid), csrf

    def _unsign(self, cookie_value: str) -> str | None:
        try:
            return self._serializer.loads(cookie_value)
        except BadData:
            return None

    def resolve(self, session: Session, cookie_value: str | None) -> SessionRow | None:
        if not cookie_value:
            return None
        sid = self._unsign(cookie_value)
        if sid is None:
            return None
        row = session.get(SessionRow, sid)
        if row is None:
            return None
        exp = row.expires_at
        if exp.tzinfo is None:
            exp = exp.replace(tzinfo=timezone.utc)
        if exp < _utcnow():
            return None
        return row

    def destroy(self, session: Session, cookie_value: str | None) -> None:
        if not cookie_value:
            return
        sid = self._unsign(cookie_value)
        if sid is None:
            return
        row = session.get(SessionRow, sid)
        if row is not None:
            session.delete(row)
            session.commit()

    def cookie_params(self) -> dict:
        return {
            "httponly": True,
            "samesite": "strict",
            "secure": self._secure,
            "max_age": SESSION_TTL_SECONDS,
            "path": "/",
        }
