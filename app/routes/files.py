from __future__ import annotations

import base64
import json
import os
import secrets as _secrets
import shutil
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, Form, HTTPException, Request, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.audit.log import record
from app.deps import client_ip, get_db, get_upload_user, require_active_user, require_master, require_permission
from app.links.slugs import new_slug
from app.models.file import FileObject
from app.models.link import Link
from app.models.session import SessionRow
from app.models.user import User
from app.permissions.policy import ensure_permissions
from app.security.csrf import require_csrf
from app.storage.paths import safe_join, storage_root

_UNSAFE_CT = frozenset({
    "text/html", "text/xhtml", "text/xhtml+xml",
    "image/svg+xml", "application/xhtml+xml",
})

_NO_ENCRYPT_COMPRESS = frozenset({"client"})  # ciphertext won't shrink

router = APIRouter(tags=["files"])

_CHUNK = 256 * 1024  # 256 KiB read buffer
_REQUEST_OVERHEAD_ALLOWANCE = 1024 * 1024

# Chunked uploads exist to dodge Cloudflare's ~100 MB edge body cap (it returns a
# 413 before the request ever reaches us). The browser slices the file into pieces
# well under that cap; we reassemble them on disk and run the normal pipeline.
_CHUNK_UPLOAD_SIZE = 16 * 1024 * 1024  # 16 MiB per chunk — comfortably under CF's cap
_CHUNK_SESSION_TTL = 12 * 3600  # seconds an in-progress chunked upload may live
# Sealed-token AAD so a token minted for chunked upload can't be repurposed.
_CHUNK_TOKEN_AAD = b"chunked-upload-v1"


def _used_bytes(db: Session, user_id: int) -> int:
    result = db.query(func.sum(FileObject.stored_size_bytes)).filter_by(owner_id=user_id).scalar()
    return result or 0


def _file_url(request: Request, slug: str) -> str:
    base = str(request.base_url).rstrip("/")
    return f"{base}/file/{slug}"


def _randomized_filename(original_filename: str) -> str:
    basename = os.path.basename(original_filename.replace("\\", "/")).strip()
    _, ext = os.path.splitext(basename)
    if not ext[1:].isalnum() or len(ext) > 17:
        ext = ""
    return f"{_secrets.token_hex(16)}{ext.lower()}"


def _prepare_upload(
    db: Session,
    user: User,
    *,
    encryption_mode: str,
    compress: bool,
    is_permanent: bool,
    temp_days: Optional[int],
    randomize_filename: bool,
    directory_id: Optional[int],
):
    """Validate upload metadata + resolve the target directory, applying bundle
    overrides. Shared by the single-shot and chunked upload entry points. Returns
    the (possibly overridden) params plus the resolved directory and permissions."""
    from app.models.directory import Directory

    if encryption_mode not in ("none", "server", "client"):
        raise HTTPException(400, detail="invalid encryption_mode")

    # Uploading into a directory bundle: the directory dictates the encryption
    # mode (one shared key for every member) and overrides per-file lifecycle —
    # compression is skipped so the bundle-zip path stays simple, and members are
    # permanent (the directory itself governs expiry).
    directory: Directory | None = None
    if directory_id is not None:
        directory = db.get(Directory, directory_id)
        if directory is None:
            raise HTTPException(404, detail="directory not found")
        if user.role != "master" and directory.owner_id != user.id:
            raise HTTPException(403, detail="not your directory")
        encryption_mode = directory.encryption_mode
        compress = False
        is_permanent = True
        temp_days = None
        randomize_filename = False

    if not is_permanent and not temp_days:
        raise HTTPException(400, detail="temp_days is required when is_permanent is false")

    perm = ensure_permissions(db, user.id, master=(user.role == "master"))

    if encryption_mode == "client" and not perm.can_upload_client_encrypted:
        raise HTTPException(403, detail="client-side encryption not permitted")

    return encryption_mode, compress, is_permanent, temp_days, randomize_filename, directory, perm


def _precheck_declared_size(db: Session, user: User, perm, declared: int) -> None:
    """Reject obviously-too-big uploads up front, before any bytes are stored."""
    if declared > perm.max_file_bytes + _REQUEST_OVERHEAD_ALLOWANCE:
        raise HTTPException(413, detail="file exceeds max file size")
    if _used_bytes(db, user.id) + declared > perm.quota_bytes + _REQUEST_OVERHEAD_ALLOWANCE:
        raise HTTPException(413, detail="upload would exceed your quota")


