from __future__ import annotations

import logging
import shutil
from datetime import datetime, timezone
from typing import Any, Callable

from app.cluster.http import ClusterHTTPError, post_json
from app.config import Settings
from app.models.cluster_node import ClusterNode
from app.storage.accounting import used_storage_bytes
from app.storage.paths import storage_root

_log = logging.getLogger("app.cluster.membership")


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def self_payload(settings: Settings, session_factory: Callable[[], Any]) -> dict:
    """The identity + capacity this node advertises to peers."""
    try:
        usage = shutil.disk_usage(storage_root())
        disk_total, disk_free = usage.total, usage.free
    except OSError:
        disk_total = disk_free = 0
    with session_factory() as s:
        used = used_storage_bytes(s)
    return {
        "node_id": settings.node_id,
        "name": settings.node_name,
        "base_url": settings.node_url,
        "token": settings.cluster_token,
        "is_master": settings.node_role == "master",
        "archive_enabled": settings.archive_enabled,
        "replication_mode": settings.replication_mode,
        "disk_total_bytes": disk_total,
        "disk_free_bytes": disk_free,
        "used_bytes": used,
    }


def _link_locally(session_factory: Callable[[], Any], *, node_id: str, name: str,
                  base_url: str, token: str, is_master: bool,
                  archive_enabled: bool = True, replication_mode: str = "full") -> None:
    if not node_id or not base_url:
        return
    base_url = base_url.rstrip("/")
    with session_factory() as s:
        node = s.query(ClusterNode).filter(ClusterNode.node_id == node_id).one_or_none()
        if node is None:
            node = ClusterNode(node_id=node_id, name=name, base_url=base_url, token=token)
            s.add(node)
        node.name = name or node.name
        node.base_url = base_url
        if token:
            node.token = token
        node.is_master = is_master
        node.archive_enabled = archive_enabled
        node.replication_mode = replication_mode or "full"
        node.active = True
        node.last_seen_at = _utcnow()
        s.commit()


def join_cluster(settings: Settings, session_factory: Callable[[], Any]) -> None:
    """Bootstrap this (non-master) node into the mesh.

    Joins the master, links every returned peer locally, then joins each of them
    directly so the membership is symmetric (full mesh). Safe to run repeatedly —
    every registration is an idempotent upsert keyed by node_id. Intended to run
    on a background thread so a slow/unreachable master never blocks startup."""
    if settings.node_role == "master":
        return
    if not settings.master_url or not settings.master_token:
        _log.warning("node has no MASTER_URL/MASTER_TOKEN; not joining a cluster")
        return
    if not settings.node_url:
        _log.warning("node has no NODE_URL to advertise; not joining a cluster")
        return

    payload = self_payload(settings, session_factory)
    try:
        result = post_json(
            f"{settings.master_url}/cluster/join", settings.master_token, payload,
            timeout=15.0,
        )
    except ClusterHTTPError as exc:
        _log.warning("failed to join master at %s: %s", settings.master_url, exc)
        return

    master_self = (result or {}).get("self", {})
    _link_locally(
        session_factory,
        node_id=master_self.get("node_id", ""),
        name=master_self.get("name", "master"),
        base_url=settings.master_url,
        token=settings.master_token,
        is_master=True,
        archive_enabled=master_self.get("archive_enabled", True),
        replication_mode=master_self.get("replication_mode", "full"),
    )

    for peer in (result or {}).get("peers", []) or []:
        _link_locally(
            session_factory,
            node_id=peer.get("node_id", ""),
            name=peer.get("name", ""),
            base_url=peer.get("base_url", ""),
            token=peer.get("token", ""),
            is_master=peer.get("is_master", False),
            archive_enabled=peer.get("archive_enabled", True),
            replication_mode=peer.get("replication_mode", "full"),
        )
        # Register ourselves with the peer too, so the mesh is symmetric.
        if peer.get("base_url") and peer.get("token"):
            try:
                post_json(f"{peer['base_url'].rstrip('/')}/cluster/join",
                          peer["token"], payload, timeout=10.0)
            except ClusterHTTPError as exc:
                _log.debug("could not register with peer %s: %s",
                           peer.get("base_url"), exc)
    _log.info("joined cluster via master %s", settings.master_url)

    # Rebase onto the master so this node starts with the cluster's canonical
    # users/files/links/etc. (the source-of-truth snapshot).
    try:
        from app.cluster.replication import rebase_from_master
        rebase_from_master(settings, session_factory)
    except Exception:
        _log.warning("initial rebase from master failed", exc_info=True)


def heartbeat_job(settings: Settings, session_factory: Callable[[], Any]) -> int:
    """Ping every linked peer, refreshing its capacity stats and our liveness with
    it. Peers that fail to respond are marked stale (active=False) rather than
    deleted, so a transient outage doesn't tear down the mesh. Returns the number
    of peers successfully reached."""
    payload = self_payload(settings, session_factory)
    with session_factory() as s:
        peers = s.query(ClusterNode).all()
        targets = [(n.id, n.base_url, n.token) for n in peers if n.base_url and n.token]

    reached = 0
    for node_id, base_url, token in targets:
        try:
            stats = post_json(f"{base_url.rstrip('/')}/cluster/heartbeat", token,
                              payload, timeout=10.0)
            reached += 1
        except ClusterHTTPError:
            stats = None
        with session_factory() as s:
            node = s.get(ClusterNode, node_id)
            if node is None:
                continue
            if stats is None:
                node.active = False
            else:
                node.active = True
                node.last_heartbeat_at = _utcnow()
                node.last_seen_at = _utcnow()
                node.disk_total_bytes = stats.get("disk_total_bytes", 0)
                node.disk_free_bytes = stats.get("disk_free_bytes", 0)
                node.used_bytes = stats.get("used_bytes", 0)
                node.archive_enabled = stats.get("archive_enabled", node.archive_enabled)
                node.replication_mode = stats.get("replication_mode", node.replication_mode)
                node.is_master = stats.get("is_master", node.is_master)
            s.commit()
    return reached
