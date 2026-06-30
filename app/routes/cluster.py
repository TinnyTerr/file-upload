from __future__ import annotations

import secrets
import shutil
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from fastapi.responses import FileResponse

from app.audit.log import record
from app.cluster import http as cluster_http
from app.cluster.http import ClusterHTTPError
from app.config import set_env_value
from app.deps import AppState, client_ip, get_db, get_state, require_permission
from app.models.cluster_node import ClusterNode
from app.models.content_blob import ContentBlob
from app.models.user import User
from app.routes.ws import require_cluster_token
from app.security.csrf import require_csrf
from app.storage.accounting import used_storage_bytes
from app.storage.paths import safe_join, storage_root

router = APIRouter(prefix="/cluster", tags=["cluster"])


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _self_stats(state: AppState, db: Session) -> dict:
    """This node's identity + live capacity, shared with peers on join/heartbeat."""
    try:
        usage = shutil.disk_usage(storage_root())
        disk_total, disk_free = usage.total, usage.free
    except OSError:
        disk_total = disk_free = 0
    return {
        "node_id": state.settings.node_id,
        "name": state.settings.node_name,
        "is_master": state.settings.node_role == "master",
        "archive_enabled": state.settings.archive_enabled,
        "replication_mode": state.settings.replication_mode,
        "disk_total_bytes": disk_total,
        "disk_free_bytes": disk_free,
        "used_bytes": used_storage_bytes(db),
    }


def _upsert_peer(db: Session, *, node_id: str, name: str, base_url: str,
                 token: str, is_master: bool, archive_enabled: bool,
                 replication_mode: str, disk_total_bytes: int = 0,
                 disk_free_bytes: int = 0, used_bytes: int = 0) -> ClusterNode:
    """Insert or update a linked-peer row keyed by its stable node_id. Used by the
    join handshake and heartbeats so re-joining a node never duplicates it."""
    base_url = base_url.strip().rstrip("/")
    node = db.query(ClusterNode).filter(ClusterNode.node_id == node_id).one_or_none()
    if node is None:
        node = ClusterNode(node_id=node_id, name=name, base_url=base_url, token=token)
        db.add(node)
    node.name = name or node.name
    if base_url:
        node.base_url = base_url
    if token:
        node.token = token
    node.is_master = is_master
    node.archive_enabled = archive_enabled
    node.replication_mode = replication_mode or "full"
    node.disk_total_bytes = disk_total_bytes
    node.disk_free_bytes = disk_free_bytes
    node.used_bytes = used_bytes
    node.active = True
    node.last_seen_at = _utcnow()
    node.last_heartbeat_at = _utcnow()
    db.flush()
    return node

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
        "node_id": node.node_id,
        "name": node.name,
        "base_url": node.base_url,
        "token_preview": _mask(node.token),
        "active": node.active,
        "is_master": node.is_master,
        "archive_enabled": node.archive_enabled,
        "replication_mode": node.replication_mode,
        "disk_total_bytes": node.disk_total_bytes,
        "disk_free_bytes": node.disk_free_bytes,
        "used_bytes": node.used_bytes,
        "created_at": node.created_at.isoformat() if node.created_at else None,
        "last_seen_at": node.last_seen_at.isoformat() if node.last_seen_at else None,
        "last_heartbeat_at": node.last_heartbeat_at.isoformat() if node.last_heartbeat_at else None,
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


@router.get("/self")
def cluster_self(_user: User = Depends(require_cluster),
                 state: AppState = Depends(get_state),
                 db: Session = Depends(get_db)) -> dict:
    """This node's own identity, capacity and active upload halts — for the
    cluster dashboard's 'this server' panel."""
    from app.cluster.halt import halt_registry

    stats = _self_stats(state, db)
    halts = [
        {"scope": scope, "until": until}
        for scope, until in halt_registry.snapshot().items()
    ]
    return {
        **stats,
        "role": state.settings.node_role,
        "node_url": state.settings.node_url,
        "halts": halts,
    }


@router.get("/nodes")
def list_nodes(_user: User = Depends(require_cluster),
               db: Session = Depends(get_db)) -> dict:
    """List the remote nodes this server is linked to. Tokens are masked."""
    nodes = db.query(ClusterNode).order_by(ClusterNode.created_at).all()
    return {"nodes": [_serialize_node(n) for n in nodes]}


