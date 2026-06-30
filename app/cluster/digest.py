from __future__ import annotations

import hashlib
import json
import logging
from typing import Any, Callable

from app.cluster.http import ClusterHTTPError, get_json
from app.config import Settings
from app.models.cluster_node import ClusterNode

_log = logging.getLogger("app.cluster.digest")


def compute_digest(session_factory: Callable[[], Any], settings: Settings) -> dict[str, Any]:
    """A small, comparable summary of state that SHOULD be identical on every node.

    Today that means the shared global storage cap and the membership set (in a
    full mesh every node should know the same node_ids). Counts that legitimately
    differ per-node (each node's own files) are deliberately excluded until the
    metadata-replication layer (subsystem D) makes them comparable; adding them
    here before then would produce permanent false "mismatch" alerts.
    """
    from app.storage.accounting import ensure_storage_settings

    with session_factory() as s:
        storage = ensure_storage_settings(s)
        global_quota = int(storage.global_storage_quota_bytes)
        peer_ids = [
            n.node_id for n in
            s.query(ClusterNode).filter(ClusterNode.active == True).all()  # noqa: E712
            if n.node_id
        ]
    members = sorted({settings.node_id, *peer_ids})
    body = {"global_quota": global_quota, "members": members}
    digest_hash = hashlib.sha256(
        json.dumps(body, sort_keys=True).encode("utf-8")
    ).hexdigest()
    return {"hash": digest_hash, **body}


def sync_check_job(session_factory: Callable[[], Any], settings: Settings) -> int:
    """Compare this node's digest against every peer's and alert on divergence.

    Emits a ``cluster.sync_mismatch`` event (visible in the cluster-wide log) and
    a WARNING for each disagreeing peer. Returns the number of mismatches found."""
    local = compute_digest(session_factory, settings)
    with session_factory() as s:
        targets = [
            (n.node_id, n.base_url, n.token)
            for n in s.query(ClusterNode).filter(ClusterNode.active == True).all()  # noqa: E712
            if n.base_url and n.token
        ]

    mismatches = 0
    for node_id, base_url, token in targets:
        try:
            remote = get_json(f"{base_url.rstrip('/')}/cluster/digest", token, timeout=10.0)
        except ClusterHTTPError as exc:
            _log.debug("digest fetch failed for %s: %s", base_url, exc)
            continue
        if not remote or remote.get("hash") != local["hash"]:
            mismatches += 1
            _log.warning(
                "cluster sync mismatch with node=%s local=%s remote=%s",
                node_id, local, remote,
            )
            try:
                from app.observability.events import event_bus
                event_bus.publish(
                    action="cluster.sync_mismatch", actor="system",
                    target=f"node:{node_id}", kind="system",
                    local_hash=local["hash"],
                    remote_hash=(remote or {}).get("hash"),
                )
            except Exception:
                pass
    return mismatches
