from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.base import BaseHTTPMiddleware


class _RevalidatingStatic(StaticFiles):
    """Serve static assets with `Cache-Control: no-cache` so browsers always
    revalidate (cheap 304s via ETag) instead of silently running a stale cached
    download.js/aead-worker.js after we ship a fix."""

    async def get_response(self, path, scope):
        response = await super().get_response(path, scope)
        response.headers["Cache-Control"] = "no-cache"
        return response

from app.audit.log import install_append_only_triggers
from app.bootstrap import ensure_master
from app.config import load_settings
from app.db import make_engine, make_session_factory, init_db
from app.deps import AppState
from app.jobs.lifecycle import (
    archive_idle_job, delete_idle_job, temp_expiry_job, link_expiry_job,
    reconcile_stale_states,
)
from app.security.lockout import LockoutPolicy
from app.security.sessions import SessionManager
from app.routes.auth import router as auth_router
from app.routes.account import router as account_router
from app.routes.files import router as files_router
from app.routes.directories import router as directories_router
from app.routes.public import router as public_router
from app.routes.users import router as users_router
from app.routes.audit_view import router as audit_router
from app.routes.keys import router as keys_router
from app.storage.paths import storage_root

_STATIC = Path(__file__).parent / "static"


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
        storage_root().mkdir(parents=True, exist_ok=True)
        with session_factory() as s:
            state.bootstrap_password = ensure_master(s)

        reconcile_stale_states(session_factory, storage_root())

        from apscheduler.schedulers.background import BackgroundScheduler
        scheduler = BackgroundScheduler()
        _sf = session_factory
        _sr = storage_root()
        scheduler.add_job(archive_idle_job, "interval", hours=1, args=[_sf, _sr], id="archive_idle")
        scheduler.add_job(delete_idle_job, "interval", hours=1, args=[_sf, _sr], id="delete_idle")
        scheduler.add_job(temp_expiry_job, "interval", hours=1, args=[_sf, _sr], id="temp_expiry")
        scheduler.add_job(link_expiry_job, "interval", minutes=10, args=[_sf], id="link_expiry")
        scheduler.start()
        try:
            yield
        finally:
            scheduler.shutdown(wait=False)

    class _SecurityHeaders(BaseHTTPMiddleware):
        async def dispatch(self, request: Request, call_next):
            response = await call_next(request)
            response.headers.setdefault("X-Content-Type-Options", "nosniff")
            response.headers.setdefault("X-Frame-Options", "DENY")
            response.headers.setdefault("Referrer-Policy", "no-referrer")
            return response

    app = FastAPI(title="Oxymoron (for files)", lifespan=lifespan)
    app.add_middleware(_SecurityHeaders)
    app.state.app_state = state

    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/")
    def root():
        return RedirectResponse("/login")

    @app.get("/login")
    def login_page():
        return FileResponse(str(_STATIC / "login.html"))

    @app.get("/account/change")
    def change_page():
        return FileResponse(str(_STATIC / "change.html"))

    @app.get("/files")
    def files_page():
        return FileResponse(str(_STATIC / "files.html"))

    @app.get("/admin")
    def admin_page():
        return FileResponse(str(_STATIC / "admin.html"))

    @app.get("/api-docs")
    def api_docs_page():
        return FileResponse(str(_STATIC / "api-docs.html"))

    app.include_router(auth_router)
    app.include_router(account_router)
    app.include_router(files_router)
    app.include_router(directories_router)
    app.include_router(public_router)
    app.include_router(users_router)
    app.include_router(audit_router)
    app.include_router(keys_router)

    app.mount("/static", _RevalidatingStatic(directory=str(_STATIC)), name="static")

    return app
