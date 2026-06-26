from __future__ import annotations

import secrets


def new_slug() -> str:
    """A non-enumerable public link slug (~128 bits of entropy)."""
    return secrets.token_urlsafe(16)