def _finalize_stored_file(
    *,
    request: Request,
    db: Session,
    user: User,
    perm,
    directory,
    work_path: Path,
    rel_path: str,
    stored: int,
    content_type: str | None,
    encryption_mode: str,
    compress: bool,
    randomize_filename: bool,
    original_filename: str,
    is_permanent: bool,
    temp_days: Optional[int],
    delete_if_idle_days: Optional[int],
    archive_after_idle_days: Optional[int],
    auto_unarchive_on_download: bool,
    max_uses: Optional[int],
    expires_in_seconds: Optional[int],
) -> dict:
    """Take a fully-assembled upload sitting at `work_path` and run the rest of the
    pipeline: quota check, optional compression, DB record, optional server-side
    encryption, link minting. Identical for single-shot and chunked uploads."""
    from app.crypto.aead import encrypt_file as _encrypt_file
    from app.storage.compress import compress_file as _compress_file, should_compress
    from app.security.secretbox import seal, open_box
    from app.config import get_master_key

    base_path = storage_root() / rel_path
    directory_id = directory.id if directory is not None else None

    if _used_bytes(db, user.id) + stored > perm.quota_bytes:
        work_path.unlink(missing_ok=True)
        raise HTTPException(413, detail="upload would exceed your quota")

    size_bytes = stored
    file_compressed = False
    current = work_path

    try:
        # Compression (only for non-client-encrypted modes and eligible types)
        ct = (content_type or "application/octet-stream").lower().split(";")[0].strip()
        if ct in _UNSAFE_CT:
            ct = "application/octet-stream"

        if compress and encryption_mode != "client" and should_compress(ct):
            compressed = base_path.with_suffix(".zst.work")
            _compress_file(current, compressed)
            current.unlink()
            current = compressed
            file_compressed = True

        # Create DB record (need ID before server-side encryption)
        display_name = _randomized_filename(original_filename) if randomize_filename else original_filename
        expires_at: datetime | None = None
        if not is_permanent and temp_days:
            try:
                expires_at = datetime.now(timezone.utc) + timedelta(days=temp_days)
            except OverflowError:
                raise HTTPException(400, detail="temp_days is too large")

        file_obj = FileObject(
            owner_id=user.id,
            directory_id=directory_id,
            storage_path=rel_path,
            original_filename=display_name,
            size_bytes=size_bytes,
            stored_size_bytes=0,
            content_type=ct,
            encryption_mode=encryption_mode,
            compressed=file_compressed,
            is_permanent=is_permanent,
            expires_at=expires_at,
            delete_if_idle_days=delete_if_idle_days,
            archive_after_idle_days=archive_after_idle_days,
            auto_unarchive_on_download=auto_unarchive_on_download,
        )
        db.add(file_obj)
        db.flush()

        enc_key_blob_val: bytes | None = None
        enc_access_blob_val: bytes | None = None
        access_key: str | None = None

        # Server-side encryption
        if encryption_mode == "server":
            state = request.app.state.app_state
            master_key = get_master_key(state.settings)
            if directory is not None:
                # Reuse the directory's single shared key + access credential so
                # one ?ek= unlocks the whole bundle — no per-file key bloat.
                if not directory.enc_key_blob:
                    raise HTTPException(500, detail="directory key missing")
                per_file_key = open_box(master_key, directory.enc_key_blob)
                enc_key_blob_val = directory.enc_key_blob
                enc_access_blob_val = directory.enc_access_blob
            else:
                per_file_key = _secrets.token_bytes(32)
                # Access credential: the ?ek= value the downloader must present. The
                # server holds the real decryption key above; this is the gate that
                # requires the user to know the key. Sealed so owners/admins can
                # recover the shareable URL later.
                access_key = _secrets.token_urlsafe(18)
                enc_key_blob_val = seal(master_key, per_file_key)
                enc_access_blob_val = seal(master_key, access_key.encode())
            encrypted = base_path.with_suffix(".fupl.work")
            _encrypt_file(per_file_key, current, encrypted)
            current.unlink()
            current = encrypted

        # Finalize: rename work file to storage path
        current.rename(base_path)
        file_obj.stored_size_bytes = base_path.stat().st_size
        file_obj.enc_key_blob = enc_key_blob_val
        file_obj.enc_access_blob = enc_access_blob_val

        # Link minting + commit live INSIDE the try so a DB failure here also
        # triggers the on-disk cleanup below — otherwise base_path (already
        # renamed into place) would leak when the transaction rolls back.
        expires_link: datetime | None = None
        link_max_uses = max_uses
        if directory is not None:
            # Bundle members are reached through the directory page, not a capped
            # per-file link, so they get an uncapped link and the directory tally grows.
            link_max_uses = None
            directory.total_bytes = (directory.total_bytes or 0) + file_obj.stored_size_bytes
        elif expires_in_seconds is not None:
            try:
                expires_link = datetime.now(timezone.utc) + timedelta(seconds=expires_in_seconds)
            except OverflowError:
                raise HTTPException(400, detail="expires_in_seconds is too large")

        slug = new_slug()
        link = Link(file_id=file_obj.id, slug=slug, max_uses=link_max_uses, expires_at=expires_link)
        db.add(link)

        record(db, actor=user.username, action="file.uploaded",
               target=f"file:{file_obj.id}", ip=client_ip(request))
        db.commit()

    except Exception:
        for p in [work_path, base_path.with_suffix(".zst.work"), base_path.with_suffix(".fupl.work"), base_path]:
            p.unlink(missing_ok=True)
        db.rollback()
        raise

    base_url = _file_url(request, slug)
    raw_url = base_url + "/raw"

    return {
        "file_id": file_obj.id,
        "slug": slug,
        "url": base_url,
        "raw_url": raw_url,
        # Server-mode access credential. The downloader appends ?ek=<access_key>;
        # client-mode keys are generated in the browser and never returned here.
        "access_key": access_key,
        "encryption_mode": encryption_mode,
        "max_uses": max_uses,
        "expires_at": expires_link.isoformat() if expires_link else None,
        "compressed": file_compressed,
    }


