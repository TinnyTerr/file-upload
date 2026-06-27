from __future__ import annotations

import base64 as _b64
import re as _re
import secrets as _secrets
import tempfile
import urllib.parse
from datetime import datetime, timezone
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

# CSP for the download experience. The page decrypts in a Web Worker and renders
# image/video/audio/pdf previews, so worker-src/media-src/img-src/frame-src must
# be allowed. style-src includes 'unsafe-inline' because the page and its scripts
# use inline styles — without it Firefox (which strictly enforces CSP on inline
# styles) floods the console with violations and the page renders unstyled.
_CSP = (
    "default-src 'self'; "
    "script-src 'self'; "
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
    "font-src 'self' https://fonts.gstatic.com; "
    "img-src 'self' data: blob:; "
    "media-src 'self' blob:; "
    "frame-src 'self'; "
    "worker-src 'self' blob:; "
    "connect-src 'self'; "
    "object-src 'none'"
)
_SECURITY = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": _CSP,
}
_CHUNK = 256 * 1024


def _content_disposition(filename: str) -> str:
    # Strip control characters then build RFC 6266 header with both
    # an ASCII fallback (for old clients) and a UTF-8 encoded form.
    cleaned = "".join(c for c in filename if ord(c) >= 0x20)
    ascii_fallback = cleaned.encode("ascii", "replace").decode().replace('"', "_").replace("\\", "_")
    encoded = urllib.parse.quote(cleaned, safe="")
    return f'attachment; filename="{ascii_fallback}"; filename*=UTF-8\'\'{encoded}'


def _verify_access_key(request: Request, f: FileObject, ek: str | None) -> bool:
    """Check the server-mode ?ek= access credential against the sealed value.

    Files encrypted before access credentials existed have no sealed blob; those
    remain downloadable without a key (the server still decrypts them).
    """
    if not f.enc_access_blob:
        return True  # legacy server-encrypted file — no credential required
    if not ek:
        return False
    try:
        from app.security.secretbox import open_box
        from app.config import get_master_key
        state = request.app.state.app_state
        expected = open_box(get_master_key(state.settings), f.enc_access_blob).decode()
    except Exception:
        return False
    return _secrets.compare_digest(ek, expected)


