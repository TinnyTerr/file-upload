from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.login_attempt import LoginAttempt


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class LockoutPolicy:
    def __init__(self, max_attempts: int = 5, lockout_seconds: int = 900):
        self.max_attempts = max_attempts
        self.lockout_seconds = lockout_seconds

    def _get(self, session: Session, identifier: str, identifier_type: str) -> LoginAttempt | None:
        return session.execute(
            select(LoginAttempt).where(
                LoginAttempt.identifier == identifier,
                LoginAttempt.identifier_type == identifier_type,
            )
        ).scalar_one_or_none()

    def is_locked(self, session: Session, identifier: str, identifier_type: str) -> bool:
        row = self._get(session, identifier, identifier_type)
        if row is None or row.locked_until is None:
            return False
        until = row.locked_until
        if until.tzinfo is None:
            until = until.replace(tzinfo=timezone.utc)
        return until > _utcnow()

    def register_failure(self, session: Session, identifier: str, identifier_type: str) -> None:
        now = _utcnow()
        row = self._get(session, identifier, identifier_type)
        if row is None:
            row = LoginAttempt(identifier=identifier, identifier_type=identifier_type, failed_count=0)
            session.add(row)
        elif row.locked_until is not None:
            # A prior lockout that has fully expired starts a fresh window, so a
            # 15-minute lockout is a temporary penalty rather than permanent.
            until = row.locked_until
            if until.tzinfo is None:
                until = until.replace(tzinfo=timezone.utc)
            if until <= now:
                row.failed_count = 0
                row.locked_until = None
        else:
            # Sub-threshold failures also decay: if the last failure is older than
            # the lockout window, the counter resets instead of accumulating
            # indefinitely (e.g. 4 stray failures over a week then a 5th = lockout).
            last = row.updated_at
            if last is not None:
                if last.tzinfo is None:
                    last = last.replace(tzinfo=timezone.utc)
                if (now - last).total_seconds() > self.lockout_seconds:
                    row.failed_count = 0
        row.failed_count += 1
        row.updated_at = now
        if row.failed_count >= self.max_attempts:
            row.locked_until = now + timedelta(seconds=self.lockout_seconds)
        session.flush()

    def reset(self, session: Session, identifier: str, identifier_type: str) -> None:
        row = self._get(session, identifier, identifier_type)
        if row is not None:
            row.failed_count = 0
            row.locked_until = None
            row.updated_at = _utcnow()
            session.flush()

    def check_login_allowed(self, session: Session, username: str, ip: str) -> bool:
        return not (self.is_locked(session, username, "user") or self.is_locked(session, ip, "ip"))
