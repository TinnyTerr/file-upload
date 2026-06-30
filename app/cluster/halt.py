from __future__ import annotations

import threading
import time
from typing import Any

# Default time-to-live for an upload halt. After this window a halt expires on
# every node automatically, so a transient over-quota/disk spike self-heals
# without an explicit "resume" broadcast.
DEFAULT_HALT_TTL_SECONDS = 300

# Scope constants. A halt is either cluster-wide ("global") or scoped to one user
# ("user:<id>"). The brief: an over-quota upload halts that user first; an
# over-total-disk / global-quota condition halts everyone.
GLOBAL = "global"


def user_scope(user_id: int) -> str:
    return f"user:{user_id}"


class HaltRegistry:
    """Process-wide registry of active upload halts with TTL expiry.

    A singleton like the event bus: producers (upload paths) and the firehose
    consumer both touch the same instance, so a halt raised on any node and
    gossiped over the firehose pauses uploads everywhere until it expires."""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._halts: dict[str, float] = {}  # scope -> expiry epoch seconds

    def reset(self) -> None:
        with self._lock:
            self._halts.clear()

    def set(self, scope: str, until_epoch: float) -> None:
        with self._lock:
            existing = self._halts.get(scope, 0.0)
            # Never shorten an existing halt — keep the furthest-out expiry.
            self._halts[scope] = max(existing, until_epoch)

    def set_ttl(self, scope: str, ttl_seconds: float = DEFAULT_HALT_TTL_SECONDS) -> float:
        until = time.time() + ttl_seconds
        self.set(scope, until)
        return until

    def clear(self, scope: str) -> None:
        with self._lock:
            self._halts.pop(scope, None)

    def active_until(self, user_id: int | None) -> float | None:
        """Return the latest expiry of any halt currently affecting this user
        (global, or their own scope), or None if uploads are allowed."""
        now = time.time()
        with self._lock:
            # Opportunistically prune expired entries.
            expired = [s for s, exp in self._halts.items() if exp <= now]
            for s in expired:
                del self._halts[s]
            candidates = [self._halts.get(GLOBAL, 0.0)]
            if user_id is not None:
                candidates.append(self._halts.get(user_scope(user_id), 0.0))
            best = max(candidates)
        return best if best > now else None

    def snapshot(self) -> dict[str, float]:
        now = time.time()
        with self._lock:
            return {s: exp for s, exp in self._halts.items() if exp > now}


# Process-wide singleton.
halt_registry = HaltRegistry()


def apply_halt_event(event: dict[str, Any]) -> None:
    """Apply an ``upload.halt`` / ``upload.resume`` control event received from a
    peer's firehose to the local registry."""
    scope = event.get("scope")
    if not scope:
        return
    action = event.get("action")
    if action == "upload.resume":
        halt_registry.clear(scope)
        return
    until = event.get("until")
    try:
        halt_registry.set(scope, float(until))
    except (TypeError, ValueError):
        halt_registry.set_ttl(scope)


def broadcast_halt(scope: str, *, ttl_seconds: float = DEFAULT_HALT_TTL_SECONDS,
                   reason: str = "") -> float:
    """Raise a halt locally and gossip it to peers over the firehose. Returns the
    expiry epoch."""
    until = halt_registry.set_ttl(scope, ttl_seconds)
    try:
        from app.observability.events import event_bus
        event_bus.publish(action="upload.halt", actor="system", target=scope,
                          kind="control", scope=scope, until=until, reason=reason)
    except Exception:
        pass
    return until
