from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy import String, cast, or_
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
    q: str | None = Query(None, max_length=200),
    action: str | None = Query(None, max_length=64),
    master: User = Depends(require_master),
    db: Session = Depends(get_db),
) -> dict:
    base = db.query(AuditEntry)
    total_count = base.count()
    actions = [
        row[0] for row in
        db.query(AuditEntry.action).distinct().order_by(AuditEntry.action.asc()).all()
    ]

    query = base
    if action:
        query = query.filter(AuditEntry.action == action)

    terms = [term.strip() for term in (q or "").split() if term.strip()]
    for term in terms:
        needle = f"%{term}%"
        query = query.filter(or_(
            cast(AuditEntry.id, String).ilike(needle),
            AuditEntry.actor.ilike(needle),
            AuditEntry.action.ilike(needle),
            AuditEntry.target.ilike(needle),
            AuditEntry.ip.ilike(needle),
        ))

    filtered_count = query.count()
    entries = (
        query
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
        "actions": actions,
        "total_count": total_count,
        "filtered_count": filtered_count,
        "limit": limit,
        "offset": offset,
    }
