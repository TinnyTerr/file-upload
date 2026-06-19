from __future__ import annotations

import base64 as _b64
import re as _re
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse, Response, StreamingResponse
from sqlalchemy.orm import Session

from app.audit.log import record
from app.deps import client_ip, get_db
from app.links.consume import consume_use, resolve_active_link
from app.models.file import FileObject

router = APIRouter(tags=["public"])

_STATIC = Path(__file__).parent.parent / "static"
_SECURITY = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'self'; script-src 'self'; object-src 'none'",
}
_CHUNK = 256 * 1024


def _parse_range(header: str, file_size: int) -> tuple[int, int] | None:
    m = _re.match(r"bytes=(\d*)-(\d*)$", header.strip())
    if not m:
        return None
    s, e = m.group(1), m.group(2)
    if s:
        start = int(s)
        end = int(e) if e else file_size - 1
    elif e:
        suffix = int(e)
        start = max(0, file_size - suffix)
        end = file_size - 1
    else:
        return None
    if start > end or start >= file_size or end >= file_size:
        return None
    return start, end


@router.get("/file/{slug}/info")
def file_info(slug: str, db: Session = Depends(get_db)) -> dict:
    link = resolve_active_link(db, slug)
    if link is None:
        raise HTTPException(404, detail="not found")
    f = db.get(FileObject, link.file_id)
    if f is None:
        raise HTTPException(404, detail="not found")
    return {
        "filename": f.original_filename,
        "size_bytes": f.size_bytes,
        "content_type": f.content_type,
        "encryption_mode": f.encryption_mode,
        "compressed": f.compressed,
        "archived": f.archived,
        "lifecycle_state": f.lifecycle_state,
        "max_uses": link.max_uses,
        "use_count": link.use_count,
        "expires_at": link.expires_at.isoformat() if link.expires_at else None,
    }


@router.get("/file/{slug}/raw")
def download_raw(slug: str, request: Request, db: Session = Depends(get_db)):
    from app.storage.paths import safe_join, storage_root

    link = resolve_active_link(db, slug)
    if link is None:
        raise HTTPException(404, detail="not found")
    f = db.get(FileObject, link.file_id)
    if f is None:
        raise HTTPException(404, detail="not found")

    if not consume_use(db, slug):
        raise HTTPException(404, detail="not found")

    try:
        record(db, actor="anonymous", action="file.downloaded",
               target=f"file:{f.id}", ip=client_ip(request))
        db.commit()
    except Exception:
        pass

    try:
        full_path = safe_join(storage_root(), f.storage_path)
    except ValueError:
        raise HTTPException(500, detail="invalid storage path")
    if not full_path.exists():
        raise HTTPException(500, detail="file missing from storage")

    filename = f.original_filename.replace('"', '\\"')
    base_headers = {
        **_SECURITY,
        "Content-Disposition": f'attachment; filename="{filename}"',
        "Accept-Ranges": "bytes",
    }

    needs_decrypt = f.encryption_mode == "server"
    needs_decompress = f.compressed or f.archived

    if needs_decrypt:
        ek_param = request.query_params.get("ek")
        state = request.app.state.app_state
        if ek_param:
            try:
                padding = 4 - len(ek_param) % 4
                key = _b64.urlsafe_b64decode(ek_param + "=" * (padding % 4))
            except Exception:
                raise HTTPException(400, detail="invalid ek parameter")
        elif f.enc_key_blob:
            from app.security.secretbox import open_box
            from app.config import get_master_key
            from app.deps import require_master
            try:
                require_master(db=db)
            except Exception:
                raise HTTPException(403, detail="ek parameter required")
            key = open_box(get_master_key(state.settings), f.enc_key_blob)
        else:
            raise HTTPException(400, detail="ek parameter required")

        from app.crypto.aead import decrypt_stream

        def _encrypted_stream():
            for chunk in decrypt_stream(key, full_path):
                if needs_decompress:
                    pass  # handled below
                yield chunk

        if needs_decompress:
            from app.storage.compress import decompress_stream as _dec
            import tempfile, os

            def _decrypt_decompress_stream():
                tmp = Path(tempfile.mktemp(suffix=".dec"))
                try:
                    with open(tmp, "wb") as fh:
                        for chunk in decrypt_stream(key, full_path):
                            fh.write(chunk)
                    yield from _dec(tmp, f.size_bytes)
                finally:
                    tmp.unlink(missing_ok=True)

            return StreamingResponse(
                _decrypt_decompress_stream(),
                media_type=f.content_type,
                headers={**base_headers, "Content-Length": str(f.size_bytes)},
            )

        return StreamingResponse(
            decrypt_stream(key, full_path),
            media_type=f.content_type,
            headers={**base_headers, "Content-Length": str(f.size_bytes)},
        )

    if needs_decompress:
        if f.archived and not f.auto_unarchive_on_download:
            raise HTTPException(503, detail="file is archived; contact admin to unarchive")
        from app.storage.compress import decompress_stream

        return StreamingResponse(
            decompress_stream(full_path, f.size_bytes),
            media_type=f.content_type,
            headers={**base_headers, "Content-Length": str(f.size_bytes)},
        )

    # Plaintext, uncompressed — Range support available
    file_size = f.stored_size_bytes
    range_header = request.headers.get("range")
    if range_header:
        parsed = _parse_range(range_header, file_size)
        if parsed is None:
            return Response(status_code=416, headers={"Content-Range": f"bytes */{file_size}"})
        start, end = parsed
        length = end - start + 1

        def _range_stream():
            with open(full_path, "rb") as fh:
                fh.seek(start)
                remaining = length
                while remaining > 0:
                    chunk = fh.read(min(_CHUNK, remaining))
                    if not chunk:
                        break
                    remaining -= len(chunk)
                    yield chunk

        return StreamingResponse(
            _range_stream(),
            status_code=206,
            media_type=f.content_type,
            headers={
                **base_headers,
                "Content-Range": f"bytes {start}-{end}/{file_size}",
                "Content-Length": str(length),
            },
        )

    def _stream():
        with open(full_path, "rb") as fh:
            while True:
                chunk = fh.read(_CHUNK)
                if not chunk:
                    break
                yield chunk

    return StreamingResponse(
        _stream(),
        media_type=f.content_type,
        headers={**base_headers, "Content-Length": str(file_size)},
    )


@router.get("/file/{slug}")
def download_page(slug: str, db: Session = Depends(get_db)):
    link = resolve_active_link(db, slug)
    if link is None:
        raise HTTPException(404, detail="link not found or expired")
    return FileResponse(str(_STATIC / "download.html"), headers=_SECURITY)
