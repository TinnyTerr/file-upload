from __future__ import annotations

import hashlib
import os
import sys
from contextlib import contextmanager
from datetime import datetime, timezone

from sqlalchemy import DateTime, TypeDecorator, create_engine, event, inspect, text
from sqlalchemy.engine import Engine
from sqlalchemy.orm import DeclarativeBase, sessionmaker
from sqlalchemy.pool import StaticPool


class Base(DeclarativeBase):
    pass


class UTCDateTime(TypeDecorator):
    """DateTime that always stores and returns timezone-aware UTC.

    SQLite's dialect strips tzinfo on round-trip; this normalizes any aware
    input to UTC on store and re-attaches UTC on load. Naive input is assumed
    to already be UTC. Use this for ALL datetime columns in the app.
    """

    impl = DateTime(timezone=True)
    cache_ok = True

    def process_bind_param(self, value, dialect):
        if value is None:
            return None
        if value.tzinfo is None:
            return value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc)

    def process_result_value(self, value, dialect):
        if value is None:
            return None
        if value.tzinfo is None:
            return value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc)


def make_engine(database_url: str) -> Engine:
    connect_args: dict = {}
    extra: dict = {}
    is_memory = ":memory:" in database_url or database_url == "sqlite://"
    if database_url.startswith("sqlite"):
        connect_args["check_same_thread"] = False
        # In-memory DBs are per-connection; a single shared connection
        # (StaticPool) is required so all sessions/threads see the same tables.
        if is_memory:
            extra["poolclass"] = StaticPool
    engine = create_engine(database_url, connect_args=connect_args, **extra)

    # Enforce foreign keys + better concurrency for SQLite.
    if database_url.startswith("sqlite"):
        @event.listens_for(engine, "connect")
        def _set_sqlite_pragma(dbapi_conn, _):
            cur = dbapi_conn.cursor()
            cur.execute("PRAGMA foreign_keys=ON")
            if not is_memory:
                cur.execute("PRAGMA journal_mode=WAL")
            cur.close()

    return engine


def make_session_factory(engine: Engine) -> sessionmaker:
    return sessionmaker(bind=engine, expire_on_commit=False)


if sys.platform == "win32":
    import msvcrt

    def _lock_fd(fd: int) -> None:
        # Blocks (retrying ~10s) until a 1-byte region is exclusively locked.
        msvcrt.locking(fd, msvcrt.LK_LOCK, 1)

    def _unlock_fd(fd: int) -> None:
        msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
else:
    import fcntl

    def _lock_fd(fd: int) -> None:
        fcntl.flock(fd, fcntl.LOCK_EX)

    def _unlock_fd(fd: int) -> None:
        fcntl.flock(fd, fcntl.LOCK_UN)


def _schema_lock_path(engine: Engine) -> str | None:
    """Path to the cross-process lock file guarding schema creation, or None
    when serialization isn't needed (in-memory or non-file-based backends)."""
    if engine.dialect.name != "sqlite":
        return None
    db = engine.url.database
    if not db or db == ":memory:":
        return None
    return db + ".init.lock"


@contextmanager
def _cross_process_lock(path: str):
    fd = os.open(path, os.O_RDWR | os.O_CREAT, 0o644)
    try:
        _lock_fd(fd)
        try:
            yield
        finally:
            _unlock_fd(fd)
    finally:
        os.close(fd)


@contextmanager
def init_lock(engine: Engine):
    """Cross-process mutex for one-time startup work that every worker process
    would otherwise run concurrently (schema creation, master bootstrap).

    With uvicorn --workers N, all N processes call create_app()/lifespan against
    the same DB. Any non-atomic check-then-write (create_all, "no user yet ->
    INSERT admin") races between processes. Holding this lock around such a
    section, and re-checking inside it, makes exactly one process do the work.

    No-op for in-memory / non-file backends, where nothing is shared across
    processes.
    """
    path = _schema_lock_path(engine)
    if path is None:
        yield
        return
    with _cross_process_lock(path):
        yield


def init_db(engine: Engine) -> None:
    # Import models so they register on Base.metadata before create_all.
    from app.models import user as _user  # noqa: F401
    from app.models import audit as _audit  # noqa: F401
    from app.models import session as _session  # noqa: F401
    from app.models import login_attempt as _la  # noqa: F401
    from app.models import permission as _permission  # noqa: F401
    from app.models import directory as _directory  # noqa: F401
    from app.models import file as _file  # noqa: F401
    from app.models import link as _link  # noqa: F401
    from app.models import api_key as _api_key  # noqa: F401
    from app.models import credential as _credential  # noqa: F401
    from app.models import storage_settings as _storage_settings  # noqa: F401
    from app.models import content_blob as _content_blob  # noqa: F401
    from app.models import directory_collaborator as _directory_collaborator  # noqa: F401
    from app.models import dropbox_link as _dropbox_link  # noqa: F401
    from app.models import remote_upload_job as _remote_upload_job  # noqa: F401
    from app.models import directory_link as _directory_link  # noqa: F401

    # create_all() does a non-atomic check-then-create: it inspects existing
    # tables, then issues bare CREATE TABLE. When multiple worker processes call
    # init_db() concurrently against a fresh DB (uvicorn --workers N), two can
    # pass the "doesn't exist" check and the second CREATE fails with
    # "table ... already exists". Serialize across processes so exactly one
    # process builds the schema while the others wait and then see it present.
    with init_lock(engine):
        Base.metadata.create_all(engine)
        _migrate_add_columns(engine)


