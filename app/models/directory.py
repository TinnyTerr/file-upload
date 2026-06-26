from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import BigInteger, ForeignKey, Integer, LargeBinary, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base, UTCDateTime


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Directory(Base):
    """A shareable bundle of files viewable at /d/{slug}.

    Every file in a directory is sealed with a SINGLE shared key (one ?ek= for
    the whole bundle, or one #ek= fragment for end-to-end) — the encryption mode
    is chosen once, at the directory level, and applied to every member file.
    """

    __tablename__ = "directories"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    owner_id: Mapped[int] = mapped_column(Integer, ForeignKey("users.id"), nullable=False)
    slug: Mapped[str] = mapped_column(String(64), unique=True, nullable=False, index=True)
    title: Mapped[str] = mapped_column(String(512), nullable=False, default="Untitled folder")

    # One mode for the whole bundle: none | server | client
    encryption_mode: Mapped[str] = mapped_column(String(16), nullable=False, default="none")
    # Server mode: the shared per-directory key, sealed with the master key.
    enc_key_blob: Mapped[bytes | None] = mapped_column(LargeBinary, nullable=True)
    # Server mode: the shared access credential (the ?ek= value), sealed so the
    # owner/master can rebuild the share URL later.
    enc_access_blob: Mapped[bytes | None] = mapped_column(LargeBinary, nullable=True)

    total_bytes: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    expires_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=_utcnow)
