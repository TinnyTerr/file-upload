from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import ForeignKey, Integer, LargeBinary, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base, UTCDateTime


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Credential(Base):
    __tablename__ = "credentials"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(Integer, ForeignKey("users.id"), nullable=False)
    kind: Mapped[str] = mapped_column(String(16), nullable=False)
    secret_blob: Mapped[bytes | None] = mapped_column(LargeBinary, nullable=True)
    webauthn_id: Mapped[str | None] = mapped_column(String(512), nullable=True)
    webauthn_public_key: Mapped[bytes | None] = mapped_column(LargeBinary, nullable=True)
    sign_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    label: Mapped[str | None] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=_utcnow)
