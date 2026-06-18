from __future__ import annotations

import hashlib

from sqlalchemy import text
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session

from app.models.audit import AuditEntry

GENESIS = "0" * 64


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


def _hash_row(prev_hash: str, actor: str, action: str,
              target: str | None, ip: str | None) -> str:
    canonical = "|".join([prev_hash, actor, action, target or "", ip or ""])
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def record(session: Session, actor: str, action: str,
           target: str | None = None, ip: str | None = None) -> AuditEntry:
    last = session.query(AuditEntry).order_by(AuditEntry.id.desc()).first()
    prev_hash = last.entry_hash if last else GENESIS
    entry_hash = _hash_row(prev_hash, actor, action, target, ip)
    entry = AuditEntry(actor=actor, action=action, target=target, ip=ip,
                       prev_hash=prev_hash, entry_hash=entry_hash)
    session.add(entry)
    session.commit()
    return entry


def verify_chain(session: Session) -> bool:
    prev = GENESIS
    for row in session.query(AuditEntry).order_by(AuditEntry.id).all():
        expected = _hash_row(prev, row.actor, row.action, row.target, row.ip)
        if row.prev_hash != prev or row.entry_hash != expected:
            return False
        prev = row.entry_hash
    return True
