from __future__ import annotations

import asyncio
import secrets
from typing import Any, Callable

from fastapi import APIRouter, Depends, HTTPException, Request, WebSocket, WebSocketDisconnect
from sqlalchemy.orm import Session

from app.deps import AppState
from app.models.user import User
from app.observability.events import event_bus
from app.security.sessions import COOKIE_NAME

router = APIRouter(tags=["realtime"])
admin_router = APIRouter(prefix="/admin/cluster", tags=["realtime"])


# ── websocket plumbing ────────────────────────────────────────────────────────


async def _pump(websocket: WebSocket,
                predicate: Callable[[dict[str, Any]], bool],
                after_id: int) -> None:
    """Stream events to a connected socket until it disconnects.

    Replays buffered events newer than ``after_id`` first (so a reconnecting
    node resumes without gaps), then forwards live events. A concurrent reader
    drains inbound frames purely so a disconnect is noticed promptly even while
    the stream is idle.
    """
    queue = event_bus.subscribe(predicate)
    try:
        for event in event_bus.recent(predicate=predicate, after_id=after_id):
            await websocket.send_json({"type": "event", **event})
        await websocket.send_json({"type": "ready", "buffered": event_bus.subscriber_count})

        async def _forward() -> None:
            while True:
                event = await queue.get()
                await websocket.send_json({"type": "event", **event})

        async def _drain() -> None:
            # We don't act on client messages, but reading them surfaces the
            # disconnect as a WebSocketDisconnect that ends both tasks.
            while True:
                await websocket.receive_text()

        forward = asyncio.create_task(_forward())
        drain = asyncio.create_task(_drain())
        done, pending = await asyncio.wait(
            {forward, drain}, return_when=asyncio.FIRST_COMPLETED
        )
        for task in pending:
            task.cancel()
        for task in done:
            exc = task.exception()
            if exc and not isinstance(exc, (WebSocketDisconnect, asyncio.CancelledError)):
                raise exc
    finally:
        event_bus.unsubscribe(queue)


def _after_id(websocket: WebSocket) -> int:
    try:
        return int(websocket.query_params.get("after", "0"))
    except (TypeError, ValueError):
        return 0


@router.websocket("/ws/events")
async def user_events(websocket: WebSocket) -> None:
    """Per-user live event stream, authenticated by the session cookie.

    A user receives their own events across all their sessions/nodes; a master
    receives the full firehose (same payload as the cluster token, but gated on
    an interactive login rather than the standalone token).
    """
    state: AppState = websocket.app.state.app_state
    cookie = websocket.cookies.get(COOKIE_NAME)
    db: Session = state.session_factory()
    try:
        row = state.session_manager.resolve(db, cookie)
        if row is None:
            await websocket.close(code=4401)
            return
        user = db.get(User, row.user_id)
        if user is None or user.must_change_credentials:
            await websocket.close(code=4401)
            return
        username = user.username
        is_master = user.role == "master"
    finally:
        db.close()

    if is_master:
        predicate: Callable[[dict[str, Any]], bool] = lambda e: True
    else:
        predicate = lambda e, u=username: e.get("actor") == u

    await websocket.accept()
    try:
        await _pump(websocket, predicate, _after_id(websocket))
    except WebSocketDisconnect:
        pass


@admin_router.websocket("/firehose")
async def cluster_firehose(websocket: WebSocket) -> None:
    """Sensitive, password-independent firehose of ALL events.

    Authenticated by the cluster token (``?token=`` query param or
    ``Authorization: Bearer`` header). Intended for cluster nodes and external
    monitoring — it is not tied to any user or login.
    """
    state: AppState = websocket.app.state.app_state
    presented = websocket.query_params.get("token")
    if not presented:
        header = websocket.headers.get("authorization", "")
        if header.startswith("Bearer "):
            presented = header[len("Bearer "):].strip()
    expected = state.cluster_token or ""
    if not presented or not expected or not secrets.compare_digest(presented, expected):
        await websocket.close(code=4401)
        return

    await websocket.accept()
    try:
        await _pump(websocket, lambda e: True, _after_id(websocket))
    except WebSocketDisconnect:
        pass


# ── cluster token management + polling REST ───────────────────────────────────


def require_cluster_token(request: Request) -> AppState:
    """Authenticate a request by the cluster token (Bearer or X-Cluster-Token).

    Distinct from API-key/session auth: this single token grants read access to
    every event regardless of which user produced it.
    """
    state: AppState = request.app.state.app_state
    header = request.headers.get("authorization", "")
    presented = header[len("Bearer "):].strip() if header.startswith("Bearer ") else ""
    if not presented:
        presented = request.headers.get("x-cluster-token", "").strip()
    expected = state.cluster_token or ""
    if not presented or not expected or not secrets.compare_digest(presented, expected):
        raise HTTPException(status_code=401, detail="invalid cluster token")
    return state


@admin_router.get("/events")
def poll_events(request: Request, after: int = 0, limit: int = 200,
                _state: AppState = Depends(require_cluster_token)) -> dict:
    """Long-poll-friendly snapshot of recent events for nodes that prefer HTTP
    over a persistent websocket. Pass the highest ``id`` seen as ``after``."""
    limit = max(1, min(limit, 1000))
    events = event_bus.recent(after_id=after, limit=limit)
    last_id = events[-1]["id"] if events else after
    return {"events": events, "last_id": last_id, "count": len(events)}
