from __future__ import annotations

from fastapi import Depends, HTTPException, Request

from app.deps import current_session
from app.models.session import SessionRow


def require_csrf(request: Request, session_row: SessionRow = Depends(current_session)) -> SessionRow:
    header = request.headers.get("x-csrf-token")
    if not header or header != session_row.csrf_token:
        raise HTTPException(status_code=403, detail="invalid or missing CSRF token")
    return session_row
