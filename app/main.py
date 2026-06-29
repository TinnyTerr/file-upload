from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
import logging
from pathlib import Path
import time

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, HTMLResponse, RedirectResponse, Response
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


class _ImmutableStatic(StaticFiles):
    """Serve Vite's content-hashed bundle assets with a long immutable cache.
    The filenames change whenever the contents do, so the browser can keep them
    forever — no revalidation round-trip on every page load."""

    async def get_response(self, path: str, scope):
        response = await super().get_response(path, scope)
        if response.status_code == 200:
            response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        return response

from app.audit.log import install_append_only_triggers
from app.bootstrap import ensure_master
from app.config import load_settings
from app.db import make_engine, make_session_factory, init_db, init_lock
from app.deps import AppState
from app.jobs.lifecycle import (
    archive_idle_job, delete_idle_job, temp_expiry_job, link_expiry_job,
    reconcile_stale_states,
)
from app.observability.events import event_bus
from app.observability.log_buffer import install_backend_log_handler
from app.security.lockout import LockoutPolicy
from app.security.sessions import SessionManager
from app.routes.auth import router as auth_router
from app.routes.account import router as account_router
from app.routes.admin import router as admin_router
from app.routes.files import router as files_router
from app.routes.directories import router as directories_router
from app.routes.remote_upload import router as remote_upload_router
from app.routes.dropbox import router as dropbox_router
from app.routes.public import router as public_router
from app.routes.users import router as users_router
from app.routes.audit_view import router as audit_router
from app.routes.keys import admin_router as admin_keys_router
from app.routes.keys import router as keys_router
from app.routes.ws import router as ws_router
from app.routes.ws import admin_router as cluster_router
from app.routes.cluster import router as cluster_mgmt_router
from app.spa import SPA_ASSETS, render_spa
from app.storage.paths import storage_root

_STATIC = Path(__file__).parent / "static"
_log = logging.getLogger(__name__)
_request_log = logging.getLogger("app.request")

# Paths that are routine browser/infrastructure noise (favicon probes, health
# checks, crawler files). Requests to these are logged at DEBUG regardless of
# status so an unauthenticated favicon 404 doesn't clutter the INFO log.
_QUIET_PATHS = frozenset({
    "/favicon.ico",
    "/health",
    "/robots.txt",
    "/apple-touch-icon.png",
    "/apple-touch-icon-precomposed.png",
})


