from __future__ import annotations

import asyncio
import threading
from collections import deque
from datetime import datetime, timezone
from typing import Any, Callable

# Recent events are retained so a freshly-connected websocket (or a polling
# cluster node) can replay what it missed instead of starting blind.
_MAX_RECENT = 1000


def _utcnow_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class _Subscriber:
    """A single connected consumer: an asyncio queue plus a predicate that
    decides which events it should receive."""

    __slots__ = ("queue", "predicate")

    def __init__(self, queue: "asyncio.Queue[dict[str, Any]]",
                 predicate: Callable[[dict[str, Any]], bool]):
        self.queue = queue
        self.predicate = predicate


class EventBus:
    """Process-wide pub/sub hub bridging synchronous producers (request
    handlers, scheduler jobs) to asynchronous websocket consumers.

    ``publish`` is safe to call from any thread. Delivery to subscribers is
    marshalled onto the bound asyncio loop via ``call_soon_threadsafe`` so the
    asyncio.Queues are only ever touched from the loop thread.
    """

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._subscribers: set[_Subscriber] = set()
        self._recent: deque[dict[str, Any]] = deque(maxlen=_MAX_RECENT)
        self._loop: asyncio.AbstractEventLoop | None = None
        self._seq = 0

    def bind_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        with self._lock:
            self._loop = loop

    def reset(self) -> None:
        """Drop all state — used between test app instances in one process."""
        with self._lock:
            self._subscribers.clear()
            self._recent.clear()
            self._loop = None
            self._seq = 0

    # ── producing ────────────────────────────────────────────────────────────

    def publish(self, action: str, actor: str, target: str | None = None,
                ip: str | None = None, **extra: Any) -> dict[str, Any]:
        with self._lock:
            self._seq += 1
            event = {
                "id": self._seq,
                "ts": _utcnow_iso(),
                "action": action,
                "actor": actor,
                "target": target,
                "ip": ip,
            }
            if extra:
                event.update(extra)
            self._recent.append(event)
            subscribers = list(self._subscribers)
            loop = self._loop

        if loop is None:
            return event

        for sub in subscribers:
            try:
                if not sub.predicate(event):
                    continue
            except Exception:
                continue
            # Hop onto the loop thread to mutate the queue. If the consumer has
            # fallen behind and the queue is full, drop the event for that
            # consumer rather than blocking the producer (monitoring is
            # best-effort; the recent-events replay covers brief gaps).
            loop.call_soon_threadsafe(self._safe_put, sub.queue, event)
        return event

    @staticmethod
    def _safe_put(queue: "asyncio.Queue[dict[str, Any]]", event: dict[str, Any]) -> None:
        try:
            queue.put_nowait(event)
        except asyncio.QueueFull:
            pass

    # ── consuming ────────────────────────────────────────────────────────────

    def subscribe(self, predicate: Callable[[dict[str, Any]], bool],
                  *, maxsize: int = 1000) -> "asyncio.Queue[dict[str, Any]]":
        queue: "asyncio.Queue[dict[str, Any]]" = asyncio.Queue(maxsize=maxsize)
        sub = _Subscriber(queue, predicate)
        with self._lock:
            self._subscribers.add(sub)
        queue._fu_subscriber = sub  # type: ignore[attr-defined]
        return queue

    def unsubscribe(self, queue: "asyncio.Queue[dict[str, Any]]") -> None:
        sub = getattr(queue, "_fu_subscriber", None)
        if sub is None:
            return
        with self._lock:
            self._subscribers.discard(sub)

    def recent(self, *, predicate: Callable[[dict[str, Any]], bool] | None = None,
               after_id: int = 0, limit: int = 200) -> list[dict[str, Any]]:
        with self._lock:
            snapshot = list(self._recent)
        out = [e for e in snapshot if e["id"] > after_id]
        if predicate is not None:
            out = [e for e in out if predicate(e)]
        return out[-limit:]

    @property
    def subscriber_count(self) -> int:
        with self._lock:
            return len(self._subscribers)


# Process-wide singleton.
event_bus = EventBus()
