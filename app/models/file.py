from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import BigInteger, Boolean, ForeignKey, Integer, LargeBinary, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base, UTCDateTime


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class FileObject(Base):
    __tablename__ = "files"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    owner_id: Mapped[int] = mapped_column(Integer, ForeignKey("users.id"), nullable=False)
    # When set, this file belongs to a shareable directory bundle and inherits
    # that directory's single shared encryption key. NULL = standalone file.
    directory_id: Mapped[int | None] = mapped_column(
        Integer, ForeignKey("directories.id"), nullable=True, index=True
    )
    storage_path: Mapped[str] = mapped_column(String(512), nullable=False)
    original_filename: Mapped[str] = mapped_column(String(512), nullable=False)
    size_bytes: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    stored_size_bytes: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    content_type: Mapped[str] = mapped_column(
        String(255), nullable=False, default="application/octet-stream"
    )
    encryption_mode: Mapped[str] = mapped_column(String(16), nullable=False, default="none")
    enc_key_blob: Mapped[bytes | None] = mapped_column(LargeBinary, nullable=True)
    # Server-side mode only: the access credential (the ?ek= value) the downloader
    # must present, sealed with the master key. The server holds the real
    # decryption key (enc_key_blob); this is the access gate the user must know.
    enc_access_blob: Mapped[bytes | None] = mapped_column(LargeBinary, nullable=True)
    compressed: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    archived: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    archive_codec: Mapped[str | None] = mapped_column(String(16), nullable=True)
    archive_after_idle_days: Mapped[int | None] = mapped_column(Integer, nullable=True)
    lifecycle_state: Mapped[str] = mapped_column(String(16), nullable=False, default="active")
    is_permanent: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    expires_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
    delete_if_idle_days: Mapped[int | None] = mapped_column(Integer, nullable=True)
    auto_unarchive_on_download: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True
    )
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=_utcnow)
    last_downloaded_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
