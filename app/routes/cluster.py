from __future__ import annotations

import secrets
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.audit.log import record
from app.config import set_env_value
from app.deps import AppState, client_ip, get_db, get_state, require_permission
from app.models.cluster_node import ClusterNode
from app.models.user import User
from app.security.csrf import require_csrf

router = APIRouter(prefix="/cluster", tags=["cluster"])

# Master bypasses every permission flag inside require_permission, so this also
# covers masters without a separate gate.
require_cluster = require_permission("can_manage_cluster")


def _mask(token: str) -> str:
    """Render a token as ``••••<last4>`` so the UI can show which node owns it
    without re-exposing the full secret on every list call."""
    if not token:
        return ""
    tail = token[-4:] if len(token) > 4 else token
    return f"••••{tail}"


def _serialize_node(node: ClusterNode) -> dict:
    return {
        "id": node.id,
        "name": node.name,
        "base_url": node.base_url,
        "token_preview": _mask(node.token),
        "active": node.active,
        "created_at": node.created_at.isoformat() if node.created_at else None,
        "last_seen_at": node.last_seen_at.isoformat() if node.last_seen_at else None,
    }


# ── local cluster token ───────────────────────────────────────────────────────


@router.get("/token")
def reveal_token(_user: User = Depends(require_cluster),
                 state: AppState = Depends(get_state)) -> dict:
    """Reveal this server's current cluster token. Hand this to another node so
    it can subscribe to our firehose."""
    return {"token": state.cluster_token}


@router.post("/token/rotate")
def rotate_token(request: Request,
                 _csrf=Depends(require_csrf),
                 user: User = Depends(require_cluster),
                 db: Session = Depends(get_db)) -> dict:
    """Generate a new cluster token and persist it. The previous token stops
    working immediately — every firehose/poll consumer must be updated."""
    state: AppState = get_state(request)
    new_token = secrets.token_urlsafe(32)
    state.cluster_token = new_token
    try:
        set_env_value(Path(state.settings.config_path), "CLUSTER_TOKEN", new_token)
    except OSError:
        pass
    record(db, actor=user.username, action="cluster.token_rotated",
           target="cluster_token", ip=client_ip(request))
    db.commit()
    return {"token": new_token}


# ── linked remote nodes ───────────────────────────────────────────────────────


class CreateNodeBody(BaseModel):
    name: str = Field(..., min_length=1, max_length=255)
    base_url: str = Field(..., min_length=1, max_length=512)
    token: str = Field(..., min_length=1, max_length=512)


@router.get("/nodes")
def list_nodes(_user: User = Depends(require_cluster),
               db: Session = Depends(get_db)) -> dict:
    """List the remote nodes this server is linked to. Tokens are masked."""
    nodes = db.query(ClusterNode).order_by(ClusterNode.created_at).all()
    return {"nodes": [_serialize_node(n) for n in nodes]}


@router.post("/nodes")
def create_node(body: CreateNodeBody,
                request: Request,
                _csrf=Depends(require_csrf),
                user: User = Depends(require_cluster),
                db: Session = Depends(get_db)) -> dict:
    """Link this server to a remote node by supplying its base URL and cluster
    token (passing the other server's token)."""
    base_url = body.base_url.strip().rstrip("/")
    if not base_url.startswith(("http://", "https://")):
        raise HTTPException(400, detail="base_url must start with http:// or https://")
    node = ClusterNode(
        name=body.name.strip(),
        base_url=base_url,
        token=body.token.strip(),
        created_by_id=user.id,
    )
    db.add(node)
    db.flush()
    record(db, actor=user.username, action="cluster.node_linked",
           target=f"node:{node.id}", ip=client_ip(request))
    db.commit()
    return _serialize_node(node)


@router.delete("/nodes/{node_id}")
def delete_node(node_id: int,
                request: Request,
                _csrf=Depends(require_csrf),
                user: User = Depends(require_cluster),
                db: Session = Depends(get_db)) -> dict:
    """Unlink a remote node. We stop trusting its token immediately."""
    node = db.get(ClusterNode, node_id)
    if node is None:
        raise HTTPException(404, detail="not found")
    db.delete(node)
    record(db, actor=user.username, action="cluster.node_unlinked",
           target=f"node:{node_id}", ip=client_ip(request))
    db.commit()
    return {"status": "deleted"}
