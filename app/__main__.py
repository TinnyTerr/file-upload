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


def main() -> None:
    uvicorn.run("app.main:create_app", host=HOST, port=PORT, workers=4, factory=True)


if __name__ == "__main__":
    main()
