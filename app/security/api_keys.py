from __future__ import annotations

import hashlib
import secrets
from datetime import datetime

from app.models.api_key import ApiKey


def generate_key() -> str:
    """A fresh API key, shown to the user exactly once."""
    return secrets.token_urlsafe(32)


def hash_key(plain: str) -> str:
    return hashlib.sha256(plain.encode("utf-8")).hexdigest()


def bind_or_reject(api_key: ApiKey, ip: str, now: datetime) -> bool:
    """Bind the key to its first IP, allow the bound IP, reject others.

    Returns True if the request is permitted (binding on first use), False if
    the IP does not match the bound IP. On rejection nothing is mutated.
    Caller flushes/commits.
    """
    if api_key.bound_ip is None:
        api_key.bound_ip = ip
        api_key.last_used_at = now
        return True
    if api_key.bound_ip == ip:
        api_key.last_used_at = now
        return True
    return False
