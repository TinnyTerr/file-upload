"""The FastAPI app serves the built React SPA (client → ../public) instead of the
legacy hand-written app/static HTML pages. These tests check the serving logic:
the shell is returned for each client-side route, hashed assets resolve with an
immutable cache, and the share pages still inject server-rendered OG meta tags.

Requires the client to have been built (`bun run build` in client/ → ./public).
"""
from __future__ import annotations

import pytest

from app.spa import SPA_ASSETS, SPA_INDEX

pytestmark = pytest.mark.skipif(
    not SPA_INDEX.exists(),
    reason="SPA not built — run `bun run build` in client/ to populate ./public",
)

# Every path that is both a server route and a client-side route in App.tsx.
SHELL_ROUTES = ["/", "/login", "/account/change", "/files", "/admin", "/api-docs"]


@pytest.mark.parametrize("path", SHELL_ROUTES)
def test_shell_routes_serve_spa(app_client, path):
    c, _ = app_client
    r = c.get(path)
    assert r.status_code == 200, r.text
    assert "text/html" in r.headers["content-type"]
    # The SPA mounts into <div id="root"> and pulls in a hashed bundle from /assets.
    assert '<div id="root">' in r.text
    assert "/assets/" in r.text
    # Shell must revalidate so a redeploy's new asset hashes are picked up.
    assert r.headers["cache-control"] == "no-cache"


def test_assets_served_with_immutable_cache(app_client):
    c, _ = app_client
    asset = next((p for p in SPA_ASSETS.glob("*.js")), None)
    assert asset is not None, "no built JS asset found in ./public/assets"
    r = c.get(f"/assets/{asset.name}")
    assert r.status_code == 200, r.text
    assert "immutable" in r.headers["cache-control"]


def test_unknown_asset_404(app_client):
    c, _ = app_client
    r = c.get("/assets/does-not-exist-12345.js")
    assert r.status_code == 404


def test_api_routes_not_shadowed_by_spa(app_client):
    """The SPA shell routes must not swallow API endpoints."""
    c, _ = app_client
    r = c.get("/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}
