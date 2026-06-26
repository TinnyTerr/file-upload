from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
import rjsmin
import rcssmin


class _RevalidatingStatic(StaticFiles):
    """Serve static assets minified and with `Cache-Control: no-cache` so
    browsers always revalidate instead of running stale JS/CSS after a deploy."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._minified: dict[str, bytes] = {}
        for d in self.all_directories:
            base = Path(d)
            for f in base.rglob("*.js"):
                if not f.name.endswith(".min.js"):
                    key = f.relative_to(base).as_posix()
                    self._minified[key] = rjsmin.jsmin(f.read_text("utf-8")).encode()
            for f in base.rglob("*.css"):
                if not f.name.endswith(".min.css"):
                    key = f.relative_to(base).as_posix()
                    self._minified[key] = rcssmin.cssmin(f.read_text("utf-8")).encode()

    async def get_response(self, path: str, scope):
        key = path.lstrip("/")
        if key in self._minified:
            ctype = "application/javascript" if key.endswith(".js") else "text/css"
            return Response(
                content=self._minified[key],
                media_type=ctype,
                headers={"Cache-Control": "no-cache"},
            )
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

    # Pure ASGI middleware — never touches the receive callable so large streaming
    # uploads flow through unimpeded. BaseHTTPMiddleware wraps receive in a task
    # queue that can stall uploads in Firefox and pin Chrome at 0%.

    class _SecurityHeaders:
        def __init__(self, app):
            self.app = app

        async def __call__(self, scope, receive, send):
            if scope["type"] != "http":
                await self.app(scope, receive, send)
                return

            async def _send(message):
                if message["type"] == "http.response.start":
                    hdrs = list(message.get("headers", []))
                    existing = {h[0].lower() for h in hdrs}
                    if b"x-content-type-options" not in existing:
                        hdrs.append((b"x-content-type-options", b"nosniff"))
                    if b"x-frame-options" not in existing:
                        hdrs.append((b"x-frame-options", b"DENY"))
                    if b"referrer-policy" not in existing:
                        hdrs.append((b"referrer-policy", b"no-referrer"))
                    message = {**message, "headers": hdrs}
                await send(message)

            await self.app(scope, receive, _send)

    class _HttpsRedirect:
        def __init__(self, app):
            self.app = app

        async def __call__(self, scope, receive, send):
            if scope["type"] != "http":
                await self.app(scope, receive, send)
                return

            headers = dict(scope.get("headers", []))
            scheme = scope.get("scheme", "http")

            if settings.trust_proxy:
                proto = headers.get(b"x-forwarded-proto", b"").decode()
                if proto:
                    scheme = proto.split(",", 1)[0].strip().lower()

            if settings.app_env != "dev" and scheme == "http":
                host = headers.get(b"host", b"localhost").decode()
                if settings.trust_proxy:
                    fwd_host = headers.get(b"x-forwarded-host", b"").decode()
                    if fwd_host:
                        host = fwd_host.split(",", 1)[0].strip()
                path = scope.get("path", "/")
                qs = scope.get("query_string", b"").decode()
                location = f"https://{host}{path}"
                if qs:
                    location += f"?{qs}"
                await send({
                    "type": "http.response.start",
                    "status": 308,
                    "headers": [(b"location", location.encode())],
                })
                await send({"type": "http.response.body", "body": b""})
                return

            await self.app(scope, receive, send)

    app = FastAPI(title="Oxymoron (for files)", lifespan=lifespan)
    app.add_middleware(_HttpsRedirect)
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