@router.post("/files/upload")
async def upload_file(
    request: Request,
    file: UploadFile,
    original_filename: str = Form(..., max_length=1024),
    max_uses: Optional[int] = Form(None, ge=1),
    expires_in_seconds: Optional[int] = Form(None, ge=1),
    encryption_mode: str = Form("none"),
    compress: bool = Form(False),
    is_permanent: bool = Form(True),
    temp_days: Optional[int] = Form(None, ge=1),
    delete_if_idle_days: Optional[int] = Form(None, ge=1),
    archive_after_idle_days: Optional[int] = Form(None, ge=1),
    auto_unarchive_on_download: bool = Form(True),
    randomize_filename: bool = Form(False),
    directory_id: Optional[int] = Form(None, ge=1),
    user: User = Depends(get_upload_user),
    db: Session = Depends(get_db),
) -> dict:
    (encryption_mode, compress, is_permanent, temp_days,
     randomize_filename, directory, perm) = _prepare_upload(
        db, user,
        encryption_mode=encryption_mode, compress=compress, is_permanent=is_permanent,
        temp_days=temp_days, randomize_filename=randomize_filename, directory_id=directory_id,
    )

    content_length = request.headers.get("content-length")
    if content_length:
        _precheck_declared_size(db, user, perm, int(content_length))

    rand = _secrets.token_hex(32)
    rel_path = f"{rand[:2]}/{rand[2:4]}/{rand[4:]}"
    base_path = storage_root() / rel_path
    base_path.parent.mkdir(parents=True, exist_ok=True)
    work = base_path.with_suffix(".work")

    stored = 0
    try:
        with open(work, "wb") as fh:
            while True:
                chunk = await file.read(_CHUNK)
                if not chunk:
                    break
                stored += len(chunk)
                if stored > perm.max_file_bytes:
                    raise HTTPException(413, detail="file exceeds max file size")
                fh.write(chunk)
    except Exception:
        # Any failure mid-read (size cap, connection reset, I/O error) must clean
        # up the partial .work file — not just HTTPException.
        work.unlink(missing_ok=True)
        raise

    return _finalize_stored_file(
        request=request, db=db, user=user, perm=perm, directory=directory,
        work_path=work, rel_path=rel_path, stored=stored,
        content_type=file.content_type,
        encryption_mode=encryption_mode, compress=compress,
        randomize_filename=randomize_filename, original_filename=original_filename,
        is_permanent=is_permanent, temp_days=temp_days,
        delete_if_idle_days=delete_if_idle_days,
        archive_after_idle_days=archive_after_idle_days,
        auto_unarchive_on_download=auto_unarchive_on_download,
        max_uses=max_uses, expires_in_seconds=expires_in_seconds,
    )


