from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import DateTime, TypeDecorator, create_engine, event
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


def init_db(engine: Engine) -> None:
    # Import models so they register on Base.metadata before create_all.
    from app.models import user as _user  # noqa: F401
    from app.models import audit as _audit  # noqa: F401
    from app.models import session as _session  # noqa: F401
    from app.models import login_attempt as _la  # noqa: F401
    from app.models import permission as _permission  # noqa: F401
    from app.models import file as _file  # noqa: F401
    from app.models import link as _link  # noqa: F401
    from app.models import api_key as _api_key  # noqa: F401
    from app.models import credential as _credential  # noqa: F401
    Base.metadata.create_all(engine)
