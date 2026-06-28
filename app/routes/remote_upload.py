from __future__ import annotations

import http.client
import ipaddress
import logging
import mimetypes
import os
import secrets
import socket
import ssl
import urllib.parse
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.audit.log import record
from app.deps import client_ip, get_db, require_active_user
from app.models.remote_upload_job import RemoteUploadJob
from app.models.session import SessionRow
from app.models.user import User
from app.permissions.policy import ensure_permissions
from app.routes.files import _finalize_stored_file, _used_bytes
from app.security.csrf import require_csrf
from app.storage.paths import storage_root

router = APIRouter(tags=["remote-upload"])
_log = logging.getLogger(__name__)
_CHUNK = 256 * 1024


class RemoteUploadBody(BaseModel):
    url: str = Field(..., max_length=4096)
    original_filename: str | None = Field(None, max_length=1024)


def _is_public_ip(value: str) -> bool:
    ip = ipaddress.ip_address(value)
    return not (
        ip.is_private
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_multicast
        or ip.is_reserved
        or ip.is_unspecified
    )


def validate_public_http_url(url: str) -> urllib.parse.ParseResult:
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise HTTPException(400, detail="only public http/https URLs are allowed")
    try:
        infos = socket.getaddrinfo(parsed.hostname, parsed.port or (443 if parsed.scheme == "https" else 80))
    except OSError:
        raise HTTPException(400, detail="could not resolve remote host")
    for info in infos:
        if not _is_public_ip(info[4][0]):
            raise HTTPException(400, detail="remote host resolves to a private or local address")
    return parsed


def _filename_from_url(parsed: urllib.parse.ParseResult, fallback: str) -> str:
    name = os.path.basename(urllib.parse.unquote(parsed.path or "")) or fallback
    return name[:1024] or fallback


def _open_pinned(parsed: urllib.parse.ParseResult, *, timeout: float) -> tuple[http.client.HTTPConnection, str]:
    """Resolve + validate the host, then connect to the *exact* validated IP.

    Pinning the connection to the address we just checked closes the DNS-rebinding
    TOCTOU: urllib re-resolves the hostname at connect time, so an attacker could
    flip the record to an internal/metadata address between validation and fetch.
    Here the socket is bound to the validated IP while the original hostname is kept
    for the Host header and TLS SNI/certificate verification.
    """
    host = parsed.hostname
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    try:
        infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except OSError:
        raise HTTPException(400, detail="could not resolve remote host")
    if not infos:
        raise HTTPException(400, detail="could not resolve remote host")
    for info in infos:
        if not _is_public_ip(info[4][0]):
            raise HTTPException(400, detail="remote host resolves to a private or local address")
    ip = infos[0][4][0]
    sock = socket.create_connection((ip, port), timeout=timeout)
    if parsed.scheme == "https":
        ctx = ssl.create_default_context()
        sock = ctx.wrap_socket(sock, server_hostname=host)
        conn: http.client.HTTPConnection = http.client.HTTPSConnection(host, port, timeout=timeout)
    else:
        conn = http.client.HTTPConnection(host, port, timeout=timeout)
    # Pre-bind the validated socket so http.client never re-resolves/reconnects.
    conn.sock = sock
    return conn, host


