from __future__ import annotations

import logging
import queue
import threading
from datetime import datetime, timezone
from typing import Any, Callable

from sqlalchemy import insert

from app.models.cluster_event import ClusterEvent

_log = logging.getLogger("app.cluster.events")

# Sentinel pushed onto the queue to wake the writer for shutdown.
_STOP = object()


def _parse_ts(value: Any) -> datetime:
    if isinstance(value, datetime):
        return value
    try:
        return datetime.fromisoformat(str(value))
    except (TypeError, ValueError):
        return datetime.now(timezone.utc)


def row_from_event(event: dict[str, Any]) -> dict[str, Any] | None:
    """Map a firehose event dict to ClusterEvent column values, or None if it
    lacks the origin identity needed to dedup it."""
    origin = event.get("node_id")
    seq = event.get("id")
    if not origin or seq is None:
        return None
    return {
        "origin_node_id": str(origin),
        "origin_seq": int(seq),
        "origin_node_name": event.get("node_name"),
        "ts": _parse_ts(event.get("ts")),
        "kind": event.get("kind") or "audit",
        "action": event.get("action") or "",
        "actor": event.get("actor") or "",
        "target": event.get("target"),
        "ip": event.get("ip"),
    }


class ClusterEventWriter:
    """Serialises all cluster-event persistence onto one background thread with a
    single DB connection.

    Both the local event-bus sink and the peer firehose consumers funnel events
    here. Centralising writes avoids the SQLite multi-writer contention we'd hit
    if every request thread opened its own connection to persist its own events,
    and lets us batch-drain bursts. Inserts use OR IGNORE against the
    ``(origin_node_id, origin_seq)`` unique constraint so duplicates (re-polls,
    cross-delivery) are dropped cheaply.
    """

    def __init__(self, session_factory: Callable[[], Any], *, maxsize: int = 10000):
        self._session_factory = session_factory
        self._queue: "queue.Queue[Any]" = queue.Queue(maxsize=maxsize)
        self._thread: threading.Thread | None = None
        self._running = False

    def start(self) -> None:
        if self._thread is not None:
            return
        self._running = True
        self._thread = threading.Thread(
            target=self._run, name="cluster-event-writer", daemon=True
        )
        self._thread.start()

    def stop(self) -> None:
        if self._thread is None:
            return
        self._running = False
        try:
            self._queue.put_nowait(_STOP)
        except queue.Full:
            pass
        self._thread.join(timeout=2.0)
        self._thread = None

    def submit(self, event: dict[str, Any]) -> None:
        """Enqueue an event for persistence. Best-effort: if the queue is full
        (writer stalled), drop rather than block the producing request."""
        row = row_from_event(event)
        if row is None:
            return
        try:
            self._queue.put_nowait(row)
        except queue.Full:
            _log.warning("cluster event queue full; dropping event")

    # ── writer thread ──────────────────────────────────────────────────────────

    def _run(self) -> None:
        while self._running or not self._queue.empty():
            try:
                item = self._queue.get(timeout=0.5)
            except queue.Empty:
                continue
            if item is _STOP:
                break
            batch = [item]
            # Opportunistically drain a burst so we amortise the transaction.
            while len(batch) < 500:
                try:
                    nxt = self._queue.get_nowait()
                except queue.Empty:
                    break
                if nxt is _STOP:
                    self._running = False
                    break
                batch.append(nxt)
            self._write_batch(batch)

    def _write_batch(self, rows: list[dict[str, Any]]) -> None:
        try:
            session = self._session_factory()
        except Exception:
            _log.exception("cluster event writer could not open a session")
            return
        try:
            # OR IGNORE: skip rows that collide on (origin_node_id, origin_seq).
            stmt = insert(ClusterEvent).prefix_with("OR IGNORE")
            session.execute(stmt, rows)
            session.commit()
        except Exception:
            session.rollback()
            _log.exception("cluster event batch write failed (%d rows)", len(rows))
        finally:
            session.close()
