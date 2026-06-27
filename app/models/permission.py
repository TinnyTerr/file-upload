from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import Boolean, BigInteger, ForeignKey, Integer
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base, UTCDateTime

_GB = 1024 ** 3


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Permission(Base):
    __tablename__ = "permissions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("users.id"), unique=True, nullable=False
    )
    can_upload: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    can_upload_client_encrypted: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False
    )
    can_delete: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    can_regenerate_links: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True
    )
    can_delete_links: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    can_create_directories: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True
    )
    can_manage_lifecycle: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True
    )
    can_use_api_keys: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False
    )
    can_use_p2p: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    can_view_admin: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    can_manage_users: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    can_manage_storage: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    can_manage_api_keys: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False
    )
    quota_bytes: Mapped[int] = mapped_column(
        BigInteger, nullable=False, default=100 * _GB
    )
    max_file_bytes: Mapped[int] = mapped_column(
        BigInteger, nullable=False, default=10 * _GB
    )
    archive_after_idle_days: Mapped[int] = mapped_column(
        Integer, nullable=False, default=5
    )
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=_utcnow)
