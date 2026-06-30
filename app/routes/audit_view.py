from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy import String, cast, or_
from sqlalchemy.orm import Session

from app.audit.log import verify_chain
from app.deps import get_db, require_master
from app.models.audit import AuditEntry
from app.models.cluster_event import ClusterEvent
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


@router.get("/cluster")
def cluster_events(
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    q: str | None = Query(None, max_length=200),
    action: str | None = Query(None, max_length=64),
    kind: str | None = Query(None, max_length=16),
    server: str | None = Query(None, max_length=64),
    master: User = Depends(require_master),
    db: Session = Depends(get_db),
) -> dict:
    """Cluster-wide event log aggregated from every node (the local node's own
    events plus peers', ingested via the firehose). Filterable by ``server``
    (origin node id), ``kind``, ``action`` and free text. This is the non-hash-
    chained companion to ``/audit/`` — use ``/audit/`` for tamper-evident local
    audit, this for the unified, server-filterable cross-node view."""
    base = db.query(ClusterEvent)
    total_count = base.count()

    actions = [
        row[0] for row in
        db.query(ClusterEvent.action).distinct().order_by(ClusterEvent.action.asc()).all()
    ]
    servers = [
        {"node_id": row[0], "node_name": row[1]}
        for row in db.query(ClusterEvent.origin_node_id, ClusterEvent.origin_node_name)
        .distinct()
        .order_by(ClusterEvent.origin_node_name.asc())
        .all()
    ]

    query = base
    if action:
        query = query.filter(ClusterEvent.action == action)
    if kind:
        query = query.filter(ClusterEvent.kind == kind)
    if server:
        query = query.filter(ClusterEvent.origin_node_id == server)

    terms = [term.strip() for term in (q or "").split() if term.strip()]
    for term in terms:
        needle = f"%{term}%"
        query = query.filter(or_(
            ClusterEvent.actor.ilike(needle),
            ClusterEvent.action.ilike(needle),
            ClusterEvent.target.ilike(needle),
            ClusterEvent.ip.ilike(needle),
            ClusterEvent.origin_node_name.ilike(needle),
        ))

    filtered_count = query.count()
    entries = (
        query
        .order_by(ClusterEvent.ts.desc(), ClusterEvent.id.desc())
        .offset(offset)
        .limit(limit)
        .all()
    )
    return {
        "entries": [
            {
                "id": e.id,
                "node_id": e.origin_node_id,
                "node_name": e.origin_node_name,
                "kind": e.kind,
                "actor": e.actor,
                "action": e.action,
                "target": e.target,
                "ip": e.ip,
                "ts": e.ts.isoformat() if e.ts else None,
            }
            for e in entries
        ],
        "actions": actions,
        "servers": servers,
        "total_count": total_count,
        "filtered_count": filtered_count,
        "limit": limit,
        "offset": offset,
    }
