from __future__ import annotations

from pathlib import Path

# The Vite build output (client/ builds to ../public — see client/build.ts).
# This directory is gitignored: the client must be built (`bun run build`) before
# the server can serve it. We read index.html on each request rather than caching
# so a rebuild is picked up without restarting the server.
SPA_DIR = Path(__file__).parent.parent / "public"
SPA_INDEX = SPA_DIR / "index.html"
SPA_ASSETS = SPA_DIR / "assets"


def render_spa(meta: str = "") -> str:
    """Return the built SPA shell, optionally injecting server-rendered meta tags
    into <head> (used by the share pages so link unfurlers, which don't run JS,
    still see OpenGraph tags).

    Raises FileNotFoundError if the client hasn't been built — surfacing that
    loudly is better than serving a blank page.
    """
    html = SPA_INDEX.read_text("utf-8")
    if meta:
        html = html.replace("</head>", meta + "\n</head>")
    return html
