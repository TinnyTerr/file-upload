from __future__ import annotations

import base64 as _b64
import html
import logging
import re as _re
import secrets as _secrets
import tempfile
import urllib.parse
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, Response, StreamingResponse
from sqlalchemy.orm import Session

from app.audit.log import record
from app.deps import client_ip, get_db
from app.links.consume import consume_use, resolve_active_link
from app.models.file import FileObject
from app.spa import render_spa
from app.storage.blobs import file_hashes

router = APIRouter(tags=["public"])

_log = logging.getLogger("app.public")


def _recover_missing_blob(request: Request, f: FileObject, full_path) -> bool:
    """If a file's bytes are absent locally (this node never replicated them, or
    is a cache node, or lost them), try to pull them from a peer by content hash.

    This is the read-side of cluster file sharing + failover: as long as one node
    still holds the blob, the download succeeds. Returns True if the bytes are
    present (already, or after a successful peer fetch)."""
    if full_path.exists():
        return True
    from app.models.content_blob import ContentBlob
    from app.cluster.blobs import fetch_blob_from_peers

    state = request.app.state.app_state
    if not f.blob_id:
        return False
    with state.session_factory() as s:
        blob = s.get(ContentBlob, f.blob_id)
        if blob is None or not blob.stored_sha256:
            return False
        stored_sha256 = blob.stored_sha256
        transform_key = blob.transform_key
    try:
        return fetch_blob_from_peers(
            state.session_factory,
            stored_sha256=stored_sha256,
            transform_key=transform_key,
            dest=full_path,
        )
    except Exception:
        _log.warning("peer blob recovery failed for file %s", f.id)
        return False

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
def file_info(slug: str, request: Request, db: Session = Depends(get_db)) -> dict:
    from app.deps import require_active_user, current_session
    link = resolve_active_link(db, slug)
    if link is None:
        raise HTTPException(404, detail="not found")
    f = db.get(FileObject, link.file_id)
    if f is None:
        raise HTTPException(404, detail="not found")

    # Uploader info — only exposed when link.hide_uploader is False
    uploader = None
    if not link.hide_uploader:
        from app.models.user import User
        owner = db.get(User, f.owner_id)
        if owner is not None:
            uploader = {
                "username": owner.username,
                "has_avatar": owner.avatar_data is not None,
                "user_id": owner.id,
            }

    # Whether the authenticated viewer has already saved this file
    already_saved = False
    from app.security.sessions import COOKIE_NAME
    from app.security.sessions import SessionManager
    cookie = request.cookies.get(COOKIE_NAME)
    if cookie:
        state = request.app.state.app_state
        session_row = state.session_manager.resolve(db, cookie)
        if session_row is not None:
            from app.models.file import FileObject as FO
            already_saved = (
                db.query(FO).filter_by(owner_id=session_row.user_id, saved_from_file_id=f.id).first()
                is not None
            ) or f.owner_id == session_row.user_id

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
        "hashes": file_hashes(db, f),
        "uploader": uploader,
        "already_saved": already_saved,
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
    if not _recover_missing_blob(request, f, full_path):
        raise HTTPException(500, detail="file missing from storage")

    needs_decrypt = f.encryption_mode == "server"
    needs_decompress = f.compressed or f.archived

    # Range is only honoured for the plaintext-uncompressed path below; omit
    # Accept-Ranges from transformed responses so clients don't issue fruitless
    # Range requests expecting 206 and get a full 200 instead.
    base_headers = {
        **_SECURITY,
        "Content-Disposition": _content_disposition(f.original_filename),
        **({"Accept-Ranges": "bytes"} if not needs_decrypt and not needs_decompress else {}),
    }

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


def _plain_file_response(request: Request, f: FileObject, *, disposition: str | None = None):
    from app.storage.paths import safe_join, storage_root

    if f.encryption_mode != "none" or f.compressed or f.archived:
        raise HTTPException(403, detail="preview unavailable")
    try:
        full_path = safe_join(storage_root(), f.storage_path)
    except ValueError:
        raise HTTPException(500, detail="invalid storage path")
    if not _recover_missing_blob(request, f, full_path):
        raise HTTPException(500, detail="file missing from storage")

    file_size = f.stored_size_bytes
    headers = {**_SECURITY, "Accept-Ranges": "bytes"}
    if disposition:
        headers["Content-Disposition"] = disposition
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
                **headers,
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
        headers={**headers, "Content-Length": str(file_size)},
    )


@router.get("/file/{slug}/preview")
def preview_file(slug: str, request: Request, db: Session = Depends(get_db)):
    link = resolve_active_link(db, slug)
    if link is None:
        raise HTTPException(404, detail="not found")
    if link.max_uses is not None:
        raise HTTPException(403, detail="limited-use links do not expose previews")
    f = db.get(FileObject, link.file_id)
    if f is None:
        raise HTTPException(404, detail="not found")
    if not (
        f.content_type.startswith("image/")
        or f.content_type.startswith("video/")
        or f.content_type.startswith("audio/")
        or f.content_type == "application/pdf"
        or f.content_type.startswith("text/")
    ):
        raise HTTPException(403, detail="preview unavailable")
    return _plain_file_response(request, f)


def _file_meta_tags(request: Request, slug: str, db: Session) -> str:
    link = resolve_active_link(db, slug)
    if link is None:
        return ""
    f = db.get(FileObject, link.file_id)
    if f is None:
        return ""
    title = html.escape(f.original_filename or "Shared file", quote=True)
    desc = html.escape(f"{f.size_bytes} bytes", quote=True)
    url = html.escape(str(request.url), quote=True)
    tags = [
        f'<meta property="og:title" content="{title}">',
        f'<meta property="og:description" content="{desc}">',
        f'<meta property="og:url" content="{url}">',
        '<meta property="og:type" content="website">',
        f'<meta name="twitter:title" content="{title}">',
        f'<meta name="twitter:description" content="{desc}">',
    ]
    eligible = (
        link.max_uses is None
        and f.encryption_mode == "none"
        and not f.compressed
        and not f.archived
    )
    preview_url = str(request.base_url).rstrip("/") + f"/file/{slug}/preview"
    escaped_preview = html.escape(preview_url, quote=True)
    if eligible and f.content_type.startswith("image/"):
        tags.append(f'<meta property="og:image" content="{escaped_preview}">')
        tags.append('<meta name="twitter:card" content="summary_large_image">')
    elif eligible and f.content_type.startswith("video/"):
        tags.append(f'<meta property="og:video" content="{escaped_preview}">')
        tags.append(f'<meta property="og:video:type" content="{html.escape(f.content_type, quote=True)}">')
    elif eligible and f.content_type.startswith("audio/"):
        tags.append(f'<meta property="og:audio" content="{escaped_preview}">')
        tags.append(f'<meta property="og:audio:type" content="{html.escape(f.content_type, quote=True)}">')
    return "\n".join(tags)


@router.get("/file/{slug}")
def download_page(slug: str, request: Request, db: Session = Depends(get_db)):
    # Always serve the page — the client JS checks /info and shows the same
    # "not found" state for both inactive and nonexistent slugs, so callers
    # cannot distinguish the two. We serve the React SPA shell; the OG meta tags
    # are injected server-side so link unfurlers (which don't run JS) see them.
    content = render_spa(_file_meta_tags(request, slug, db))
    return HTMLResponse(content, headers=_SECURITY)