# Minimal additive migrations for SQLite: create_all() never alters existing
# tables, so columns added to models after a DB was first created must be patched
# in by hand. Each entry is (table, column, column DDL). Idempotent.
_ADDED_COLUMNS = [
    ("files", "enc_access_blob", "BLOB"),
    ("files", "directory_id", "INTEGER"),
    ("files", "blob_id", "INTEGER"),
    ("files", "source_type", "TEXT NOT NULL DEFAULT 'upload'"),
    ("files", "saved_from_file_id", "INTEGER"),
    ("files", "archive_original_stored_size_bytes", "BIGINT NOT NULL DEFAULT 0"),
    ("files", "archive_saved_bytes", "BIGINT NOT NULL DEFAULT 0"),
    ("api_keys", "user_key_number", "INTEGER NOT NULL DEFAULT 0"),
    ("permissions", "can_delete_links", "BOOLEAN NOT NULL DEFAULT 1"),
    ("permissions", "can_create_directories", "BOOLEAN NOT NULL DEFAULT 1"),
    ("permissions", "can_manage_lifecycle", "BOOLEAN NOT NULL DEFAULT 1"),
    ("permissions", "can_view_admin", "BOOLEAN NOT NULL DEFAULT 0"),
    ("permissions", "can_manage_users", "BOOLEAN NOT NULL DEFAULT 0"),
    ("permissions", "can_manage_storage", "BOOLEAN NOT NULL DEFAULT 0"),
    ("permissions", "can_manage_api_keys", "BOOLEAN NOT NULL DEFAULT 0"),
    ("users", "avatar_data", "BLOB"),
    ("users", "avatar_content_type", "TEXT"),
    ("sessions", "ip_address", "TEXT"),
    ("sessions", "user_agent", "TEXT"),
    ("sessions", "last_seen_at", "DATETIME"),
    ("files", "saved_from_directory_id", "INTEGER"),
    ("directories", "hide_uploader", "BOOLEAN NOT NULL DEFAULT 0"),
    ("directories", "saved_from_directory_id", "INTEGER"),
    ("directories", "key_check_blob", "TEXT"),
    ("links", "hide_uploader", "BOOLEAN NOT NULL DEFAULT 0"),
]

_PERMISSION_COLUMNS = (
    "id",
    "user_id",
    "can_upload",
    "can_upload_client_encrypted",
    "can_delete",
    "can_regenerate_links",
    "can_delete_links",
    "can_create_directories",
    "can_manage_lifecycle",
    "can_use_api_keys",
    "can_view_admin",
    "can_manage_users",
    "can_manage_storage",
    "can_manage_api_keys",
    "quota_bytes",
    "max_file_bytes",
    "archive_after_idle_days",
    "created_at",
)

_PERMISSIONS_TABLE_DDL = """
CREATE TABLE permissions (
    id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    can_upload BOOLEAN NOT NULL,
    can_upload_client_encrypted BOOLEAN NOT NULL,
    can_delete BOOLEAN NOT NULL,
    can_regenerate_links BOOLEAN NOT NULL,
    can_delete_links BOOLEAN NOT NULL,
    can_create_directories BOOLEAN NOT NULL,
    can_manage_lifecycle BOOLEAN NOT NULL,
    can_use_api_keys BOOLEAN NOT NULL,
    can_view_admin BOOLEAN NOT NULL,
    can_manage_users BOOLEAN NOT NULL,
    can_manage_storage BOOLEAN NOT NULL,
    can_manage_api_keys BOOLEAN NOT NULL,
    quota_bytes BIGINT NOT NULL,
    max_file_bytes BIGINT NOT NULL,
    archive_after_idle_days INTEGER NOT NULL,
    created_at DATETIME NOT NULL,
    PRIMARY KEY (id),
    UNIQUE (user_id),
    FOREIGN KEY(user_id) REFERENCES users (id)
)
"""


def _migrate_add_columns(engine: Engine) -> None:
    with engine.begin() as conn:
        # Inspect via the same transaction connection rather than opening a second
        # one against the engine — SQLite is single-writer, and a separate
        # connection reading while this one holds the write transaction invites
        # lock contention.
        inspector = inspect(conn)
        existing_tables = set(inspector.get_table_names())
        for table, column, ddl in _ADDED_COLUMNS:
            if table not in existing_tables:
                continue
            cols = {c["name"] for c in inspector.get_columns(table)}
            if column not in cols:
                conn.execute(text(f'ALTER TABLE "{table}" ADD COLUMN {column} {ddl}'))
        if "permissions" in existing_tables:
            _drop_legacy_permission_p2p_column(conn)
        if "api_keys" in existing_tables:
            _backfill_api_key_numbers(conn)
        if "files" in existing_tables and "content_blobs" in existing_tables:
            _backfill_content_blobs(conn)