def _trigger_enroll(state: AppState, *, base_url: str, token: str) -> dict:
    """Command a freshly-linked node to enroll: join this master and rebase onto
    it. Authenticated by the node's own cluster token (which the admin supplied
    when linking). Best-effort — a node that is unreachable or rejects the
    command is reported in the response, never raised, so linking still succeeds.

    Only a master issues this: enrolling makes the target treat THIS server as its
    source of truth, which is only meaningful from the master."""
    if state.settings.node_role != "master":
        return {"status": "skipped", "reason": "this server is not a master"}
    if not state.settings.node_url:
        return {"status": "skipped", "reason": "master has no NODE_URL to advertise"}
    try:
        res = cluster_http.post_json(
            f"{base_url}/cluster/enroll", token,
            {"master_url": state.settings.node_url,
             "master_token": state.cluster_token},
            timeout=20.0,
        )
        return res or {"status": "ok"}
    except ClusterHTTPError as exc:
        return {"status": "error", "reason": str(exc)}


@router.post("/nodes")
def create_node(body: CreateNodeBody,
                request: Request,
                _csrf=Depends(require_csrf),
                user: User = Depends(require_cluster),
                state: AppState = Depends(get_state),
                db: Session = Depends(get_db)) -> dict:
    """Link this server to a remote node by supplying its base URL and cluster
    token (passing the other server's token).

    If this server is a master, it then commands the node to enroll — join this
    master and rebase onto its canonical state — so one link fully provisions the
    node. The enroll outcome is returned under ``enroll``."""
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
    # Commit the link BEFORE commanding the node, so we hold no write transaction
    # while the node calls back into /join and /export (avoids SQLite lock
    # contention against our own open transaction).
    db.commit()

    enroll = _trigger_enroll(state, base_url=node.base_url, token=node.token)
    result = _serialize_node(node)
    result["enroll"] = enroll
    return result


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


# ── node-to-node membership handshake (cluster-token auth) ─────────────────────


class JoinBody(BaseModel):
    node_id: str = Field(..., min_length=1, max_length=64)
    name: str = Field(..., min_length=1, max_length=255)
    base_url: str = Field(..., min_length=1, max_length=512)
    token: str = Field(..., min_length=1, max_length=512)
    is_master: bool = False
    archive_enabled: bool = True
    replication_mode: str = "full"
    disk_total_bytes: int = 0
    disk_free_bytes: int = 0
    used_bytes: int = 0


@router.post("/join")
def join(body: JoinBody, request: Request,
         state: AppState = Depends(require_cluster_token),
         db: Session = Depends(get_db)) -> dict:
    """Register a peer into this node's membership and return the current peer
    list + this node's identity so the joiner can complete a full mesh.

    Authenticated by the cluster token (the joiner was handed this node's token).
    The returned peers include their tokens so the joiner can tail their
    firehoses — acceptable within the shared-token trust model of a cluster."""
    peer = _upsert_peer(
        db, node_id=body.node_id, name=body.name, base_url=body.base_url,
        token=body.token, is_master=body.is_master,
        archive_enabled=body.archive_enabled, replication_mode=body.replication_mode,
        disk_total_bytes=body.disk_total_bytes, disk_free_bytes=body.disk_free_bytes,
        used_bytes=body.used_bytes,
    )
    record(db, actor=f"node:{body.node_id}", action="cluster.node_joined",
           target=f"node:{peer.id}", ip=client_ip(request))
    db.commit()

    others = (
        db.query(ClusterNode)
        .filter(ClusterNode.active == True)  # noqa: E712
        .filter(ClusterNode.node_id != body.node_id)
        .all()
    )
    peers = [
        {
            "node_id": n.node_id,
            "name": n.name,
            "base_url": n.base_url,
            "token": n.token,
            "is_master": n.is_master,
            "archive_enabled": n.archive_enabled,
            "replication_mode": n.replication_mode,
        }
        for n in others
        if n.node_id  # only fully-identified peers are mesh-routable
    ]
    return {"self": _self_stats(state, db), "peers": peers}


class EnrollBody(BaseModel):
    master_url: str = Field(..., min_length=1, max_length=512)
    master_token: str = Field(..., min_length=1, max_length=512)


@router.post("/enroll")
def enroll(body: EnrollBody,
           state: AppState = Depends(require_cluster_token)) -> dict:
    """Master-initiated enrollment: a master commands THIS node to join it and
    rebase onto its canonical state.

    Authenticated by this node's own cluster token (the master holds it from the
    link step). The master passes its own URL + token in the body so this node can
    call back into the master's /join and /export. Mirrors the config-driven
    auto-join, but driven by the supplied coordinates instead of local env."""
    from app.cluster.membership import enroll_with_master

    return enroll_with_master(
        state.settings, state.session_factory, body.master_url, body.master_token,
    )