# ── Chunked uploads ─────────────────────────────────────────────────────────
# A whole-file POST dies at Cloudflare's ~100 MB edge cap (413, never reaches us).
# So the browser slices big files into <100 MB chunks and drives this 3-step flow:
#   1. POST /files/upload/init      → validate, allocate a .part file, mint a token
#   2. POST /files/upload/chunk     → append raw bytes (one request per slice)
#   3. POST /files/upload/finalize  → assemble + run the normal upload pipeline
# All session state lives inside the sealed token (no DB row, no in-memory map);
# progress is just the .part file's size on disk.

def _master_key(request: Request) -> bytes:
    from app.config import get_master_key
    return get_master_key(request.app.state.app_state.settings)


def _seal_chunk_token(request: Request, meta: dict) -> str:
    from app.security.secretbox import seal
    raw = json.dumps(meta, separators=(",", ":")).encode()
    return base64.urlsafe_b64encode(seal(_master_key(request), raw, _CHUNK_TOKEN_AAD)).decode()


def _open_chunk_token(request: Request, token: str, user: User) -> dict:
    """Decrypt + authenticate a chunk-upload token. Raises 400/403/410 on bad,
    foreign, or expired tokens."""
    from app.security.secretbox import open_box
    try:
        blob = base64.urlsafe_b64decode(token.encode())
        meta = json.loads(open_box(_master_key(request), blob, _CHUNK_TOKEN_AAD))
    except Exception:
        raise HTTPException(400, detail="invalid upload token")
    if meta.get("uid") != user.id:
        raise HTTPException(403, detail="not your upload")
    if meta.get("exp", 0) < time.time():
        # Best-effort cleanup of the abandoned partial before refusing.
        try:
            shutil.rmtree(_parts_dir(meta["rel"]), ignore_errors=True)
            (storage_root() / meta["rel"]).with_suffix(".part").unlink(missing_ok=True)
        except Exception:
            pass
        raise HTTPException(410, detail="upload session expired")
    return meta


def _chunk_upload_size() -> int:
    """Bytes per chunk the client should use. Tunable via FILEUPLOAD_CHUNK_SIZE so
    ops can match it to the reverse proxy's body limit without a code change; must
    stay under Cloudflare's edge cap. Read per-init so it can change without restart."""
    raw = os.environ.get("FILEUPLOAD_CHUNK_SIZE")
    if raw:
        try:
            v = int(raw)
            if v > 0:
                return v
        except ValueError:
            pass
    return _CHUNK_UPLOAD_SIZE


def _parts_dir(rel_path: str) -> Path:
    """Per-upload directory holding one file per received chunk (named by index).
    Independent files let chunks land in parallel and out of order, and surviving
    files double as the resume manifest."""
    return (storage_root() / rel_path).with_suffix(".parts")


def _num_chunks(total: int, chunk_size: int) -> int:
    if total <= 0 or chunk_size <= 0:
        return 0
    return (total + chunk_size - 1) // chunk_size


def _expected_chunk_len(index: int, total: int, chunk_size: int, n: int) -> int:
    """Exact byte length chunk `index` must have (the last one is the remainder).
    Returns -1 for an out-of-range index. Enforcing exact lengths keeps assembly
    deterministic and stops a client from inflating the file past `total`."""
    if index < 0 or index >= n:
        return -1
    if index < n - 1:
        return chunk_size
    return total - (n - 1) * chunk_size


def _received_indices(parts: Path, n: int) -> list[int]:
    out: list[int] = []
    try:
        for entry in parts.iterdir():
            if entry.name.isdigit():
                i = int(entry.name)
                if 0 <= i < n:
                    out.append(i)
    except OSError:
        pass
    return sorted(out)


def _sweep_stale_parts() -> None:
    """Drop chunk dirs / assembly files left behind by abandoned uploads. A live
    upload keeps touching its .parts dir, so its mtime stays fresh and it survives."""
    cutoff = time.time() - _CHUNK_SESSION_TTL
    root = storage_root()
    try:
        for p in root.rglob("*.parts"):
            try:
                if p.is_dir() and p.stat().st_mtime < cutoff:
                    shutil.rmtree(p, ignore_errors=True)
            except OSError:
                pass
        for p in root.rglob("*.part"):
            try:
                if p.is_file() and p.stat().st_mtime < cutoff:
                    p.unlink(missing_ok=True)
            except OSError:
                pass
        # Single-shot uploads that died mid-write leave a stale .work file behind;
        # sweep those too (the live-upload window is far under the TTL cutoff).
        for p in root.rglob("*.work"):
            try:
                if p.is_file() and p.stat().st_mtime < cutoff:
                    p.unlink(missing_ok=True)
            except OSError:
                pass
    except OSError:
        pass


