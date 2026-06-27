from __future__ import annotations

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
]


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
