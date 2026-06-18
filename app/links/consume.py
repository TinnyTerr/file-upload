from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import and_, or_, update
from sqlalchemy.orm import Session

from app.models.link import Link


def _now(now: datetime | None) -> datetime:
    return now or datetime.now(timezone.utc)


def resolve_active_link(session: Session, slug: str, now: datetime | None = None) -> Link | None:
    now = _now(now)
    link = session.query(Link).filter_by(slug=slug).one_or_none()
    if link is None or not link.active:
        return None
    if link.expires_at is not None and link.expires_at <= now:
        return None
    return link


def consume_use(session: Session, slug: str, now: datetime | None = None) -> bool:
    """Atomically claim one use. Returns True iff a row was consumed.

    The WHERE clause enforces active/expiry/max_uses in a single statement so
    there is no read-modify-write race on use_count. Caller commits.
    """
    now = _now(now)
    stmt = (
        update(Link)
        .where(
            and_(
                Link.slug == slug,
                Link.active.is_(True),
                or_(Link.expires_at.is_(None), Link.expires_at > now),
                or_(Link.max_uses.is_(None), Link.use_count < Link.max_uses),
            )
        )
        .values(use_count=Link.use_count + 1)
    )
    result = session.execute(stmt)
    return result.rowcount == 1
