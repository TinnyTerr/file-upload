from __future__ import annotations

import logging
import threading
import time
from typing import Any, Callable

from app.cluster.http import ClusterHTTPError, get_json
from app.models.cluster_node import ClusterNode

_log = logging.getLogger("app.cluster.firehose")

# How often the manager re-reads the peer list, and how often a healthy poller
# checks a peer for new events.
_RECONCILE_INTERVAL = 5.0
_POLL_INTERVAL = 1.0
_MAX_BACKOFF = 30.0


class _Poller:
    """One daemon thread tailing a single peer's event firehose over HTTP poll.

    Uses the existing ``GET /admin/cluster/events?after=<cursor>`` endpoint (more
    robust to restarts than an outbound websocket) with the peer's cluster token.
    Each event is delivered live (event_bus.ingest) and queued for durable
    persistence (writer.submit); the cursor is the peer's own monotonic seq.
    """

    def __init__(self, base_url: str, token: str, *,
                 on_event: Callable[[dict[str, Any]], None],
                 on_health: Callable[[bool], None]):
        self.base_url = base_url.rstrip("/")
        self.token = token
        self._on_event = on_event
        self._on_health = on_health
        self._cursor = 0
        self._running = False
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        self._running = True
        self._thread = threading.Thread(
            target=self._run, name=f"cluster-poll-{self.base_url}", daemon=True
        )
        self._thread.start()

    def stop(self) -> None:
        self._running = False

    def _run(self) -> None:
        backoff = _POLL_INTERVAL
        while self._running:
            try:
                url = f"{self.base_url}/admin/cluster/events?after={self._cursor}&limit=500"
                data = get_json(url, self.token, timeout=15.0)
                events = (data or {}).get("events", []) or []
                for ev in events:
                    try:
                        self._on_event(ev)
                    except Exception:
                        _log.exception("failed handling peer event")
                self._cursor = (data or {}).get("last_id", self._cursor)
                self._on_health(True)
                backoff = _POLL_INTERVAL
                time.sleep(_POLL_INTERVAL)
            except ClusterHTTPError as exc:
                self._on_health(False)
                _log.debug("peer %s poll failed: %s", self.base_url, exc)
                time.sleep(backoff)
                backoff = min(backoff * 2, _MAX_BACKOFF)
            except Exception:
                self._on_health(False)
                _log.exception("unexpected poller error for %s", self.base_url)
                time.sleep(backoff)
                backoff = min(backoff * 2, _MAX_BACKOFF)


class ClusterFirehoseConsumer:
    """Keeps one ``_Poller`` per linked peer in sync with the ClusterNode table.

    A single reconcile thread adds pollers for newly-linked peers and stops
    pollers for unlinked ones. Self is excluded by node_id so a node never tails
    its own firehose."""

    def __init__(self, session_factory: Callable[[], Any], local_node_id: str,
                 *, on_event: Callable[[dict[str, Any]], None]):
        self._session_factory = session_factory
        self._local_node_id = local_node_id
        self._on_event = on_event
        self._pollers: dict[str, _Poller] = {}
        self._running = False
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        if self._thread is not None:
            return
        self._running = True
        self._thread = threading.Thread(
            target=self._reconcile_loop, name="cluster-firehose-mgr", daemon=True
        )
        self._thread.start()

    def stop(self) -> None:
        self._running = False
        for poller in list(self._pollers.values()):
            poller.stop()
        self._pollers.clear()
        if self._thread is not None:
            self._thread.join(timeout=2.0)
            self._thread = None

    def _reconcile_loop(self) -> None:
        while self._running:
            try:
                self._reconcile_once()
            except Exception:
                _log.exception("firehose reconcile failed")
            time.sleep(_RECONCILE_INTERVAL)

    def _reconcile_once(self) -> None:
        session = self._session_factory()
        try:
            nodes = session.query(ClusterNode).filter(ClusterNode.active == True).all()  # noqa: E712
            desired: dict[str, tuple[str, str]] = {}
            for n in nodes:
                # Skip self (a node linked to its own master, etc.) and rows
                # without the credentials needed to poll.
                if n.node_id and n.node_id == self._local_node_id:
                    continue
                if not n.base_url or not n.token:
                    continue
                desired[n.base_url.rstrip("/")] = (n.token, n.node_id or n.base_url)
        finally:
            session.close()

        # Stop pollers for peers no longer present.
        for key in list(self._pollers):
            if key not in desired:
                self._pollers.pop(key).stop()
        # Start pollers for new peers.
        for base_url, (token, _node_key) in desired.items():
            existing = self._pollers.get(base_url)
            if existing is not None:
                if existing.token == token:
                    continue
                existing.stop()  # token rotated — restart with the new one
            poller = _Poller(
                base_url, token,
                on_event=self._on_event,
                on_health=lambda ok, b=base_url: self._note_health(b, ok),
            )
            self._pollers[base_url] = poller
            poller.start()
            _log.info("started firehose poller for peer %s", base_url)

    def _note_health(self, base_url: str, ok: bool) -> None:
        # Heartbeat/disk stats are maintained by the ping job; health here is a
        # cheap liveness signal we deliberately don't write per-poll to avoid
        # SQLite churn. Reserved for future surfacing.
        return
