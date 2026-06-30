from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import BigInteger, Boolean, ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base, UTCDateTime


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class ClusterNode(Base):
    """A remote server this node is linked to.

    Created by handing this server another server's base URL and cluster token
    ("passing" the remote token). The stored ``token`` is the remote node's
    firehose credential — it lets this server subscribe to the remote's events.
    Treat the table as secret-bearing.
    """

    __tablename__ = "cluster_nodes"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    base_url: Mapped[str] = mapped_column(String(512), nullable=False)
    # The remote server's cluster token. Sensitive — never serialized back to
    # clients except masked.
    token: Mapped[str] = mapped_column(String(512), nullable=False)
    active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    # The remote server's stable identity + capabilities, learned at join time and
    # refreshed by heartbeats. Used for replication routing and failover.
    node_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    is_master: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    archive_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    replication_mode: Mapped[str] = mapped_column(
        String(16), nullable=False, default="full"
    )
    disk_total_bytes: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    disk_free_bytes: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    used_bytes: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    created_by_id: Mapped[int | None] = mapped_column(
        Integer, ForeignKey("users.id"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=_utcnow)
    last_seen_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
    last_heartbeat_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
