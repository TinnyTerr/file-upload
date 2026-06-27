from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import BigInteger, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base, UTCDateTime


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class ContentBlob(Base):
    __tablename__ = "content_blobs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    storage_path: Mapped[str] = mapped_column(String(512), nullable=False, unique=True)
    content_type: Mapped[str] = mapped_column(
        String(255), nullable=False, default="application/octet-stream"
    )
    size_bytes: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    stored_size_bytes: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    sha256: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    sha1: Mapped[str] = mapped_column(String(40), nullable=False, default="")
    md5: Mapped[str] = mapped_column(String(32), nullable=False, default="")
    blake2b: Mapped[str] = mapped_column(String(128), nullable=False, default="")
    stored_sha256: Mapped[str] = mapped_column(String(64), nullable=False, default="")
    transform_key: Mapped[str] = mapped_column(String(64), nullable=False, default="plain")
    ref_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    media_width: Mapped[int | None] = mapped_column(Integer, nullable=True)
    media_height: Mapped[int | None] = mapped_column(Integer, nullable=True)
    media_duration_seconds: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=_utcnow)