@router.post("/heartbeat")
def heartbeat(body: JoinBody, request: Request,
              state: AppState = Depends(require_cluster_token),
              db: Session = Depends(get_db)) -> dict:
    """Refresh a peer's liveness + capacity stats and return ours. Called
    periodically by every node against each peer."""
    _upsert_peer(
        db, node_id=body.node_id, name=body.name, base_url=body.base_url,
        token=body.token, is_master=body.is_master,
        archive_enabled=body.archive_enabled, replication_mode=body.replication_mode,
        disk_total_bytes=body.disk_total_bytes, disk_free_bytes=body.disk_free_bytes,
        used_bytes=body.used_bytes,
    )
    db.commit()
    return _self_stats(state, db)


@router.get("/ping")
def ping(state: AppState = Depends(require_cluster_token),
         db: Session = Depends(get_db)) -> dict:
    """Lightweight liveness + capacity probe (no body), for failover checks."""
    return _self_stats(state, db)


@router.get("/blobs/{stored_sha256}")
def get_blob(stored_sha256: str, request: Request,
             transform: str | None = None,
             _state: AppState = Depends(require_cluster_token),
             db: Session = Depends(get_db)):
    """Stream a blob's raw STORED bytes to a peer, addressed by its content hash.

    Blobs are content-addressed (``stored_sha256`` + ``transform_key``), so this
    transfers the exact stored form — the receiver writes it verbatim and serves
    it through the file's own metadata (decompress/decrypt) just as we would.
    Powers cross-node replication pulls and download fetch-on-miss/failover."""
    q = db.query(ContentBlob).filter(ContentBlob.stored_sha256 == stored_sha256)
    if transform:
        q = q.filter(ContentBlob.transform_key == transform)
    blob = q.first()
    if blob is None:
        raise HTTPException(404, detail="blob not found")
    path = safe_join(storage_root(), blob.storage_path)
    if not path.exists():
        raise HTTPException(404, detail="blob bytes missing on this node")
    return FileResponse(
        str(path), media_type="application/octet-stream",
        headers={
            "X-Blob-Transform": blob.transform_key,
            "X-Blob-Stored-Sha256": blob.stored_sha256,
            "X-Blob-Storage-Path": blob.storage_path,
        },
    )


@router.get("/digest")
def digest(request: Request,
           state: AppState = Depends(require_cluster_token)) -> dict:
    """Comparable summary of shared cluster state, polled by peers' sync-check
    job to detect divergence (membership / global cap)."""
    from app.cluster.digest import compute_digest
    sf = request.app.state.app_state.session_factory
    return compute_digest(sf, state.settings)


# ── row metadata replication (announce-id protocol) ────────────────────────────


class ReserveBody(BaseModel):
    table: str = Field(..., min_length=1, max_length=64)
    id: int
    identity: str = Field(..., min_length=1, max_length=128)


@router.post("/reserve")
def reserve_id(body: ReserveBody,
               _state: AppState = Depends(require_cluster_token),
               db: Session = Depends(get_db)) -> dict:
    """Announce step of the replication protocol: is (table, id) free here, or
    already the SAME row? ``ok`` is False only when this node holds a DIFFERENT
    row at that id — the conflict that makes the announcing node rebase."""
    from app.cluster.replication import local_identity

    existing = local_identity(db, body.table, body.id)
    ok = existing is None or existing == body.identity
    return {"ok": ok, "conflict": not ok}


class ReplicateBody(BaseModel):
    rows: list[dict] = Field(default_factory=list)


@router.post("/replicate")
def replicate_rows(body: ReplicateBody,
                   _state: AppState = Depends(require_cluster_token),
                   db: Session = Depends(get_db)) -> dict:
    """Apply replicated rows (upsert by primary key, parents before children)."""
    from app.cluster.replication import apply_rows

    applied = apply_rows(db, body.rows)
    db.commit()
    return {"applied": applied}


@router.get("/export")
def export_state(_state: AppState = Depends(require_cluster_token),
                 db: Session = Depends(get_db)) -> dict:
    """Full canonical snapshot of replicated tables — a joining or diverged node
    rebases onto this (master is the source of truth)."""
    from app.cluster.replication import export_all

    return {"rows": export_all(db)}