class ChunkedInitBody(BaseModel):
    original_filename: str = Field(..., max_length=1024)
    total_size: int = Field(..., ge=0)
    content_type: Optional[str] = None
    max_uses: Optional[int] = Field(None, ge=1)
    expires_in_seconds: Optional[int] = Field(None, ge=1)
    encryption_mode: str = "none"
    compress: bool = False
    is_permanent: bool = True
    temp_days: Optional[int] = Field(None, ge=1)
    delete_if_idle_days: Optional[int] = Field(None, ge=1)
    archive_after_idle_days: Optional[int] = Field(None, ge=1)
    auto_unarchive_on_download: bool = True
    randomize_filename: bool = False
    directory_id: Optional[int] = Field(None, ge=1)


class ChunkedFinalizeBody(BaseModel):
    upload_id: str


@router.post("/files/upload/init")
def upload_init(
    body: ChunkedInitBody,
    request: Request,
    user: User = Depends(get_upload_user),
    db: Session = Depends(get_db),
) -> dict:
    # NOTE: stale-part sweeping runs on the scheduler (see main.py), not here —
    # an rglob over the whole storage root on every upload init was needless I/O
    # amplification on the hot path under concurrent uploads.

    (encryption_mode, compress, is_permanent, temp_days,
     randomize_filename, directory, perm) = _prepare_upload(
        db, user,
        encryption_mode=body.encryption_mode, compress=body.compress,
        is_permanent=body.is_permanent, temp_days=body.temp_days,
        randomize_filename=body.randomize_filename, directory_id=body.directory_id,
    )

    _precheck_declared_size(db, user, perm, body.total_size)

    chunk_size = _chunk_upload_size()
    n = _num_chunks(body.total_size, chunk_size)

    rand = _secrets.token_hex(32)
    rel_path = f"{rand[:2]}/{rand[2:4]}/{rand[4:]}"
    base_path = storage_root() / rel_path
    base_path.parent.mkdir(parents=True, exist_ok=True)
    _parts_dir(rel_path).mkdir(parents=True, exist_ok=True)

    meta = {
        "v": 1,
        "uid": user.id,
        "rel": rel_path,
        "total": body.total_size,
        "cs": chunk_size,
        "n": n,
        "fn": body.original_filename,
        "ct": body.content_type,
        "enc": encryption_mode,
        "cmp": compress,
        "perm": is_permanent,
        "td": temp_days,
        "did": body.delete_if_idle_days,
        "aaid": body.archive_after_idle_days,
        "auod": body.auto_unarchive_on_download,
        "rnd": randomize_filename,
        "dir": directory.id if directory is not None else None,
        "mu": body.max_uses,
        "eis": body.expires_in_seconds,
        "exp": int(time.time()) + _CHUNK_SESSION_TTL,
    }
    return {
        "upload_id": _seal_chunk_token(request, meta),
        "chunk_size": chunk_size,
        "num_chunks": n,
        "total": body.total_size,
        "received": [],
    }


@router.get("/files/upload/status")
def upload_status(
    request: Request,
    upload_id: str,
    user: User = Depends(get_upload_user),
    db: Session = Depends(get_db),
) -> dict:
    """Which chunks already landed — lets a client resume instead of restarting."""
    meta = _open_chunk_token(request, upload_id, user)
    parts = _parts_dir(meta["rel"])
    if not parts.exists():
        raise HTTPException(410, detail="upload session gone")
    n = int(meta["n"])
    return {
        "upload_id": upload_id,
        "total": int(meta["total"]),
        "chunk_size": int(meta["cs"]),
        "num_chunks": n,
        "received": _received_indices(parts, n),
    }


