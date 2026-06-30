from __future__ import annotations

import os

import uvicorn

from app.main import create_app

# Cluster nodes must be reachable by their peers, so the default bind is all
# interfaces. This is sound because app.deps.client_ip only honours
# X-Forwarded-For when TRUST_PROXY is set (i.e. behind a known proxy); otherwise
# it uses the real socket peer and ignores client-supplied XFF. Set
# FILEUPLOAD_BIND_HOST=127.0.0.1 for a single-node, loopback-only deployment.
HOST = os.environ.get("FILEUPLOAD_BIND_HOST", "0.0.0.0")
PORT = int(os.environ.get("FILEUPLOAD_BIND_PORT", "7474"))

# A node runs as a SINGLE process. The cluster runtime is built on per-process
# singletons — the event bus (its monotonic seq + recent-events buffer that peers
# poll), the upload-halt registry, the firehose consumers and heartbeat job — so
# multiple workers would behave as several independent half-nodes: peers would see
# a fraction of events, halts would apply to only one worker, and every worker's
# seq would collide on the cluster_events unique constraint. Scale horizontally by
# adding NODES, not workers. FILEUPLOAD_WORKERS can override this, but only do so
# for a non-clustered deployment that accepts degraded monitoring.
WORKERS = int(os.environ.get("FILEUPLOAD_WORKERS", "1"))


def main() -> None:
    uvicorn.run("app.main:create_app", host=HOST, port=PORT,
                workers=WORKERS, factory=True)


if __name__ == "__main__":
    main()
