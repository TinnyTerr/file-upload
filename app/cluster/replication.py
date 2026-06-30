from __future__ import annotations

import base64
import hashlib
import json
import logging
from datetime import datetime
from typing import Any, Callable

from sqlalchemy import DateTime
from sqlalchemy import inspect as sa_inspect

from app.db import UTCDateTime
from app.models.content_blob import ContentBlob
from app.models.directory import Directory
from app.models.directory_link import DirectoryLink
from app.models.file import FileObject
from app.models.link import Link
from app.models.permission import Permission
from app.models.user import User

_log = logging.getLogger("app.cluster.replication")

# Replicated tables in FK-dependency order (parents first) so a bulk apply never
# inserts a child before its parent. Sessions are deliberately NOT replicated —
# logins stay node-local. Identity/ownership rows replicate so a file uploaded on
# one node is fully usable (listable, shareable, downloadable) on every node.
REPLICATED_MODELS = [
    User,
    Permission,
    ContentBlob,
    Directory,
    DirectoryLink,
    FileObject,
    Link,
]
_MODEL_BY_TABLE = {m.__tablename__: m for m in REPLICATED_MODELS}
_ORDER = {m.__tablename__: i for i, m in enumerate(REPLICATED_MODELS)}

# Columns excluded from a row's identity fingerprint: per-node counters and
# liveness timestamps that legitimately differ for the *same* logical row.
_VOLATILE = {
    "last_downloaded_at", "last_seen_at", "last_heartbeat_at", "use_count", "ref_count",
}


def _col_value_to_json(value: Any) -> Any:
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, (bytes, bytearray)):
        return {"__b64__": base64.b64encode(bytes(value)).decode("ascii")}
    return value


def serialize_row(obj: Any) -> dict[str, Any]:
    """Serialize a replicated ORM row to a JSON-safe {table, data} envelope."""
    mapper = sa_inspect(type(obj))
    data = {c.key: _col_value_to_json(getattr(obj, c.key)) for c in mapper.columns}
    return {"table": obj.__tablename__, "data": data}


_DATETIME_COLS: dict[str, set[str]] = {}


def _datetime_columns(model: Any) -> set[str]:
    """Column keys on a model whose python type is datetime (cached)."""
    table = model.__tablename__
    cached = _DATETIME_COLS.get(table)
    if cached is not None:
        return cached
    # UTCDateTime is a TypeDecorator whose .python_type raises NotImplementedError,
    # so detect datetime columns by their (decorated) type rather than python_type.
    cols = {
        c.key for c in sa_inspect(model).columns
        if isinstance(c.type, (UTCDateTime, DateTime))
    }
    _DATETIME_COLS[table] = cols
    return cols


def _row_kwargs(model: Any, data: dict[str, Any]) -> dict[str, Any]:
    dt_cols = _datetime_columns(model)
    out: dict[str, Any] = {}
    for key, value in data.items():
        if isinstance(value, dict) and "__b64__" in value:
            out[key] = base64.b64decode(value["__b64__"])
        elif value is not None and key in dt_cols and isinstance(value, str):
            out[key] = datetime.fromisoformat(value)
        else:
            out[key] = value
    return out


def identity_hash(table: str, data: dict[str, Any]) -> str:
    """Stable fingerprint of a row's immutable identity, used to tell whether two
    nodes hold the SAME logical row at a given id or DIFFERENT ones."""
    model = _MODEL_BY_TABLE.get(table)
    if model is None:
        return ""
    cols = [c.key for c in sa_inspect(model).columns if c.key not in _VOLATILE]
    payload = {k: data.get(k) for k in cols}
    return hashlib.sha256(
        json.dumps(payload, sort_keys=True, default=str).encode("utf-8")
    ).hexdigest()


def local_identity(session, table: str, row_id: int) -> str | None:
    """Identity fingerprint of the local row at (table, id), or None if absent."""
    model = _MODEL_BY_TABLE.get(table)
    if model is None:
        return None
    obj = session.get(model, row_id)
    if obj is None:
        return None
    return identity_hash(table, serialize_row(obj)["data"])


def apply_rows(session, rows: list[dict[str, Any]]) -> int:
    """Upsert serialized rows by primary key (merge), parents before children.

    merge() inserts or overwrites by PK, which is exactly the semantics we want:
    for incoming replication it lands the row at its canonical id, and for a
    rebase-from-master it overwrites local divergence with the master's truth."""
    ordered = sorted(rows, key=lambda r: _ORDER.get(r.get("table", ""), 999))
    applied = 0
    for row in ordered:
        table = row.get("table")
        model = _MODEL_BY_TABLE.get(table)
        if model is None:
            continue
        data = row.get("data") or {}
        session.merge(model(**_row_kwargs(model, data)))
        applied += 1
    return applied


