from __future__ import annotations

import logging
import threading
from collections import deque
from datetime import datetime, timezone
from typing import Any

_MAX_ENTRIES = 2000
_lock = threading.RLock()
_entries: deque[dict[str, Any]] = deque(maxlen=_MAX_ENTRIES)
_next_id = 1
_handler: logging.Handler | None = None


class _BackendLogHandler(logging.Handler):
    def emit(self, record: logging.LogRecord) -> None:
        global _next_id
        try:
            message = record.getMessage()
            if record.exc_info:
                formatter = self.formatter or logging.Formatter()
                message = f"{message}\n{formatter.formatException(record.exc_info)}"
            created_at = datetime.fromtimestamp(record.created, timezone.utc)
            with _lock:
                entry_id = _next_id
                _next_id += 1
                _entries.append({
                    "id": entry_id,
                    "created_at": created_at.isoformat(),
                    "level": record.levelname,
                    "logger": record.name,
                    "message": message,
                    "module": record.module,
                    "function": record.funcName,
                    "line": record.lineno,
                })
        except Exception:
            self.handleError(record)


def install_backend_log_handler(*, reset: bool = False) -> None:
    """Install the in-process admin log buffer once.

    Tests create multiple app instances in one Python process, so create_app()
    resets the buffer while reusing the same handler instance.
    """
    global _handler, _next_id
    root = logging.getLogger()
    with _lock:
        if reset:
            _entries.clear()
            _next_id = 1
        if _handler is None:
            _handler = _BackendLogHandler(level=logging.DEBUG)
            _handler.setFormatter(logging.Formatter())
            root.addHandler(_handler)
        elif _handler not in root.handlers:
            root.addHandler(_handler)
        if root.level == logging.NOTSET or root.level > logging.INFO:
            root.setLevel(logging.INFO)


def query_backend_logs(
    *,
    q: str | None = None,
    level: str | None = None,
    limit: int = 200,
) -> dict[str, Any]:
    with _lock:
        snapshot = list(_entries)
    total_count = len(snapshot)

    level_name = (level or "").strip().upper()
    if level_name:
        snapshot = [e for e in snapshot if e["level"] == level_name]

    needle = (q or "").strip().lower()
    if needle:
        terms = [part for part in needle.split() if part]
        snapshot = [
            e for e in snapshot
            if all(
                term in " ".join([
                    str(e.get("id", "")),
                    e.get("created_at", ""),
                    e.get("level", ""),
                    e.get("logger", ""),
                    e.get("message", ""),
                    e.get("module", ""),
                    e.get("function", ""),
                    str(e.get("line", "")),
                ]).lower()
                for term in terms
            )
        ]

    filtered_count = len(snapshot)
    entries = list(reversed(snapshot))[:limit]
    return {
        "entries": entries,
        "total_count": total_count,
        "filtered_count": filtered_count,
        "limit": limit,
        "levels": ["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"],
    }
