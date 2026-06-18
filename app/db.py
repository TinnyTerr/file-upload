from __future__ import annotations

from sqlalchemy import create_engine, event
from sqlalchemy.engine import Engine
from sqlalchemy.orm import DeclarativeBase, sessionmaker
from sqlalchemy.pool import StaticPool


class Base(DeclarativeBase):
    pass


def make_engine(database_url: str) -> Engine:
    connect_args: dict = {}
    extra: dict = {}
    if database_url.startswith("sqlite"):
        connect_args["check_same_thread"] = False
        # In-memory DBs are per-connection; a single shared connection
        # (StaticPool) is required so all sessions/threads see the same tables.
        if ":memory:" in database_url or database_url == "sqlite://":
            extra["poolclass"] = StaticPool
    engine = create_engine(database_url, connect_args=connect_args, future=True, **extra)

    # Enforce foreign keys + better concurrency for SQLite.
    if database_url.startswith("sqlite"):
        @event.listens_for(engine, "connect")
        def _set_sqlite_pragma(dbapi_conn, _):
            cur = dbapi_conn.cursor()
            cur.execute("PRAGMA foreign_keys=ON")
            cur.execute("PRAGMA journal_mode=WAL")
            cur.close()

    return engine


def make_session_factory(engine: Engine):
    return sessionmaker(bind=engine, expire_on_commit=False, future=True)


def init_db(engine: Engine) -> None:
    # Import models so they register on Base.metadata before create_all.
    from app.models import user as _user  # noqa: F401
    Base.metadata.create_all(engine)
