from __future__ import annotations

import hashlib
import logging
from datetime import datetime, timezone

from sqlalchemy import text
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session

from app.models.audit import AuditEntry

GENESIS = "0" * 64

# Surfaces every audit event in the standard backend log stream (and thus the
# admin Logs viewer / cluster monitoring), alongside the websocket firehose.
_event_log = logging.getLogger("app.event")


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def install_append_only_triggers(engine: Engine) -> None:
    stmts = [
        """CREATE TRIGGER IF NOT EXISTS audit_no_update
           BEFORE UPDATE ON audit_log
           BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;""",
        """CREATE TRIGGER IF NOT EXISTS audit_no_delete
           BEFORE DELETE ON audit_log
           BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;""",
    ]
    with engine.begin() as conn:
        for s in stmts:
            conn.execute(text(s))

    # Serialize the hash chain at the DB layer: a UNIQUE index on prev_hash means
    # two writers that concurrently read the same predecessor can't both commit —
    # the loser hits a constraint violation and rolls back instead of silently
    # forking the chain (which would make verify_chain() report tampering forever).
    # Guarded so a pre-existing fork in an old DB doesn't block startup.
    try:
        with engine.begin() as conn:
            conn.execute(text(
                "CREATE UNIQUE INDEX IF NOT EXISTS ix_audit_prev_hash "
                "ON audit_log(prev_hash)"
            ))
    except Exception:
        pass


def _escape(s: str) -> str:
    return s.replace("\\", "\\\\").replace("|", "\\|")


def _hash_row(prev_hash: str, actor: str, action: str,
              target: str | None, ip: str | None,
              created_at: datetime) -> str:
    canonical = "|".join([
        prev_hash,
        _escape(actor),
        _escape(action),
        _escape(target or ""),
        _escape(ip or ""),
        _escape(created_at.isoformat()),
    ])
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def record(session: Session, actor: str, action: str,
           target: str | None = None, ip: str | None = None) -> AuditEntry:
    """Append an audit entry to the hash chain and flush (but do NOT commit).

    The caller owns the transaction boundary and must call session.commit()
    after all mutations are complete, so the audit entry and the triggering
    mutation land in a single atomic commit.
    """
    last = session.query(AuditEntry).order_by(AuditEntry.id.desc()).first()
    prev_hash = last.entry_hash if last else GENESIS
    created_at = _utcnow()
    entry_hash = _hash_row(prev_hash, actor, action, target, ip, created_at)
    entry = AuditEntry(actor=actor, action=action, target=target, ip=ip,
                       created_at=created_at,
                       prev_hash=prev_hash, entry_hash=entry_hash)
    session.add(entry)
    session.flush()
    # Mirror the event into the backend log stream so it shows up in the admin
    # Logs viewer and anything tailing process logs.
    _event_log.info(
        "event action=%s actor=%s target=%s ip=%s",
        action, actor, target or "-", ip or "-",
    )
    # Fan the event out to live websocket subscribers (per-user sockets and the
    # cluster/monitoring firehose). Best-effort and decoupled from the DB commit:
    # the recent-events replay buffer smooths over the rare rolled-back entry.
    try:
        from app.observability.events import event_bus
        event_bus.publish(action=action, actor=actor, target=target, ip=ip)
    except Exception:
        pass
    return entry


def verify_chain(session: Session) -> bool:
    prev = GENESIS
    for row in session.query(AuditEntry).order_by(AuditEntry.id).all():
        expected = _hash_row(prev, row.actor, row.action, row.target, row.ip,
                             row.created_at)
        if row.prev_hash != prev or row.entry_hash != expected:
            return False
        prev = row.entry_hash
    return True
