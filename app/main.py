from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.audit.log import install_append_only_triggers
from app.bootstrap import ensure_master
from app.config import load_settings
from app.db import make_engine, make_session_factory, init_db
from app.deps import AppState
from app.security.lockout import LockoutPolicy
from app.security.sessions import SessionManager
from app.routes.auth import router as auth_router
from app.routes.account import router as account_router


def create_app(config_path: str | None = None, database_url: str | None = None) -> FastAPI:
    settings = load_settings(config_path)
    db_url = database_url or settings.database_url
    engine = make_engine(db_url)
    init_db(engine)
    install_append_only_triggers(engine)
    session_factory = make_session_factory(engine)

    secure = settings.app_env != "dev"
    state = AppState(
        settings=settings,
        session_factory=session_factory,
        session_manager=SessionManager(settings.secret_key, secure=secure),
        lockout=LockoutPolicy(max_attempts=5, lockout_seconds=900),
    )

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        with session_factory() as s:
            state.bootstrap_password = ensure_master(s)
        yield

    app = FastAPI(title="fileupload", lifespan=lifespan)
    app.state.app_state = state

    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    app.include_router(auth_router)
    app.include_router(account_router)
    return app
