from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import Boolean, ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base, UTCDateTime


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class DropboxUploadLink(Base):
    __tablename__ = "dropbox_upload_links"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    owner_id: Mapped[int] = mapped_column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    target_directory_id: Mapped[int | None] = mapped_column(
        Integer, ForeignKey("directories.id"), nullable=True, index=True
    )
    token_enc: Mapped[bytes | None] = mapped_column(nullable=True)
    token_hash: Mapped[str] = mapped_column(String(64), nullable=False, unique=True, index=True)
    active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    expires_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
    used_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=_utcnow)

