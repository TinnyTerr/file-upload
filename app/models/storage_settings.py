from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import BigInteger, Integer
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base, UTCDateTime

_GB = 1024 ** 3


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class StorageSettings(Base):
    __tablename__ = "storage_settings"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    global_storage_quota_bytes: Mapped[int] = mapped_column(
        BigInteger, nullable=False, default=500 * _GB
    )
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=_utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        UTCDateTime, default=_utcnow, onupdate=_utcnow
    )
