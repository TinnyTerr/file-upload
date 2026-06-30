from __future__ import annotations

import logging
import shutil
from pathlib import Path
from typing import Any, Callable

from app.cluster.http import ClusterHTTPError, open_stream
from app.models.cluster_node import ClusterNode

_log = logging.getLogger("app.cluster.blobs")

_CHUNK = 1024 * 256


def fetch_blob_from_peers(session_factory: Callable[[], Any], *,
                          stored_sha256: str, transform_key: str,
                          dest: Path) -> bool:
    """Try each active peer in turn for a content-addressed blob, streaming the
    first hit to ``dest``. Returns True on success.

    Iterating peers (rather than consulting a location registry) keeps failover
    simple and correct for a small cluster: any peer that still holds the bytes
    can serve them, so a single downed node never makes a fully-replicated file
    unavailable. Skips peers whose heartbeat marks them inactive."""
    with session_factory() as s:
        peers = [
            (n.base_url, n.token)
            for n in s.query(ClusterNode).filter(ClusterNode.active == True).all()  # noqa: E712
            if n.base_url and n.token
        ]

    dest.parent.mkdir(parents=True, exist_ok=True)
    for base_url, token in peers:
        url = (f"{base_url.rstrip('/')}/cluster/blobs/{stored_sha256}"
               f"?transform={transform_key}")
        try:
            resp = open_stream(url, token, timeout=30.0)
        except ClusterHTTPError:
            continue
        tmp = dest.with_suffix(dest.suffix + ".peer.tmp")
        try:
            with resp, open(tmp, "wb") as out:
                while True:
                    chunk = resp.read(_CHUNK)
                    if not chunk:
                        break
                    out.write(chunk)
            tmp.replace(dest)
            _log.info("fetched blob %s from peer %s", stored_sha256[:12], base_url)
            return True
        except Exception:
            tmp.unlink(missing_ok=True)
            _log.warning("failed streaming blob %s from %s", stored_sha256[:12], base_url)
            continue
    return False
