from __future__ import annotations

import io
import os
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.deps import AppState

# Generate dev-mode configs during tests so session cookies aren't Secure-only
# (the TestClient speaks plain HTTP and would otherwise drop them → spurious 401s).
os.environ.setdefault("FILEUPLOAD_DEFAULT_APP_ENV", "dev")


@pytest.fixture
def app_client(tmp_path):
    app = create_app(
        config_path=str(tmp_path / "app.env"),
        database_url="sqlite:///:memory:",
    )
    state: AppState = app.state.app_state
    with TestClient(app) as c:
        yield c, state


@pytest.fixture
def master_session(app_client):
    c, state = app_client
    bootstrap_pw = state.bootstrap_password
    r = c.post("/auth/login", json={"username": "admin", "password": bootstrap_pw})
    assert r.status_code == 200
    csrf1 = r.json()["csrf_token"]
    new_pw = "masterpass1234"
    c.post(
        "/account/change-credentials",
        json={"current_password": bootstrap_pw, "new_username": "admin", "new_password": new_pw},
        headers={"X-CSRF-Token": csrf1},
    )
    r2 = c.post("/auth/login", json={"username": "admin", "password": new_pw})
    assert r2.status_code == 200
    csrf2 = r2.json()["csrf_token"]
    return c, csrf2, new_pw


# ── two-node cluster harness ────────────────────────────────────────────────────
#
# Node-to-node calls go out over real HTTP via app.cluster.http (urllib), which
# can't reach an in-process TestClient. This fixture stands up two independent
# apps (separate in-memory DBs = two real nodes) and reroutes every cluster HTTP
# helper into the matching TestClient by base-URL prefix, so the client-side
# orchestration (replicate_file, rebase_from_master, join_cluster, heartbeat_job,
# sync_check_job, fetch_blob_from_peers) can be driven deterministically in-process.


def _become_admin(client: TestClient, state: AppState) -> str:
    """Log in as the first-run admin and clear must_change_credentials, returning
    a usable CSRF token (uploads need can_upload, which the master role has)."""
    pw = state.bootstrap_password
    r = client.post("/auth/login", json={"username": "admin", "password": pw})
    assert r.status_code == 200, r.text
    csrf = r.json()["csrf_token"]
    new_pw = "clusterpass1234"
    client.post(
        "/account/change-credentials",
        json={"current_password": pw, "new_username": "admin", "new_password": new_pw},
        headers={"X-CSRF-Token": csrf},
    )
    r2 = client.post("/auth/login", json={"username": "admin", "password": new_pw})
    assert r2.status_code == 200, r2.text
    return r2.json()["csrf_token"]


class _PeerNode:
    def __init__(self, app, client: TestClient, url: str):
        self.app = app
        self.client = client
        self.state: AppState = app.state.app_state
        self.settings = self.state.settings
        self.url = url
        self.token = self.state.cluster_token
        self.node_id = self.state.node_id
        self._csrf: str | None = None

    @property
    def session_factory(self):
        return self.state.session_factory

    def csrf(self) -> str:
        if self._csrf is None:
            self._csrf = _become_admin(self.client, self.state)
        return self._csrf

    def upload(self, *, name="repl.bin", body=b"cluster-bytes") -> dict:
        r = self.client.post(
            "/files/upload",
            files={"file": (name, body, "application/octet-stream")},
            data={"original_filename": name, "randomize_filename": "false"},
            headers={"X-CSRF-Token": self.csrf()},
        )
        assert r.status_code == 200, r.text
        return r.json()

    def link(self, other: "_PeerNode", *, is_master: bool) -> None:
        """Register ``other`` as a peer in this node's cluster_nodes table."""
        from app.models.cluster_node import ClusterNode
        with self.session_factory() as s:
            existing = (s.query(ClusterNode)
                        .filter(ClusterNode.node_id == other.node_id).one_or_none())
            if existing is None:
                existing = ClusterNode(node_id=other.node_id)
                s.add(existing)
            existing.name = other.settings.node_name or "peer"
            existing.base_url = other.url
            existing.token = other.token
            existing.is_master = is_master
            existing.active = True
            s.commit()


@pytest.fixture
def cluster_pair(tmp_path, monkeypatch):
    import app.cluster.blobs as blobs_mod
    import app.cluster.digest as digest_mod
    import app.cluster.http as http_mod
    import app.cluster.membership as membership_mod

    appA = create_app(config_path=str(tmp_path / "a.env"),
                      database_url="sqlite:///:memory:")
    appB = create_app(config_path=str(tmp_path / "b.env"),
                      database_url="sqlite:///:memory:")
    urlA, urlB = "http://node-a", "http://node-b"

    with TestClient(appA) as cA, TestClient(appB) as cB:
        a = _PeerNode(appA, cA, urlA)
        b = _PeerNode(appB, cB, urlB)
        # A real node advertises its reachable URL; without it self_payload emits an
        # empty base_url and the join/heartbeat JoinBody (min_length=1) rejects it.
        a.settings.node_url = urlA
        b.settings.node_url = urlB
        # routing table; a test can pop an entry to simulate an unreachable peer.
        routes = {urlA: cA, urlB: cB}

        def _route(url: str):
            for base, client in routes.items():
                if url.startswith(base):
                    return client, url[len(base):]
            raise http_mod.ClusterHTTPError(0, f"no route to {url}")

        def fake_get(url, token, *, timeout=10.0):
            client, path = _route(url)
            r = client.get(path, headers={"Authorization": f"Bearer {token}"})
            if r.status_code >= 400:
                raise http_mod.ClusterHTTPError(r.status_code, r.text)
            return r.json() if r.content else None

        def fake_post(url, token, payload, *, timeout=10.0):
            client, path = _route(url)
            r = client.post(path, json=payload,
                            headers={"Authorization": f"Bearer {token}"})
            if r.status_code >= 400:
                raise http_mod.ClusterHTTPError(r.status_code, r.text)
            return r.json() if r.content else None

        class _Stream:
            def __init__(self, data: bytes):
                self._buf = io.BytesIO(data)

            def read(self, n: int = -1) -> bytes:
                return self._buf.read(n)

            def __enter__(self):
                return self

            def __exit__(self, *exc):
                self._buf.close()
                return False

        def fake_stream(url, token, *, timeout=30.0):
            client, path = _route(url)
            r = client.get(path, headers={"Authorization": f"Bearer {token}"})
            if r.status_code >= 400:
                raise http_mod.ClusterHTTPError(r.status_code)
            return _Stream(r.content)

        # Patch both the source module and every module that imported the helpers
        # at import time (blobs/membership/digest bind them as module globals).
        for mod, names in (
            (http_mod, ("get_json", "post_json", "open_stream")),
            (blobs_mod, ("open_stream",)),
            (membership_mod, ("post_json",)),
            (digest_mod, ("get_json",)),
        ):
            for name, fake in (("get_json", fake_get), ("post_json", fake_post),
                               ("open_stream", fake_stream)):
                if name in names and hasattr(mod, name):
                    monkeypatch.setattr(mod, name, fake)

        yield SimpleNamespace(a=a, b=b, routes=routes)
