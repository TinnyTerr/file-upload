from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base, UTCDateTime


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class DirectoryCollaborator(Base):
    __tablename__ = "directory_collaborators"
    __table_args__ = (UniqueConstraint("directory_id", "user_id"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    directory_id: Mapped[int] = mapped_column(Integer, ForeignKey("directories.id"), nullable=False, index=True)
    user_id: Mapped[int] = mapped_column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    invited_by_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("users.id"), nullable=True)
    role: Mapped[str] = mapped_column(String(16), nullable=False, default="editor")
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=_utcnow)

