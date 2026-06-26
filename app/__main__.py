from __future__ import annotations

import uvicorn

from app.main import create_app

# Loopback-only bind: the rightmost-X-Forwarded-For trust model in app.deps.client_ip
# is only sound when the app is not directly reachable from the network.
HOST = "127.0.0.1"
PORT = 8000


def main() -> None:
    uvicorn.run(create_app(), host=HOST, port=PORT)


if __name__ == "__main__":
    main()