@router.post("/files/upload/chunk")
async def upload_chunk(
    request: Request,
    upload_id: str,
    index: int,
    user: User = Depends(get_upload_user),
    db: Session = Depends(get_db),
) -> dict:
    meta = _open_chunk_token(request, upload_id, user)

    parts = _parts_dir(meta["rel"])
    if not parts.exists():
        raise HTTPException(410, detail="upload session gone")

    total, cs, n = int(meta["total"]), int(meta["cs"]), int(meta["n"])
    expected = _expected_chunk_len(index, total, cs, n)
    if expected < 0:
        raise HTTPException(400, detail="invalid chunk index")

    # Stream into a unique temp name, then atomically swap into place. A chunk only
    # "counts" once fully written, so a dropped connection mid-chunk just gets retried
    # — never a half-written chunk masquerading as complete. Re-uploading is idempotent.
    tmp = parts / f"{index}.{_secrets.token_hex(8)}.tmp"
    written = 0
    try:
        with open(tmp, "wb") as fh:
            async for data in request.stream():
                if not data:
                    continue
                written += len(data)
                if written > expected:
                    raise HTTPException(413, detail="chunk exceeds expected size")
                fh.write(data)
        if written != expected:
            raise HTTPException(400, detail="incomplete chunk")
        os.replace(tmp, parts / str(index))
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise

    return {"index": index, "num_chunks": n}


@router.post("/files/upload/finalize")
def upload_finalize(
    body: ChunkedFinalizeBody,
    request: Request,
    user: User = Depends(get_upload_user),
    db: Session = Depends(get_db),
) -> dict:
    meta = _open_chunk_token(request, body.upload_id, user)

    rel_path = meta["rel"]
    parts = _parts_dir(rel_path)
    if not parts.exists():
        raise HTTPException(410, detail="upload session gone")

    total, n = int(meta["total"]), int(meta["n"])
    received = set(_received_indices(parts, n))
    missing = [i for i in range(n) if i not in received]
    if missing:
        # Keep the parts so the client can resume the gaps; just report what's left.
        raise HTTPException(409, detail={"error": "upload incomplete", "missing": missing[:512]})

    # Assemble the chunks (in order) into the single work file the normal pipeline expects.
    work = (storage_root() / rel_path).with_suffix(".part")
    try:
        with open(work, "wb") as out:
            for i in range(n):
                with open(parts / str(i), "rb") as pf:
                    shutil.copyfileobj(pf, out, length=1024 * 1024)
        stored = work.stat().st_size
        if stored != total:
            work.unlink(missing_ok=True)
            raise HTTPException(400, detail="assembled size mismatch")
    except HTTPException:
        raise
    except OSError:
        work.unlink(missing_ok=True)
        raise HTTPException(500, detail="assembly failed")

    # The directory may have been deleted while the upload was in flight; re-resolve
    # so the bundle branch (shared key / total_bytes) still operates on a live row.
    directory = None
    if meta.get("dir") is not None:
        from app.models.directory import Directory
        directory = db.get(Directory, meta["dir"])
        if directory is None:
            work.unlink(missing_ok=True)
            raise HTTPException(404, detail="directory not found")
        if user.role != "master" and directory.owner_id != user.id:
            work.unlink(missing_ok=True)
            raise HTTPException(403, detail="not your directory")

    perm = ensure_permissions(db, user.id, master=(user.role == "master"))

    result = _finalize_stored_file(
        request=request, db=db, user=user, perm=perm, directory=directory,
        work_path=work, rel_path=rel_path, stored=stored,
        content_type=meta.get("ct"),
        encryption_mode=meta["enc"], compress=meta["cmp"],
        randomize_filename=meta["rnd"], original_filename=meta["fn"],
        is_permanent=meta["perm"], temp_days=meta.get("td"),
        delete_if_idle_days=meta.get("did"),
        archive_after_idle_days=meta.get("aaid"),
        auto_unarchive_on_download=meta.get("auod", True),
        max_uses=meta.get("mu"), expires_in_seconds=meta.get("eis"),
    )
    # Pipeline committed — the raw chunks are now redundant.
    shutil.rmtree(parts, ignore_errors=True)
    return result


@router.delete("/files/upload")
def upload_abort(
    request: Request,
    upload_id: str,
    user: User = Depends(get_upload_user),
    db: Session = Depends(get_db),
) -> dict:
    """Let the client discard a partial upload it gave up on."""
    meta = _open_chunk_token(request, upload_id, user)
    shutil.rmtree(_parts_dir(meta["rel"]), ignore_errors=True)
    (storage_root() / meta["rel"]).with_suffix(".part").unlink(missing_ok=True)
    return {"status": "aborted"}