def download_remote_url(url: str, destination: Path, *, max_bytes: int) -> dict:
    current = url
    for _ in range(6):
        parsed = urllib.parse.urlparse(current)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            raise HTTPException(400, detail="only public http/https URLs are allowed")
        conn, _host = _open_pinned(parsed, timeout=15)
        try:
            target = parsed.path or "/"
            if parsed.query:
                target += "?" + parsed.query
            conn.request("GET", target, headers={"User-Agent": "fileupload-remote-fetch/1.0", "Accept": "*/*"})
            response = conn.getresponse()
            status = response.status
            if status in {301, 302, 303, 307, 308}:
                location = response.getheader("location")
                if not location:
                    raise HTTPException(400, detail="remote redirect missing location")
                # Re-validate (and re-pin) the redirect target on the next iteration.
                current = urllib.parse.urljoin(current, location)
                continue
            if status >= 400:
                raise HTTPException(400, detail=f"remote download failed with HTTP {status}")
            length = response.getheader("content-length")
            if length is not None:
                try:
                    if int(length) > max_bytes:
                        raise HTTPException(413, detail="remote file exceeds max file size")
                except ValueError:
                    pass
            written = 0
            with open(destination, "wb") as out:
                while True:
                    chunk = response.read(_CHUNK)
                    if not chunk:
                        break
                    written += len(chunk)
                    if written > max_bytes:
                        raise HTTPException(413, detail="remote file exceeds max file size")
                    out.write(chunk)
            ctype = response.getheader("content-type")
            content_type = (ctype.split(";")[0].strip() if ctype else None) or mimetypes.guess_type(parsed.path)[0]
            return {
                "filename": _filename_from_url(parsed, "remote-upload"),
                "content_type": content_type or "application/octet-stream",
                "size_bytes": written,
            }
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(400, detail=f"remote download failed: {exc}")
        finally:
            conn.close()
    raise HTTPException(400, detail="too many remote redirects")


@router.post("/files/remote-upload")
def remote_upload(
    body: RemoteUploadBody,
    request: Request,
    _csrf: SessionRow = Depends(require_csrf),
    user: User = Depends(require_active_user),
    db: Session = Depends(get_db),
) -> dict:
    validate_public_http_url(body.url)
    perm = ensure_permissions(db, user.id, master=(user.role == "master"))
    rand = secrets.token_hex(32)
    rel_path = f"{rand[:2]}/{rand[2:4]}/{rand[4:]}"
    base_path = storage_root() / rel_path
    base_path.parent.mkdir(parents=True, exist_ok=True)
    work = base_path.with_suffix(".remote.work")

    job = RemoteUploadJob(owner_id=user.id, url=body.url, status="running")
    db.add(job)
    db.flush()
    try:
        meta = download_remote_url(body.url, work, max_bytes=perm.max_file_bytes)
        size = int(meta["size_bytes"])
        if _used_bytes(db, user.id) + size > perm.quota_bytes:
            raise HTTPException(413, detail="remote upload would exceed your quota")
        result = _finalize_stored_file(
            request=request,
            db=db,
            user=user,
            perm=perm,
            directory=None,
            work_path=work,
            rel_path=rel_path,
            stored=size,
            content_type=meta.get("content_type"),
            encryption_mode="none",
            compress=False,
            randomize_filename=False,
            original_filename=body.original_filename or meta.get("filename") or "remote-upload",
            is_permanent=True,
            temp_days=None,
            delete_if_idle_days=None,
            archive_after_idle_days=None,
            auto_unarchive_on_download=True,
            max_uses=None,
            expires_in_seconds=None,
            source_type="remote",
        )
        job.status = "completed"
        job.file_id = result["file_id"]
        job.completed_at = datetime.now(timezone.utc)
        record(db, actor=user.username, action="remote_upload.completed",
               target=f"remote_job:{job.id}", ip=client_ip(request))
        db.commit()
        _log.info("remote upload completed job_id=%s file_id=%s owner_id=%s", job.id, job.file_id, user.id)
        return {"job_id": job.id, "status": job.status, "file_id": job.file_id, **result}
    except Exception as exc:
        work.unlink(missing_ok=True)
        job.status = "failed"
        job.error = getattr(exc, "detail", str(exc))
        job.completed_at = datetime.now(timezone.utc)
        db.commit()
        _log.warning("remote upload failed job_id=%s owner_id=%s error=%s", job.id, user.id, job.error)
        raise


@router.get("/files/remote-upload/{job_id}")
def remote_upload_status(
    job_id: int,
    user: User = Depends(require_active_user),
    db: Session = Depends(get_db),
) -> dict:
    job = db.get(RemoteUploadJob, job_id)
    if job is None:
        raise HTTPException(404, detail="not found")
    if user.role != "master" and job.owner_id != user.id:
        raise HTTPException(403, detail="not your remote upload")
    return {
        "job_id": job.id,
        "status": job.status,
        "file_id": job.file_id,
        "error": job.error,
        "created_at": job.created_at.isoformat(),
        "completed_at": job.completed_at.isoformat() if job.completed_at else None,
    }