def _parse_range(header: str, file_size: int) -> tuple[int, int] | None:
    m = _re.match(r"bytes=(\d*)-(\d*)$", header.strip())
    if not m:
        return None
    s, e = m.group(1), m.group(2)
    if s:
        start = int(s)
        end = int(e) if e else file_size - 1
        # RFC 7233: an end past the last byte is clamped, not rejected.
        if end >= file_size:
            end = file_size - 1
    elif e:
        suffix = int(e)
        start = max(0, file_size - suffix)
        end = file_size - 1
    else:
        return None
    if start > end or start >= file_size:
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
def download_raw(slug: str, request: Request, ek: str | None = None, db: Session = Depends(get_db)):
    from app.storage.paths import safe_join, storage_root

    link = resolve_active_link(db, slug)
    if link is None:
        raise HTTPException(404, detail="not found")
    f = db.get(FileObject, link.file_id)
    if f is None:
        raise HTTPException(404, detail="not found")

    # Server-side encryption gate: require the ?ek= access credential BEFORE we
    # consume a use, so a wrong/missing key never burns a limited-use download.
    if f.encryption_mode == "server" and not _verify_access_key(request, f, ek):
        raise HTTPException(status_code=401, detail="missing or invalid access key (?ek=)")

    if not consume_use(db, slug):
        raise HTTPException(404, detail="not found")

    # The use was claimed in this same transaction; if the commit fails the
    # increment rolls back too. Serving the file anyway would let a client exceed
    # max_uses, so fail the request instead of silently swallowing the error.
    try:
        f.last_downloaded_at = datetime.now(timezone.utc)
        record(db, actor="anonymous", action="file.downloaded",
               target=f"file:{f.id}", ip=client_ip(request))
        db.commit()
    except Exception:
        db.rollback()
        raise HTTPException(500, detail="could not record download")

    try:
        full_path = safe_join(storage_root(), f.storage_path)
    except ValueError:
        raise HTTPException(500, detail="invalid storage path")
    if not full_path.exists():
        raise HTTPException(500, detail="file missing from storage")

    base_headers = {
        **_SECURITY,
        "Content-Disposition": _content_disposition(f.original_filename),
        "Accept-Ranges": "bytes",
    }

    needs_decrypt = f.encryption_mode == "server"
    needs_decompress = f.compressed or f.archived

    if needs_decrypt:
        import os as _os
        from app.crypto.aead import decrypt_stream as _decrypt_stream
        from app.security.secretbox import open_box
        from app.config import get_master_key
        from starlette.background import BackgroundTask

        if not f.enc_key_blob:
            raise HTTPException(status_code=500, detail="encryption key not stored")
        try:
            state = request.app.state.app_state
            per_file_key = open_box(get_master_key(state.settings), f.enc_key_blob)
        except Exception:
            raise HTTPException(status_code=500, detail="failed to recover encryption key")

        if needs_decompress:
            if f.archived and not f.auto_unarchive_on_download:
                raise HTTPException(503, detail="file is archived; contact admin to unarchive")
            from app.storage.compress import decompress_stream as _dec

            fd1, tmp1_path = tempfile.mkstemp(suffix=".step1")
            tmp1 = Path(tmp1_path)
            _os.close(fd1)
            fd2, tmp2_path = tempfile.mkstemp(suffix=".plain")
            tmp2 = Path(tmp2_path)
            _os.close(fd2)

            # The compression layer can sit on either side of the encryption layer,
            # depending on which stage produced it — so the undo order differs:
            #  · upload-time (f.compressed): stored as ENC(ZSTD(x)) → decrypt, then decompress
            #  · archive job (f.archived):   stored as ZSTD(ENC(x)) → decompress, then decrypt
            # (the archive job skips already-compressed files, so the two never overlap)
            try:
                if f.archived and not f.compressed:
                    with open(tmp1, "wb") as fh:
                        for chunk in _dec(full_path, f.size_bytes):
                            fh.write(chunk)
                    with open(tmp2, "wb") as fh:
                        for chunk in _decrypt_stream(per_file_key, tmp1):
                            fh.write(chunk)
                else:
                    with open(tmp1, "wb") as fh:
                        for chunk in _decrypt_stream(per_file_key, full_path):
                            fh.write(chunk)
                    with open(tmp2, "wb") as fh:
                        for chunk in _dec(tmp1, f.size_bytes):
                            fh.write(chunk)
            except Exception:
                tmp1.unlink(missing_ok=True)
                tmp2.unlink(missing_ok=True)
                raise HTTPException(500, detail="failed to recover file contents")
            tmp1.unlink(missing_ok=True)

            return FileResponse(
                str(tmp2),
                media_type=f.content_type or "application/octet-stream",
                headers=base_headers,
                background=BackgroundTask(lambda p=tmp2: p.unlink(missing_ok=True)),
            )

        fd, tmp_path = tempfile.mkstemp(suffix=".dec")
        tmp = Path(tmp_path)
        _os.close(fd)
        try:
            with open(tmp, "wb") as fh:
                for chunk in _decrypt_stream(per_file_key, full_path):
                    fh.write(chunk)
        except Exception:
            tmp.unlink(missing_ok=True)
            raise HTTPException(500, detail="decryption failed")

        return FileResponse(
            str(tmp),
            media_type=f.content_type or "application/octet-stream",
            headers=base_headers,
            background=BackgroundTask(lambda p=tmp: p.unlink(missing_ok=True)),
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
            return Response(
                status_code=416,
                headers={**_SECURITY, "Accept-Ranges": "bytes", "Content-Range": f"bytes */{file_size}"},
            )
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
def download_page(slug: str):
    # Always serve the page — the client JS checks /info and shows the same
    # "not found" state for both inactive and nonexistent slugs, so callers
    # cannot distinguish the two.
    return FileResponse(str(_STATIC / "download.html"), headers=_SECURITY)
