from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import Any

# Node-to-node HTTP uses the stdlib (like app.routes.remote_upload) so the
# cluster runtime adds no new third-party dependency. These calls always target
# operator-configured peer base URLs authenticated by the shared cluster token —
# they are not user-controlled URLs, so the SSRF pinning that remote_upload needs
# does not apply here.


class ClusterHTTPError(Exception):
    def __init__(self, status: int, body: str = ""):
        super().__init__(f"cluster http {status}: {body[:200]}")
        self.status = status
        self.body = body


def _request(method: str, url: str, token: str, *,
             payload: dict[str, Any] | None = None,
             timeout: float = 10.0) -> Any:
    data = None
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        detail = ""
        try:
            detail = exc.read().decode("utf-8")
        except Exception:
            pass
        raise ClusterHTTPError(exc.code, detail) from exc
    except urllib.error.URLError as exc:
        raise ClusterHTTPError(0, str(exc.reason)) from exc
    if not body:
        return None
    return json.loads(body)


def get_json(url: str, token: str, *, timeout: float = 10.0) -> Any:
    return _request("GET", url, token, timeout=timeout)


def post_json(url: str, token: str, payload: dict[str, Any], *,
              timeout: float = 10.0) -> Any:
    return _request("POST", url, token, payload=payload, timeout=timeout)


def open_stream(url: str, token: str, *, timeout: float = 30.0):
    """Open a raw streaming GET (for node-to-node blob transfer). Caller must
    close the returned response. Raises ClusterHTTPError on non-2xx."""
    req = urllib.request.Request(
        url, headers={"Authorization": f"Bearer {token}"}, method="GET"
    )
    try:
        return urllib.request.urlopen(req, timeout=timeout)
    except urllib.error.HTTPError as exc:
        raise ClusterHTTPError(exc.code) from exc
    except urllib.error.URLError as exc:
        raise ClusterHTTPError(0, str(exc.reason)) from exc