def export_all(session) -> list[dict[str, Any]]:
    """Serialize every replicated row — the master's canonical snapshot a joining
    or diverged node rebases onto."""
    rows: list[dict[str, Any]] = []
    for model in REPLICATED_MODELS:
        for obj in session.query(model).all():
            rows.append(serialize_row(obj))
    return rows


def collect_file_rows(session, file_id: int) -> list[dict[str, Any]]:
    """Everything a peer needs to make one uploaded file fully usable: the file,
    its blob, its links, the owner (+permission) and any containing directory."""
    f = session.get(FileObject, file_id)
    if f is None:
        return []
    rows: list[dict[str, Any]] = []
    owner = session.get(User, f.owner_id)
    if owner is not None:
        rows.append(serialize_row(owner))
        perm = session.query(Permission).filter_by(user_id=owner.id).one_or_none()
        if perm is not None:
            rows.append(serialize_row(perm))
    if f.blob_id:
        blob = session.get(ContentBlob, f.blob_id)
        if blob is not None:
            rows.append(serialize_row(blob))
    if f.directory_id:
        d = session.get(Directory, f.directory_id)
        if d is not None:
            rows.append(serialize_row(d))
            for dl in session.query(DirectoryLink).filter_by(directory_id=d.id).all():
                rows.append(serialize_row(dl))
    rows.append(serialize_row(f))
    for lk in session.query(Link).filter_by(file_id=f.id).all():
        rows.append(serialize_row(lk))
    return rows


# ── outbound client helpers ────────────────────────────────────────────────────


def _active_peers(session_factory: Callable[[], Any]) -> list[tuple[str, str, bool]]:
    from app.models.cluster_node import ClusterNode

    with session_factory() as s:
        return [
            (n.base_url.rstrip("/"), n.token, n.is_master)
            for n in s.query(ClusterNode).filter(ClusterNode.active == True).all()  # noqa: E712
            if n.base_url and n.token
        ]


def rebase_from_master(settings, session_factory: Callable[[], Any]) -> bool:
    """Pull the master's canonical snapshot and overwrite local divergence.

    This is the conflict sledgehammer the announce-id protocol falls back to:
    after a reservation conflict (or at join time) the node re-derives shared
    state from the single source of truth. Returns True on success."""
    from app.cluster.http import ClusterHTTPError, get_json

    for base_url, token, is_master in _active_peers(session_factory):
        if not is_master:
            continue
        try:
            payload = get_json(f"{base_url}/cluster/export", token, timeout=30.0)
        except ClusterHTTPError as exc:
            _log.warning("rebase: master export fetch failed: %s", exc)
            return False
        rows = (payload or {}).get("rows", [])
        with session_factory() as s:
            apply_rows(s, rows)
            s.commit()
        _log.info("rebased %d rows from master %s", len(rows), base_url)
        return True
    _log.warning("rebase requested but no reachable master is linked")
    return False


def replicate_file(settings, session_factory: Callable[[], Any], file_id: int) -> str:
    """Announce + replicate a freshly-uploaded file to every peer.

    Implements the user's announce-the-id protocol: reserve the file's id with
    each peer; if any peer already holds a DIFFERENT row at that id, rebase from
    the master (source of truth) and report a conflict; otherwise push the file's
    rows to all peers. Best-effort and a no-op without peers, so single-node
    behaviour is unchanged. Returns "ok", "conflict", or "noop"."""
    from app.cluster.http import ClusterHTTPError, post_json

    peers = _active_peers(session_factory)
    if not peers:
        return "noop"

    with session_factory() as s:
        rows = collect_file_rows(s, file_id)
        file_identity = local_identity(s, "files", file_id)
    if not rows or file_identity is None:
        return "noop"

    # 1) Announce: reserve the file id on every peer.
    for base_url, token, _is_master in peers:
        try:
            res = post_json(
                f"{base_url}/cluster/reserve", token,
                {"table": "files", "id": file_id, "identity": file_identity},
                timeout=10.0,
            )
        except ClusterHTTPError as exc:
            # Treat an unreachable peer as non-blocking; heartbeat will mark it
            # stale and a later sync/rebase reconciles it.
            _log.debug("reserve: peer %s unreachable: %s", base_url, exc)
            continue
        if not (res or {}).get("ok", False):
            _log.warning("file id %s conflicts on peer %s — rebasing to master",
                         file_id, base_url)
            rebase_from_master(settings, session_factory)
            return "conflict"

    # 2) Replicate: push the rows to every peer.
    for base_url, token, _is_master in peers:
        try:
            post_json(f"{base_url}/cluster/replicate", token, {"rows": rows}, timeout=15.0)
        except ClusterHTTPError as exc:
            _log.debug("replicate: peer %s unreachable: %s", base_url, exc)
    return "ok"