def _recover_access_key(request: Request, f: FileObject) -> str | None:
    """Decrypt the sealed server-mode access credential, if any."""
    if f.encryption_mode != "server" or not f.enc_access_blob:
        return None
    try:
        from app.security.secretbox import open_box
        from app.config import get_master_key
        state = request.app.state.app_state
        return open_box(get_master_key(state.settings), f.enc_access_blob).decode()
    except Exception:
        return None


@router.get("/files/")
def list_files(
    request: Request,
    user: User = Depends(require_active_user),
    db: Session = Depends(get_db),
) -> dict:
    # Loose files only — directory members are listed under their directory.
    files = (
        db.query(FileObject)
        .filter(FileObject.directory_id.is_(None), FileObject.owner_id == user.id)
        .order_by(FileObject.created_at.desc())
        .all()
    )
    return {"files": _serialize_files(request, db, files)}


@router.get("/admin/files")
def list_admin_files(
    request: Request,
    _master: User = Depends(require_master),
    db: Session = Depends(get_db),
) -> dict:
    files = (
        db.query(FileObject)
        .filter(FileObject.directory_id.is_(None))
        .order_by(FileObject.created_at.desc())
        .all()
    )
    return {"files": _serialize_files(request, db, files)}


def _serialize_files(request: Request, db: Session, files: list[FileObject]) -> list[dict]:
    result = []
    for f in files:
        links = db.query(Link).filter_by(file_id=f.id).all()
        result.append({
            "id": f.id,
            "owner_id": f.owner_id,
            "original_filename": f.original_filename,
            "size_bytes": f.size_bytes,
            "stored_size_bytes": f.stored_size_bytes,
            "content_type": f.content_type,
            "encryption_mode": f.encryption_mode,
            "compressed": f.compressed,
            "archived": f.archived,
            "lifecycle_state": f.lifecycle_state,
            "is_permanent": f.is_permanent,
            "expires_at": f.expires_at.isoformat() if f.expires_at else None,
            "last_downloaded_at": f.last_downloaded_at.isoformat() if f.last_downloaded_at else None,
            # Only set for server-mode files; lets the owner/admin rebuild the
            # ?ek= share URL. Client-mode keys are unrecoverable by design.
            "access_key": _recover_access_key(request, f),
            "created_at": f.created_at.isoformat(),
            "links": [
                {
                    "id": lk.id,
                    "slug": lk.slug,
                    "max_uses": lk.max_uses,
                    "use_count": lk.use_count,
                    "expires_at": lk.expires_at.isoformat() if lk.expires_at else None,
                    "active": lk.active,
                }
                for lk in links
            ],
        })
    return result


@router.delete("/files/{file_id}")
def delete_file(
    file_id: int,
    request: Request,
    _csrf: SessionRow = Depends(require_csrf),
    user: User = Depends(require_permission("can_delete")),
    db: Session = Depends(get_db),
) -> dict:
    file_obj = db.get(FileObject, file_id)
    if file_obj is None:
        raise HTTPException(404, detail="not found")
    if user.role != "master" and file_obj.owner_id != user.id:
        raise HTTPException(403, detail="not your file")

    db.query(Link).filter_by(file_id=file_obj.id).delete()
    if file_obj.directory_id is not None:
        from app.models.directory import Directory
        directory = db.get(Directory, file_obj.directory_id)
        if directory is not None:
            directory.total_bytes = max(0, (directory.total_bytes or 0) - (file_obj.stored_size_bytes or 0))

    # Resolve the path before committing, but only unlink AFTER the DB delete is
    # durable — otherwise a commit failure would leave a registered file whose
    # bytes are already gone from disk.
    try:
        full_path = safe_join(storage_root(), file_obj.storage_path)
    except ValueError:
        full_path = None

    db.delete(file_obj)
    record(db, actor=user.username, action="file.deleted",
           target=f"file:{file_id}", ip=client_ip(request))
    db.commit()

    if full_path is not None:
        try:
            if full_path.exists():
                os.unlink(full_path)
        except OSError:
            pass
    return {"status": "deleted"}


class MintLinkBody(BaseModel):
    max_uses: int | None = None
    expires_in_seconds: int | None = None

    from pydantic import field_validator
    @field_validator("max_uses", "expires_in_seconds", mode="before")
    @classmethod
    def _positive(cls, v):
        if v is not None and v < 1:
            raise ValueError("must be >= 1")
        return v


class EditLinkBody(BaseModel):
    max_uses: int | None = None
    expires_in_seconds: int | None = None
    active: bool | None = None


