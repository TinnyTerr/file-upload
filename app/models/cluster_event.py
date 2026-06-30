from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import BigInteger, Index, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base, UTCDateTime


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class ClusterEvent(Base):
    """A replicated, cluster-wide mirror of firehose events.

    Unlike ``AuditEntry`` (a per-node, hash-chained, security-of-record log), this
    table is a denormalised view that aggregates *every* node's events — durable
    audit actions plus high-volume ephemeral ones (lookups, denials) that should
    never bloat the hash chain. Each node writes its own events here and ingests
    its peers' events via the firehose consumers, so any single node's table is a
    complete cluster-wide event log that the admin UI can filter by server.

    Rows are deduplicated on ``(origin_node_id, origin_seq)``: a peer's event has
    a stable identity (its producing node id + that node's monotonic publish seq),
    so re-polling or cross-delivery never double-inserts.
    """

    __tablename__ = "cluster_events"
    __table_args__ = (
        UniqueConstraint("origin_node_id", "origin_seq",
                         name="uq_cluster_event_origin"),
        Index("ix_cluster_event_ts", "ts"),
        Index("ix_cluster_event_origin_node", "origin_node_id"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    # Which node produced the event, and that node's local publish sequence.
    origin_node_id: Mapped[str] = mapped_column(String(64), nullable=False)
    origin_seq: Mapped[int] = mapped_column(BigInteger, nullable=False)
    origin_node_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    ts: Mapped[datetime] = mapped_column(UTCDateTime, nullable=False)
    # "audit" | "lookup" | "denial" | "system" — lets the UI separate durable
    # audit actions from high-volume ephemeral telemetry.
    kind: Mapped[str] = mapped_column(String(16), nullable=False, default="audit")
    action: Mapped[str] = mapped_column(String(64), nullable=False)
    actor: Mapped[str] = mapped_column(String(255), nullable=False)
    target: Mapped[str | None] = mapped_column(String(255), nullable=True)
    ip: Mapped[str | None] = mapped_column(String(64), nullable=True)
    # When this row was written on the local node (vs. ``ts`` = event time).
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=_utcnow)