def _sqlite_column_names(conn, table: str) -> set[str]:
    rows = conn.execute(text(f'PRAGMA table_info("{table}")')).all()
    return {str(row[1]) for row in rows}


def _drop_legacy_permission_p2p_column(conn) -> None:
    columns = _sqlite_column_names(conn, "permissions")
    if "can_use_p2p" not in columns:
        return

    missing = [column for column in _PERMISSION_COLUMNS if column not in columns]
    if missing:
        raise RuntimeError(
            "cannot migrate permissions.can_use_p2p before columns exist: "
            + ", ".join(missing)
        )

    column_sql = ", ".join(f'"{column}"' for column in _PERMISSION_COLUMNS)
    conn.execute(text("ALTER TABLE permissions RENAME TO permissions_legacy_p2p"))
    conn.execute(text(_PERMISSIONS_TABLE_DDL))
    conn.execute(
        text(
            f"""
            INSERT INTO permissions ({column_sql})
            SELECT {column_sql}
            FROM permissions_legacy_p2p
            """
        )
    )
    conn.execute(text("DROP TABLE permissions_legacy_p2p"))


def _backfill_api_key_numbers(conn) -> None:
    rows = conn.execute(
        text(
            """
            SELECT id, owner_id
            FROM api_keys
            ORDER BY owner_id ASC, created_at ASC, id ASC
            """
        )
    ).mappings().all()
    counters: dict[int, int] = {}
    for row in rows:
        owner_id = int(row["owner_id"])
        counters[owner_id] = counters.get(owner_id, 0) + 1
        conn.execute(
            text("UPDATE api_keys SET user_key_number = :n WHERE id = :id AND user_key_number = 0"),
            {"n": counters[owner_id], "id": row["id"]},
        )


def _hash_existing_file(path) -> dict[str, str] | None:
    if not path.exists() or not path.is_file():
        return None
    sha256 = hashlib.sha256()
    sha1 = hashlib.sha1()
    md5 = hashlib.md5()
    blake2b = hashlib.blake2b()
    with open(path, "rb") as fh:
        while True:
            chunk = fh.read(1024 * 1024)
            if not chunk:
                break
            sha256.update(chunk)
            sha1.update(chunk)
            md5.update(chunk)
            blake2b.update(chunk)
    return {
        "sha256": sha256.hexdigest(),
        "sha1": sha1.hexdigest(),
        "md5": md5.hexdigest(),
        "blake2b": blake2b.hexdigest(),
    }


def _legacy_hashes(seed: str) -> dict[str, str]:
    raw = seed.encode("utf-8", "replace")
    return {
        "sha256": hashlib.sha256(raw).hexdigest(),
        "sha1": hashlib.sha1(raw).hexdigest(),
        "md5": hashlib.md5(raw).hexdigest(),
        "blake2b": hashlib.blake2b(raw).hexdigest(),
    }


def _backfill_content_blobs(conn) -> None:
    from app.storage.paths import safe_join, storage_root

    rows = conn.execute(
        text(
            """
            SELECT id, storage_path, original_filename, size_bytes, stored_size_bytes, content_type,
                   encryption_mode, compressed, archived, blob_id
            FROM files
            WHERE blob_id IS NULL
            ORDER BY id ASC
            """
        )
    ).mappings().all()
    for row in rows:
        rel = row["storage_path"]
        hashes = None
        try:
            hashes = _hash_existing_file(safe_join(storage_root(), rel))
        except (OSError, ValueError):
            hashes = None
        if hashes is None:
            hashes = _legacy_hashes(f"legacy:{row['id']}:{rel}")
        transform = "legacy"
        if row["encryption_mode"]:
            transform += f":{row['encryption_mode']}"
        if row["compressed"]:
            transform += ":compressed"
        if row["archived"]:
            transform += ":archived"
        result = conn.execute(
            text(
                """
                INSERT INTO content_blobs
                    (storage_path, content_type, size_bytes, stored_size_bytes,
                     sha256, sha1, md5, blake2b, stored_sha256, transform_key,
                     ref_count, created_at)
                VALUES
                    (:storage_path, :content_type, :size_bytes, :stored_size_bytes,
                     :sha256, :sha1, :md5, :blake2b, :stored_sha256, :transform_key,
                     1, :created_at)
                """
            ),
            {
                "storage_path": rel,
                "content_type": row["content_type"] or "application/octet-stream",
                "size_bytes": int(row["size_bytes"] or 0),
                "stored_size_bytes": int(row["stored_size_bytes"] or 0),
                "sha256": hashes["sha256"],
                "sha1": hashes["sha1"],
                "md5": hashes["md5"],
                "blake2b": hashes["blake2b"],
                "stored_sha256": hashes["sha256"],
                "transform_key": transform,
                "created_at": datetime.now(timezone.utc),
            },
        )
        conn.execute(
            text("UPDATE files SET blob_id = :blob_id WHERE id = :file_id"),
            {"blob_id": result.lastrowid, "file_id": row["id"]},
        )
