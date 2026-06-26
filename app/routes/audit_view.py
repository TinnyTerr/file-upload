from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.audit.log import verify_chain
from app.deps import get_db, require_master
from app.models.audit import AuditEntry
from app.models.user import User

router = APIRouter(prefix="/audit", tags=["audit"])


@router.get("/")
def audit_log(
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    master: User = Depends(require_master),
    db: Session = Depends(get_db),
) -> dict:
    entries = (
        db.query(AuditEntry)
        .order_by(AuditEntry.id.desc())
        .offset(offset)
        .limit(limit)
        .all()
    )
    chain_ok = verify_chain(db)
    return {
        "entries": [
            {
                "id": e.id,
                "actor": e.actor,
                "action": e.action,
                "target": e.target,
                "ip": e.ip,
                "created_at": e.created_at.isoformat(),
            }
            for e in entries
        ],
        "chain_ok": chain_ok,
    }