@router.post("/files/{file_id}/links")
def mint_link(
    file_id: int,
    body: MintLinkBody,
    request: Request,
    _csrf: SessionRow = Depends(require_csrf),
    user: User = Depends(require_permission("can_regenerate_links")),
    db: Session = Depends(get_db),
) -> dict:
    file_obj = db.get(FileObject, file_id)
    if file_obj is None:
        raise HTTPException(404, detail="not found")
    if user.role != "master" and file_obj.owner_id != user.id:
        raise HTTPException(403, detail="not your file")

    expires_at: datetime | None = None
    if body.expires_in_seconds is not None:
        try:
            expires_at = datetime.now(timezone.utc) + timedelta(seconds=body.expires_in_seconds)
        except OverflowError:
            raise HTTPException(400, detail="expires_in_seconds is too large")

    slug = new_slug()
    link = Link(file_id=file_id, slug=slug, max_uses=body.max_uses, expires_at=expires_at)
    db.add(link)
    db.flush()

    record(db, actor=user.username, action="link.created",
           target=f"link:{link.id}", ip=client_ip(request))
    db.commit()

    return {
        "slug": slug,
        "url": _file_url(request, slug),
        "raw_url": _file_url(request, slug) + "/raw",
        # So the UI can build a complete, ready-to-share link. Server-mode keys
        # are recoverable; client-mode keys never leave the uploader's browser.
        "encryption_mode": file_obj.encryption_mode,
        "access_key": _recover_access_key(request, file_obj),
    }


@router.delete("/links/{link_id}")
def deactivate_link(
    link_id: int,
    request: Request,
    _csrf: SessionRow = Depends(require_csrf),
    user: User = Depends(require_active_user),
    db: Session = Depends(get_db),
) -> dict:
    link = db.get(Link, link_id)
    if link is None:
        raise HTTPException(404, detail="not found")
    file_obj = db.get(FileObject, link.file_id)
    if file_obj is None or (user.role != "master" and file_obj.owner_id != user.id):
        raise HTTPException(403, detail="not your file")
    link.active = False
    record(db, actor=user.username, action="link.deactivated",
           target=f"link:{link_id}", ip=client_ip(request))
    db.commit()
    return {"status": "deactivated"}


@router.patch("/links/{link_id}")
def edit_link(
    link_id: int,
    body: EditLinkBody,
    request: Request,
    _csrf: SessionRow = Depends(require_csrf),
    user: User = Depends(require_permission("can_regenerate_links")),
    db: Session = Depends(get_db),
) -> dict:
    link = db.get(Link, link_id)
    if link is None:
        raise HTTPException(404, detail="not found")
    file_obj = db.get(FileObject, link.file_id)
    if file_obj is None or (user.role != "master" and file_obj.owner_id != user.id):
        raise HTTPException(403, detail="not your file")

    # max_uses: only update when explicitly provided
    if body.max_uses is not None:
        link.max_uses = body.max_uses
    if body.expires_in_seconds is not None:
        try:
            link.expires_at = datetime.now(timezone.utc) + timedelta(seconds=body.expires_in_seconds)
        except OverflowError:
            raise HTTPException(400, detail="expires_in_seconds is too large")
    if body.active is not None:
        link.active = body.active

    record(db, actor=user.username, action="link.edited",
           target=f"link:{link_id}", ip=client_ip(request))
    db.commit()
    return {"status": "updated"}


@router.get("/files/disk-stats")
def disk_stats(
    user: User = Depends(require_master),
    db: Session = Depends(get_db),
) -> dict:
    total_bytes = db.query(func.sum(FileObject.stored_size_bytes)).scalar() or 0
    total_files = db.query(func.count(FileObject.id)).scalar() or 0
    total_links = db.query(func.count(Link.id)).filter_by(active=True).scalar() or 0
    from app.models.user import User as UserModel
    total_users = db.query(func.count(UserModel.id)).scalar() or 0
    return {
        "total_bytes": total_bytes,
        "total_files": total_files,
        "total_links": total_links,
        "total_users": total_users,
    }


@router.get("/files/usage")
def file_usage(
    user: User = Depends(require_active_user),
    db: Session = Depends(get_db),
) -> dict:
    from app.permissions.policy import ensure_permissions
    perm = ensure_permissions(db, user.id, master=(user.role == "master"))
    db.commit()
    used = _used_bytes(db, user.id)
    return {
        "used_bytes": used,
        "quota_bytes": perm.quota_bytes,
        "max_file_bytes": perm.max_file_bytes,
    }