def create_app(config_path: str | None = None, database_url: str | None = None) -> FastAPI:
    install_backend_log_handler(reset=True)
    settings = load_settings(config_path)
    db_url = database_url or settings.database_url
    engine = make_engine(db_url)
    init_db(engine)
    install_append_only_triggers(engine)
    session_factory = make_session_factory(engine)

    secure = settings.app_env != "dev"
    _allowed_hosts = {
        h.strip().lower() for h in (settings.allowed_hosts or "").split(",") if h.strip()
    }
    state = AppState(
        settings=settings,
        session_factory=session_factory,
        session_manager=SessionManager(settings.secret_key, secure=secure),
        lockout=LockoutPolicy(max_attempts=5, lockout_seconds=900),
        cluster_token=settings.cluster_token,
    )

    def _start_backend_workers(app: FastAPI):
        from apscheduler.schedulers.background import BackgroundScheduler
        from app.routes.files import _sweep_stale_parts

        scheduler = BackgroundScheduler()
        _sf = session_factory
        _sr = storage_root()
        scheduler.add_job(archive_idle_job, "interval", hours=1, args=[_sf, _sr], id="archive_idle")
        scheduler.add_job(delete_idle_job, "interval", hours=1, args=[_sf, _sr], id="delete_idle")
        scheduler.add_job(temp_expiry_job, "interval", hours=1, args=[_sf, _sr], id="temp_expiry")
        scheduler.add_job(link_expiry_job, "interval", minutes=10, args=[_sf], id="link_expiry")
        scheduler.add_job(_sweep_stale_parts, "interval", hours=1, id="sweep_stale_parts")
        scheduler.start()
        app.state.backend_scheduler = scheduler
        jobs = [job.id for job in scheduler.get_jobs()]
        _log.info("backend worker scheduler started jobs=%s", jobs)
        return scheduler

    def _shutdown_backend_workers(app: FastAPI) -> None:
        scheduler = getattr(app.state, "backend_scheduler", None)
        if scheduler is None:
            return
        try:
            scheduler.shutdown(wait=False)
            _log.info("backend worker scheduler stopped")
        except Exception as exc:
            _log.warning("backend worker scheduler stop skipped: %s", exc)

    def _restart_backend_workers() -> dict:
        _shutdown_backend_workers(app)
        scheduler = _start_backend_workers(app)
        jobs = [job.id for job in scheduler.get_jobs()]
        return {"status": "restarted", "jobs": jobs}

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        _log.info("application startup begin database_url=%s", db_url)
        # Bridge the synchronous event producers to this app's running loop so
        # the websocket firehose can deliver events from any thread.
        event_bus.reset()
        event_bus.bind_loop(asyncio.get_running_loop())
        storage_root().mkdir(parents=True, exist_ok=True)
        # Serialize first-run admin creation across worker processes: without
        # this, every worker's lifespan passes the "no user yet" check and races
        # to INSERT 'admin', and all but one hit UNIQUE constraint failed.
        with init_lock(engine):
            with session_factory() as s:
                state.bootstrap_password = ensure_master(s)

        reconcile_stale_states(session_factory, storage_root())
        _start_backend_workers(app)
        _log.info("application startup complete")
        try:
            yield
        finally:
            _shutdown_backend_workers(app)
            _log.info("application shutdown complete")

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
                    # HSTS only outside dev (where there's no TLS) — tells browsers
                    # to refuse plain HTTP to this origin after the first visit.
                    if secure and b"strict-transport-security" not in existing:
                        hdrs.append((b"strict-transport-security",
                                     b"max-age=63072000; includeSubDomains"))
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
                        candidate = fwd_host.split(",", 1)[0].strip()
                        # Only honor X-Forwarded-Host when explicitly allow-listed.
                        # Otherwise an attacker hitting the origin directly could set
                        # it to evil.com and turn this 308 into a cached open redirect.
                        if candidate.lower() in _allowed_hosts:
                            host = candidate
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

    class _RequestLogging:
        def __init__(self, app):
            self.app = app

        async def __call__(self, scope, receive, send):
            if scope["type"] != "http":
                await self.app(scope, receive, send)
                return

            started = time.perf_counter()
            status = 500

            async def _send(message):
                nonlocal status
                if message["type"] == "http.response.start":
                    status = int(message.get("status", 500))
                await send(message)

            try:
                await self.app(scope, receive, _send)
            finally:
                path = scope.get("path", "")
                method = scope.get("method", "")
                client = scope.get("client") or ("unknown", 0)
                duration_ms = (time.perf_counter() - started) * 1000
                # Pick a level proportional to how noteworthy the request is so
                # the default INFO log isn't drowned out by routine traffic.
                is_noise = path.startswith("/static") or path in _QUIET_PATHS
                if status >= 500:
                    level = logging.ERROR
                elif status >= 400:
                    # Expected probes (e.g. favicon 404) stay quiet; other
                    # client errors are worth a WARNING.
                    level = logging.DEBUG if is_noise else logging.WARNING
                elif is_noise:
                    level = logging.DEBUG
                else:
                    level = logging.INFO
                _request_log.log(
                    level,
                    "http request method=%s path=%s status=%s duration_ms=%.1f client=%s",
                    method,
                    path,
                    status,
                    duration_ms,
                    client[0],
                )

    app = FastAPI(title="Oxymoron (for files)", lifespan=lifespan)
    app.state.restart_backend_workers = _restart_backend_workers
    app.add_middleware(_HttpsRedirect)
    app.add_middleware(_SecurityHeaders)
    app.add_middleware(_RequestLogging)
    app.state.app_state = state

    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    # SPA shell routes. Each of these paths is also a client-side route in the
    # React app (see client/src/App.tsx); we serve the same built index.html and
    # let react-router render the right page. `no-cache` so a redeploy's new
    # hashed asset references are always picked up. The share pages (/file/{slug},
    # /d/{slug}) are served by their routers, which additionally inject OG meta.
    def _spa_shell() -> HTMLResponse:
        return HTMLResponse(render_spa(), headers={"Cache-Control": "no-cache"})

    @app.get("/")
    def root():
        return _spa_shell()

    @app.get("/login")
    def login_page():
        return _spa_shell()

    @app.get("/account/change")
    def change_page():
        return _spa_shell()

    @app.get("/files")
    def files_page():
        return _spa_shell()

    @app.get("/admin")
    def admin_page():
        return _spa_shell()

    @app.get("/api-docs")
    def api_docs_page():
        return _spa_shell()

    app.include_router(auth_router)
    app.include_router(account_router)
    app.include_router(admin_router)
    app.include_router(files_router)
    app.include_router(directories_router)
    app.include_router(remote_upload_router)
    app.include_router(dropbox_router)
    app.include_router(public_router)
    app.include_router(users_router)
    app.include_router(audit_router)
    app.include_router(keys_router)
    app.include_router(admin_keys_router)
    app.include_router(ws_router)
    app.include_router(cluster_router)
    app.include_router(cluster_mgmt_router)

    # Created at runtime if absent: a wheel install won't ship this empty dir
    # (no __init__.py → not a package), and StaticFiles raises if it's missing.
    _STATIC.mkdir(parents=True, exist_ok=True)
    app.mount("/static", _RevalidatingStatic(directory=str(_STATIC)), name="static")

    # Vite's hashed bundle (JS/CSS/workers) referenced by the SPA shell. Mounted
    # only if the client has been built; in that case the app still boots so the
    # API works, but SPA routes will 500 until `bun run build` populates ./public.
    if SPA_ASSETS.is_dir():
        app.mount("/assets", _ImmutableStatic(directory=str(SPA_ASSETS)), name="assets")
    else:
        _log.warning("SPA assets dir %s missing — run `bun run build` in client/", SPA_ASSETS)

    return app
