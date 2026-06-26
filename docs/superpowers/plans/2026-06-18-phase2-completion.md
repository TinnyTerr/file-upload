# Phase 2 Completion Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the full Phase 1 spec (minus P2P): server-side + client-side encryption, zstd compression, all upload lifecycle options, APScheduler jobs, API key CRUD routes, API docs page, client-side JS decryption, and frontend wiring of all disabled options.

**Architecture:** Backend-first, frontend-second. New Python modules for crypto (`app/crypto/aead.py`) and compression (`app/storage/compress.py`) are shared by upload and download routes. APScheduler runs in the FastAPI lifespan. The upload route gains dual auth (session+CSRF OR Bearer API key). All "phase 2" UI stubs get enabled and wired.

**Tech Stack:** FastAPI, SQLAlchemy 2.0 sync, SQLite, `cryptography` (AESGCM), `zstandard`, `apscheduler>=3.10`, Vanilla JS + WebCrypto, pytest + httpx TestClient.

## Global Constraints

- Python ≥ 3.12; `from __future__ import annotations` at top of every `.py` file.
- All file I/O streams in 256 KiB chunks; no whole-file buffering (AEAD uses 2 MiB plaintext chunks per spec §4.1).
- CSRF token required for session-cookie state-changing requests; API key Bearer requests are CSRF-exempt (spec §6).
- Security headers on all file-serving responses: `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, CSP.
- Test runner: `.\.venv\Scripts\python.exe -m pytest` (Windows).
- Commit after each task: `feat: <description>`.
- No placeholder code — every step contains the complete implementation.

---

### Task 1: Add dependencies and missing FileObject columns

**Files:**
- Modify: `pyproject.toml`
- Modify: `app/models/file.py`

**Interfaces:**
- Produces: `FileObject.enc_key_blob: bytes | None` — sealed per-file encryption key for server-side mode.
- Produces: `FileObject.archive_after_idle_days: int | None` — per-file override for archival idle threshold.

- [ ] **Step 1: Add `zstandard` and `apscheduler` to `pyproject.toml`**

```toml
dependencies = [
    "fastapi>=0.115",
    "uvicorn[standard]>=0.30",
    "sqlalchemy>=2.0",
    "argon2-cffi>=23.1",
    "itsdangerous>=2.2",
    "pydantic-settings>=2.4",
    "python-multipart>=0.0.9",
    "cryptography>=43",
    "zstandard>=0.22",
    "apscheduler>=3.10",
]
```

- [ ] **Step 2: Install the new dependencies**

```
.\.venv\Scripts\pip.exe install zstandard apscheduler
```

- [ ] **Step 3: Add missing columns to `app/models/file.py`**

Add after the `last_downloaded_at` line:

```python
from sqlalchemy import LargeBinary

    enc_key_blob: Mapped[bytes | None] = mapped_column(LargeBinary, nullable=True)
    archive_after_idle_days: Mapped[int | None] = mapped_column(Integer, nullable=True)
```

Full updated file:

```python
from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import BigInteger, Boolean, ForeignKey, Integer, LargeBinary, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base, UTCDateTime


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class FileObject(Base):
    __tablename__ = "files"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    owner_id: Mapped[int] = mapped_column(Integer, ForeignKey("users.id"), nullable=False)
    storage_path: Mapped[str] = mapped_column(String(512), nullable=False)
    original_filename: Mapped[str] = mapped_column(String(512), nullable=False)
    size_bytes: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    stored_size_bytes: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    content_type: Mapped[str] = mapped_column(
        String(255), nullable=False, default="application/octet-stream"
    )
    encryption_mode: Mapped[str] = mapped_column(String(16), nullable=False, default="none")
    enc_key_blob: Mapped[bytes | None] = mapped_column(LargeBinary, nullable=True)
    compressed: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    archived: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    archive_codec: Mapped[str | None] = mapped_column(String(16), nullable=True)
    archive_after_idle_days: Mapped[int | None] = mapped_column(Integer, nullable=True)
    lifecycle_state: Mapped[str] = mapped_column(String(16), nullable=False, default="active")
    is_permanent: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    expires_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
    delete_if_idle_days: Mapped[int | None] = mapped_column(Integer, nullable=True)
    auto_unarchive_on_download: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True
    )
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=_utcnow)
    last_downloaded_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
```

- [ ] **Step 4: Migrate existing SQLite DB (dev only — adds new columns)**

```
.\.venv\Scripts\python.exe -c "
from app.db import make_engine
from app.config import load_settings
s = load_settings()
e = make_engine(s.database_url)
with e.connect() as c:
    try: c.execute(__import__('sqlalchemy').text('ALTER TABLE files ADD COLUMN enc_key_blob BLOB'))
    except: pass
    try: c.execute(__import__('sqlalchemy').text('ALTER TABLE files ADD COLUMN archive_after_idle_days INTEGER'))
    except: pass
    c.commit()
print('done')
"
```

- [ ] **Step 5: Verify app still starts**

```
.\.venv\Scripts\python.exe -c "from app.main import create_app; create_app(); print('ok')"
```
Expected: `ok`

- [ ] **Step 6: Commit**

```
git add pyproject.toml app/models/file.py
git commit -m "feat: add enc_key_blob + archive_after_idle_days columns; add zstandard + apscheduler deps"
```

---

### Task 2: Chunked AEAD crypto module (Python)

**Files:**
- Create: `app/crypto/__init__.py`
- Create: `app/crypto/aead.py`
- Create: `tests/test_aead.py`

**Interfaces:**
- Produces: `encrypt_file(key: bytes, src: Path, dst: Path) -> None` — writes FUPL-format ciphertext to `dst`.
- Produces: `decrypt_stream(key: bytes, path: Path) -> Iterator[bytes]` — yields plaintext chunks.
- Wire format: `b"FUPL" + b"\x01" + base_nonce(12B) + total_chunk_count(4B big-endian)` header; per-chunk = `AES-256-GCM(plaintext, nonce, aad) || 16B tag`; chunk nonce = `base_nonce XOR (7 zero bytes + uint32_be(idx) + flag_byte)`; chunk AAD = `16 zero bytes + uint32_be(idx) + flag_byte`.

- [ ] **Step 1: Write the failing tests**

```python
# tests/test_aead.py
from __future__ import annotations

import secrets
from pathlib import Path

import pytest

from app.crypto.aead import decrypt_stream, encrypt_file, MAGIC


def test_encrypt_produces_fupl_header(tmp_path):
    key = secrets.token_bytes(32)
    src = tmp_path / "plain.bin"
    dst = tmp_path / "enc.fupl"
    src.write_bytes(b"hello world")
    encrypt_file(key, src, dst)
    data = dst.read_bytes()
    assert data[:4] == MAGIC
    assert data[4:5] == b"\x01"


def test_roundtrip_small(tmp_path):
    key = secrets.token_bytes(32)
    src = tmp_path / "plain.bin"
    dst = tmp_path / "enc.fupl"
    plaintext = b"The quick brown fox jumps over the lazy dog"
    src.write_bytes(plaintext)
    encrypt_file(key, src, dst)
    recovered = b"".join(decrypt_stream(key, dst))
    assert recovered == plaintext


def test_roundtrip_multi_chunk(tmp_path):
    key = secrets.token_bytes(32)
    src = tmp_path / "big.bin"
    dst = tmp_path / "big.fupl"
    plaintext = secrets.token_bytes(5 * 1024 * 1024)  # 5 MiB → 3 chunks
    src.write_bytes(plaintext)
    encrypt_file(key, src, dst)
    recovered = b"".join(decrypt_stream(key, dst))
    assert recovered == plaintext


def test_wrong_key_raises(tmp_path):
    key = secrets.token_bytes(32)
    wrong_key = secrets.token_bytes(32)
    src = tmp_path / "plain.bin"
    dst = tmp_path / "enc.fupl"
    src.write_bytes(b"secret data")
    encrypt_file(key, src, dst)
    with pytest.raises(Exception):
        list(decrypt_stream(wrong_key, dst))


def test_tamper_raises(tmp_path):
    key = secrets.token_bytes(32)
    src = tmp_path / "plain.bin"
    dst = tmp_path / "enc.fupl"
    src.write_bytes(b"secret data")
    encrypt_file(key, src, dst)
    raw = bytearray(dst.read_bytes())
    raw[-1] ^= 0xFF  # flip last byte of GCM tag
    dst.write_bytes(bytes(raw))
    with pytest.raises(Exception):
        list(decrypt_stream(key, dst))


def test_empty_file_roundtrip(tmp_path):
    key = secrets.token_bytes(32)
    src = tmp_path / "empty.bin"
    dst = tmp_path / "empty.fupl"
    src.write_bytes(b"")
    encrypt_file(key, src, dst)
    recovered = b"".join(decrypt_stream(key, dst))
    assert recovered == b""
```

- [ ] **Step 2: Run to confirm all fail**

```
.\.venv\Scripts\python.exe -m pytest tests/test_aead.py -v
```
Expected: `ModuleNotFoundError: No module named 'app.crypto'`

- [ ] **Step 3: Create `app/crypto/__init__.py`**

Empty file.

- [ ] **Step 4: Create `app/crypto/aead.py`**

```python
from __future__ import annotations

import secrets
import struct
from pathlib import Path
from typing import Iterator

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

MAGIC = b"FUPL"
_VERSION = b"\x01"
_PLAINTEXT_CHUNK = 2 * 1024 * 1024  # 2 MiB
_HEADER_SIZE = 21  # 4 + 1 + 12 + 4


def _nonce(base: bytes, idx: int, is_last: bool) -> bytes:
    delta = b"\x00" * 7 + struct.pack(">I", idx) + bytes([0x01 if is_last else 0x00])
    return bytes(a ^ b for a, b in zip(base, delta))


def _aad(idx: int, is_last: bool) -> bytes:
    return b"\x00" * 16 + struct.pack(">I", idx) + bytes([0x01 if is_last else 0x00])


def encrypt_file(key: bytes, src: Path, dst: Path) -> None:
    base_nonce = secrets.token_bytes(12)
    aesgcm = AESGCM(key)
    total = 0

    with open(src, "rb") as fin, open(dst, "w+b") as fout:
        fout.write(MAGIC + _VERSION + base_nonce + b"\x00\x00\x00\x00")

        buf = fin.read(_PLAINTEXT_CHUNK)
        while buf:
            nxt = fin.read(_PLAINTEXT_CHUNK)
            is_last = not nxt
            fout.write(aesgcm.encrypt(_nonce(base_nonce, total, is_last), buf, _aad(total, is_last)))
            total += 1
            buf = nxt

        if total == 0:
            fout.write(aesgcm.encrypt(_nonce(base_nonce, 0, True), b"", _aad(0, True)))
            total = 1

        fout.seek(17)
        fout.write(struct.pack(">I", total))


def decrypt_stream(key: bytes, path: Path) -> Iterator[bytes]:
    aesgcm = AESGCM(key)
    with open(path, "rb") as fh:
        if fh.read(4) != MAGIC:
            raise ValueError("not a FUPL file")
        if fh.read(1) != _VERSION:
            raise ValueError("unsupported version")
        base_nonce = fh.read(12)
        (total,) = struct.unpack(">I", fh.read(4))

        for idx in range(total):
            is_last = idx == total - 1
            ct = fh.read() if is_last else fh.read(_PLAINTEXT_CHUNK + 16)
            if ct is None or (not is_last and len(ct) < 16):
                raise ValueError(f"truncated at chunk {idx}")
            plaintext = aesgcm.decrypt(_nonce(base_nonce, idx, is_last), ct, _aad(idx, is_last))
            if plaintext:
                yield plaintext
```

- [ ] **Step 5: Run tests**

```
.\.venv\Scripts\python.exe -m pytest tests/test_aead.py -v
```
Expected: `6 passed`

- [ ] **Step 6: Commit**

```
git add app/crypto/ tests/test_aead.py
git commit -m "feat: chunked AEAD crypto module (FUPL wire format, §4.1)"
```

---

### Task 3: Zstd compression module

**Files:**
- Create: `app/storage/compress.py`
- Create: `tests/test_compress.py`

**Interfaces:**
- Produces: `should_compress(content_type: str) -> bool` — False for already-compressed formats.
- Produces: `compress_file(src: Path, dst: Path) -> int` — returns compressed byte count.
- Produces: `decompress_stream(path: Path, original_size: int) -> Iterator[bytes]` — with 50:1 bomb guard.

- [ ] **Step 1: Write the failing tests**

```python
# tests/test_compress.py
from __future__ import annotations

import secrets
from pathlib import Path

import pytest

from app.storage.compress import compress_file, decompress_stream, should_compress


def test_should_compress_text():
    assert should_compress("text/plain") is True
    assert should_compress("application/json") is True
    assert should_compress("application/octet-stream") is True


def test_should_compress_skips_already_compressed():
    assert should_compress("image/jpeg") is False
    assert should_compress("image/png") is False
    assert should_compress("video/mp4") is False
    assert should_compress("application/zip") is False
    assert should_compress("application/gzip") is False
    assert should_compress("font/woff2") is False


def test_compress_and_decompress_roundtrip(tmp_path):
    src = tmp_path / "data.txt"
    dst = tmp_path / "data.zst"
    plaintext = b"hello " * 10000
    src.write_bytes(plaintext)
    compressed_size = compress_file(src, dst)
    assert compressed_size < len(plaintext)
    recovered = b"".join(decompress_stream(dst, len(plaintext)))
    assert recovered == plaintext


def test_compress_reduces_size(tmp_path):
    src = tmp_path / "repetitive.bin"
    dst = tmp_path / "repetitive.zst"
    data = b"AAAA" * 100000
    src.write_bytes(data)
    compressed = compress_file(src, dst)
    assert compressed < len(data) // 10


def test_decompress_bomb_guard(tmp_path):
    src = tmp_path / "data.txt"
    dst = tmp_path / "data.zst"
    data = b"A" * 1000
    src.write_bytes(data)
    compress_file(src, dst)
    # Lie about original_size to trigger bomb guard at tiny threshold
    with pytest.raises(ValueError, match="decompression bomb"):
        list(decompress_stream(dst, original_size=1))  # ratio > 50
```

- [ ] **Step 2: Run to confirm they fail**

```
.\.venv\Scripts\python.exe -m pytest tests/test_compress.py -v
```
Expected: `ModuleNotFoundError`

- [ ] **Step 3: Create `app/storage/compress.py`**

```python
from __future__ import annotations

from pathlib import Path
from typing import Iterator

import zstandard as zstd

_NO_COMPRESS = frozenset({
    "image/jpeg", "image/jpg", "image/png", "image/gif", "image/webp", "image/avif",
    "video/mp4", "video/webm", "video/ogg", "video/quicktime",
    "audio/mpeg", "audio/ogg", "audio/aac", "audio/flac",
    "application/zip", "application/gzip", "application/x-bzip2",
    "application/x-xz", "application/zstd", "application/x-7z-compressed",
    "application/x-rar-compressed", "application/vnd.rar",
    "font/woff", "font/woff2",
})

_LEVEL = 3
_BOMB_RATIO = 50
_BOMB_MAX = 10 * 1024 * 1024 * 1024  # 10 GiB
_READ_SIZE = 256 * 1024


def should_compress(content_type: str) -> bool:
    base = content_type.split(";")[0].strip().lower()
    return base not in _NO_COMPRESS


def compress_file(src: Path, dst: Path) -> int:
    cctx = zstd.ZstdCompressor(level=_LEVEL)
    with open(src, "rb") as fin, open(dst, "wb") as fout:
        cctx.copy_stream(fin, fout, read_size=_READ_SIZE, write_size=_READ_SIZE)
    return dst.stat().st_size


def decompress_stream(path: Path, original_size: int) -> Iterator[bytes]:
    dctx = zstd.ZstdDecompressor()
    produced = 0
    with open(path, "rb") as fh:
        reader = dctx.stream_reader(fh, read_size=_READ_SIZE)
        while True:
            chunk = reader.read(_READ_SIZE)
            if not chunk:
                break
            produced += len(chunk)
            if original_size > 0 and produced > original_size * _BOMB_RATIO:
                raise ValueError("decompression bomb detected")
            if produced > _BOMB_MAX:
                raise ValueError("decompression exceeded size cap")
            yield chunk
```

- [ ] **Step 4: Run tests**

```
.\.venv\Scripts\python.exe -m pytest tests/test_compress.py -v
```
Expected: `5 passed`

- [ ] **Step 5: Commit**

```
git add app/storage/compress.py tests/test_compress.py
git commit -m "feat: zstd compression module with 50:1 bomb guard"
```

---

### Task 4: Upload route full expansion (dual auth, all options, server-side encryption)

**Files:**
- Modify: `app/deps.py` (add `get_upload_user` dual-auth dependency)
- Modify: `app/routes/files.py` (expand upload route)
- Modify: `app/config.py` (add `get_master_key` if not present — check first)

**Interfaces:**
- Consumes: `encrypt_file` from `app/crypto/aead.py`; `compress_file`, `should_compress` from `app/storage/compress.py`; `seal` from `app/security/secretbox.py`; `get_master_key` from `app/config.py`.
- New form fields: `encryption_mode` (str, default "none"), `compress` (bool, default False), `is_permanent` (bool, default True), `temp_days` (int|None), `delete_if_idle_days` (int|None), `archive_after_idle_days` (int|None), `auto_unarchive_on_download` (bool, default True), `randomize_filename` (bool, default False).
- Upload response: adds `encryption_mode`, `share_url` (includes `?ek=` for server-side), `file_key` (base64url for client-side, null otherwise).

- [ ] **Step 1: Check if `get_master_key` exists in `app/config.py`**

```
.\.venv\Scripts\python.exe -c "from app.config import get_master_key; print('exists')"
```

If missing, read `app/config.py` and add:

```python
import base64

def get_master_key(settings) -> bytes:
    return base64.b64decode(settings.master_key_b64)
```

- [ ] **Step 2: Add `get_upload_user` dual-auth dep to `app/deps.py`**

Add at the bottom of `app/deps.py`:

```python
def get_upload_user(request: Request, db: Session = Depends(get_db)) -> "User":
    """Session+CSRF auth OR Bearer API key auth. Returns authenticated User."""
    from datetime import timezone
    from app.models.session import SessionRow
    from app.permissions.policy import ensure_permissions, has_permission
    from app.security.sessions import COOKIE_NAME

    auth_header = request.headers.get("authorization", "")
    if auth_header.startswith("Bearer "):
        from app.models.api_key import ApiKey
        from app.security.api_keys import hash_key, bind_or_reject
        from app.audit.log import record

        raw = auth_header[len("Bearer "):].strip()
        api_key = db.query(ApiKey).filter_by(key_hash=hash_key(raw), active=True).one_or_none()
        if api_key is None:
            raise HTTPException(status_code=401, detail="invalid api key")
        ip = client_ip(request)
        if not bind_or_reject(api_key, ip, datetime.now(timezone.utc)):
            record(db, actor=f"apikey:{api_key.id}", action="apikey.ip_rejected",
                   target=f"apikey:{api_key.id}", ip=ip)
            db.commit()
            raise HTTPException(status_code=403, detail="api key ip mismatch")
        db.commit()
        user = db.get(User, api_key.owner_id)
        if user is None or user.must_change_credentials:
            raise HTTPException(status_code=401, detail="invalid api key owner")
        perm = ensure_permissions(db, user.id, master=(user.role == "master"))
        if not has_permission(perm, "can_upload"):
            raise HTTPException(status_code=403, detail="permission denied")
        return user
    else:
        state = get_state(request)
        cookie = request.cookies.get(COOKIE_NAME)
        row = state.session_manager.resolve(db, cookie)
        if row is None:
            raise HTTPException(status_code=401, detail="not authenticated")
        csrf = request.headers.get("x-csrf-token", "")
        if not csrf or csrf != row.csrf_token:
            raise HTTPException(status_code=403, detail="invalid or missing CSRF token")
        user = db.get(User, row.user_id)
        if user is None or user.must_change_credentials:
            raise HTTPException(status_code=401, detail="not authenticated")
        perm = ensure_permissions(db, user.id, master=(user.role == "master"))
        if not has_permission(perm, "can_upload"):
            raise HTTPException(status_code=403, detail="permission denied")
        return user
```

- [ ] **Step 3: Replace the upload route in `app/routes/files.py`**

Replace the `upload_file` function (lines 43–125) with:

```python
import base64 as _b64
import secrets as _secrets

_NO_ENCRYPT_COMPRESS = frozenset({"client"})  # ciphertext won't shrink


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
    user: User = Depends(get_upload_user),
    db: Session = Depends(get_db),
) -> dict:
    from app.crypto.aead import encrypt_file as _encrypt_file
    from app.storage.compress import compress_file as _compress_file, should_compress
    from app.security.secretbox import seal
    from app.config import get_master_key

    if encryption_mode not in ("none", "server", "client"):
        raise HTTPException(400, detail="invalid encryption_mode")

    perm = ensure_permissions(db, user.id, master=(user.role == "master"))

    if encryption_mode == "client" and not perm.can_upload_client_encrypted:
        raise HTTPException(403, detail="client-side encryption not permitted")

    content_length = request.headers.get("content-length")
    if content_length:
        declared = int(content_length)
        if declared > perm.max_file_bytes:
            raise HTTPException(413, detail="file exceeds max file size")
        if _used_bytes(db, user.id) + declared > perm.quota_bytes:
            raise HTTPException(413, detail="upload would exceed your quota")

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
    except HTTPException:
        work.unlink(missing_ok=True)
        raise

    if _used_bytes(db, user.id) + stored > perm.quota_bytes:
        work.unlink(missing_ok=True)
        raise HTTPException(413, detail="upload would exceed your quota")

    size_bytes = stored
    file_compressed = False
    current = work

    try:
        # Compression (only for non-client-encrypted modes and eligible types)
        ct = (file.content_type or "application/octet-stream").lower().split(";")[0].strip()
        if ct in _UNSAFE_CT:
            ct = "application/octet-stream"

        if compress and encryption_mode != "client" and should_compress(ct):
            compressed = base_path.with_suffix(".zst.work")
            _compress_file(current, compressed)
            current.unlink()
            current = compressed
            file_compressed = True

        # Create DB record (need ID before server-side encryption)
        display_name = _secrets.token_hex(8) + "_" + original_filename if randomize_filename else original_filename
        expires_at: datetime | None = None
        if not is_permanent and temp_days:
            expires_at = datetime.now(timezone.utc) + timedelta(days=temp_days)

        file_obj = FileObject(
            owner_id=user.id,
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
        file_key_b64: str | None = None

        # Server-side encryption
        if encryption_mode == "server":
            per_file_key = _secrets.token_bytes(32)
            encrypted = base_path.with_suffix(".fupl.work")
            _encrypt_file(per_file_key, current, encrypted)
            current.unlink()
            current = encrypted
            state = request.app.state.app_state
            enc_key_blob_val = seal(get_master_key(state.settings), per_file_key)
            file_key_b64 = _b64.urlsafe_b64encode(per_file_key).rstrip(b"=").decode()

        # Finalize: rename work file to storage path
        current.rename(base_path)
        file_obj.stored_size_bytes = base_path.stat().st_size
        file_obj.enc_key_blob = enc_key_blob_val

    except Exception:
        for p in [work, base_path.with_suffix(".zst.work"), base_path.with_suffix(".fupl.work"), base_path]:
            p.unlink(missing_ok=True)
        db.rollback()
        raise

    expires_link: datetime | None = None
    if expires_in_seconds is not None:
        expires_link = datetime.now(timezone.utc) + timedelta(seconds=expires_in_seconds)

    slug = new_slug()
    link = Link(file_id=file_obj.id, slug=slug, max_uses=max_uses, expires_at=expires_link)
    db.add(link)

    record(db, actor=user.username, action="file.uploaded",
           target=f"file:{file_obj.id}", ip=client_ip(request))
    db.commit()

    base_url = _file_url(request, slug)
    share_url = base_url + (f"?ek={file_key_b64}" if encryption_mode == "server" else "")

    return {
        "file_id": file_obj.id,
        "slug": slug,
        "url": share_url,
        "raw_url": share_url.replace("/file/", "/file/", 1) + ("/raw" if "?" not in share_url else "/raw?" + share_url.split("?", 1)[1].replace(slug, slug)),
        "encryption_mode": encryption_mode,
        "file_key": file_key_b64,
        "max_uses": max_uses,
        "expires_at": expires_link.isoformat() if expires_link else None,
        "compressed": file_compressed,
    }
```

Fix `raw_url` generation — it's simpler as:

```python
    raw_base = _file_url(request, slug) + "/raw"
    raw_url = raw_base + (f"?ek={file_key_b64}" if encryption_mode == "server" else "")
```

Replace the `raw_url` line in the return dict with `"raw_url": raw_url,` and build `raw_url` before the return.

Also add `get_upload_user` to the imports at the top of `app/routes/files.py`:

```python
from app.deps import client_ip, get_db, get_upload_user, require_active_user, require_master, require_permission
```

- [ ] **Step 4: Run smoke test**

```
.\.venv\Scripts\python.exe -c "
from app.main import create_app
from fastapi.testclient import TestClient
app = create_app(database_url='sqlite:///:memory:')
c = TestClient(app)
r = c.get('/health')
print(r.status_code, r.json())
"
```
Expected: `200 {'status': 'ok'}`

- [ ] **Step 5: Commit**

```
git add app/deps.py app/routes/files.py app/config.py
git commit -m "feat: expand upload route with all options, dual auth, server-side encryption pipeline"
```

---

### Task 5: Download route — Range support, server-side decryption, archival unpack

**Files:**
- Modify: `app/routes/public.py`

**Interfaces:**
- Consumes: `decrypt_stream` from `app/crypto/aead.py`; `decompress_stream` from `app/storage/compress.py`; `get_master_key` from `app/config.py`; `open_box` from `app/security/secretbox.py`.
- Produces: `GET /file/{slug}/raw` now supports `Range: bytes=start-end` → 206; `?ek=KEY` triggers server-side decrypt; archived/compressed files are streamed decompressed.
- `Accept-Ranges: bytes` on all responses.

- [ ] **Step 1: Replace `app/routes/public.py` in full**

```python
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
```

- [ ] **Step 2: Verify server starts**

```
.\.venv\Scripts\python.exe -c "from app.main import create_app; create_app(); print('ok')"
```

- [ ] **Step 3: Commit**

```
git add app/routes/public.py
git commit -m "feat: download route — Range/206, server-side decrypt, archival decompress"
```

---

### Task 6: APScheduler lifecycle jobs

**Files:**
- Create: `app/jobs/__init__.py`
- Create: `app/jobs/lifecycle.py`
- Modify: `app/main.py`

**Interfaces:**
- Produces: 4 APScheduler jobs wired into FastAPI lifespan: archive idle, delete idle, temp expiry, link expiry.
- `archive_idle`: finds `lifecycle_state="active"`, `archived=False`, `encryption_mode!="client"`, idle > `archive_after_idle_days` (default 5). Compresses in-place, sets `archived=True`, updates `stored_size_bytes`, sets `lifecycle_state="archived"`.
- `delete_idle`: finds files where `delete_if_idle_days` set and idle > threshold. Deletes file + links.
- `temp_expiry`: finds `is_permanent=False` and `expires_at < now`. Deletes.
- `link_expiry`: finds links where `expires_at < now` and `active=True`. Deactivates.

- [ ] **Step 1: Create `app/jobs/__init__.py`**

Empty file.

- [ ] **Step 2: Create `app/jobs/lifecycle.py`**

```python
from __future__ import annotations

import logging
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path

_log = logging.getLogger(__name__)
_DEFAULT_ARCHIVE_IDLE_DAYS = 5


def _now() -> datetime:
    return datetime.now(timezone.utc)


def archive_idle_job(session_factory, storage_root: Path) -> None:
    from sqlalchemy.orm import Session
    from app.models.file import FileObject
    from app.storage.compress import compress_file, should_compress

    with session_factory() as db:
        cutoff = _now() - timedelta(days=_DEFAULT_ARCHIVE_IDLE_DAYS)
        candidates = (
            db.query(FileObject)
            .filter(
                FileObject.lifecycle_state == "active",
                FileObject.archived == False,
                FileObject.encryption_mode != "client",
            )
            .all()
        )
        for f in candidates:
            idle_days = f.archive_after_idle_days or _DEFAULT_ARCHIVE_IDLE_DAYS
            threshold = _now() - timedelta(days=idle_days)
            last = f.last_downloaded_at or f.created_at
            if last > threshold:
                continue
            if not should_compress(f.content_type):
                continue
            src = storage_root / f.storage_path
            if not src.exists():
                continue
            tmp = src.with_suffix(".arch.tmp")
            try:
                f.lifecycle_state = "archiving"
                db.commit()
                compress_file(src, tmp)
                tmp.replace(src)
                f.stored_size_bytes = src.stat().st_size
                f.archived = True
                f.archive_codec = "zstd"
                f.lifecycle_state = "archived"
                db.commit()
                _log.info("archived file %d", f.id)
            except Exception as exc:
                _log.error("archive failed for file %d: %s", f.id, exc)
                tmp.unlink(missing_ok=True)
                f.lifecycle_state = "active"
                db.commit()


def delete_idle_job(session_factory, storage_root: Path) -> None:
    from app.models.file import FileObject
    from app.models.link import Link

    with session_factory() as db:
        files = db.query(FileObject).filter(FileObject.delete_if_idle_days.isnot(None)).all()
        for f in files:
            last = f.last_downloaded_at or f.created_at
            if (_now() - last).days < f.delete_if_idle_days:
                continue
            _delete_file(db, f, storage_root)
        db.commit()


def temp_expiry_job(session_factory, storage_root: Path) -> None:
    from app.models.file import FileObject

    with session_factory() as db:
        files = (
            db.query(FileObject)
            .filter(FileObject.is_permanent == False, FileObject.expires_at < _now())
            .all()
        )
        for f in files:
            _delete_file(db, f, storage_root)
        db.commit()


def link_expiry_job(session_factory) -> None:
    from app.models.link import Link

    with session_factory() as db:
        (
            db.query(Link)
            .filter(Link.expires_at < _now(), Link.active == True)
            .update({Link.active: False})
        )
        db.commit()


def _delete_file(db, f, storage_root: Path) -> None:
    from app.models.link import Link

    path = storage_root / f.storage_path
    try:
        path.unlink(missing_ok=True)
    except OSError:
        pass
    db.query(Link).filter_by(file_id=f.id).delete()
    db.delete(f)


def reconcile_stale_states(session_factory, storage_root: Path) -> None:
    from app.models.file import FileObject

    with session_factory() as db:
        stale = db.query(FileObject).filter(
            FileObject.lifecycle_state.in_(["archiving", "unarchiving"])
        ).all()
        for f in stale:
            _log.warning("resetting stale lifecycle_state for file %d", f.id)
            f.lifecycle_state = "archived" if f.archived else "active"
        if stale:
            db.commit()
```

- [ ] **Step 3: Wire jobs into `app/main.py` lifespan**

Replace the `lifespan` function in `app/main.py`:

```python
from app.jobs.lifecycle import (
    archive_idle_job, delete_idle_job, temp_expiry_job, link_expiry_job,
    reconcile_stale_states,
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
```

- [ ] **Step 4: Verify app starts with scheduler**

```
.\.venv\Scripts\python.exe -c "
import asyncio
from app.main import create_app
app = create_app(database_url='sqlite:///:memory:')
print('ok')
"
```

- [ ] **Step 5: Commit**

```
git add app/jobs/ app/main.py
git commit -m "feat: APScheduler lifecycle jobs (archive, delete idle, temp expiry, link expiry)"
```

---

### Task 7: API key CRUD routes + `/account/me` update

**Files:**
- Create: `app/routes/keys.py`
- Modify: `app/routes/account.py` (add `can_use_api_keys` to `/account/me`)
- Modify: `app/main.py` (include keys router, add `/api-docs` page route)

**Interfaces:**
- Produces: `POST /keys/` → `{"id": int, "key": str}` (raw key shown once, requires `can_use_api_keys`).
- Produces: `GET /keys/` → `{"keys": [{id, owner_id, bound_ip, active, created_at, last_used_at}]}`.
- Produces: `DELETE /keys/{id}` → `{"status": "deactivated"}`.
- Produces: `POST /keys/{id}/reset-ip` with `{"password": str}` → `{"status": "ip_reset"}`.
- Produces: `GET /account/me` gains `"can_use_api_keys": bool`.

- [ ] **Step 1: Create `app/routes/keys.py`**

```python
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.audit.log import record
from app.deps import client_ip, get_db, require_active_user, require_permission
from app.models.api_key import ApiKey
from app.models.session import SessionRow
from app.models.user import User
from app.security.api_keys import generate_key, hash_key
from app.security.csrf import require_csrf
from app.security.passwords import verify_password

router = APIRouter(prefix="/keys", tags=["keys"])


@router.post("/")
def create_key(
    request: Request,
    _csrf: SessionRow = Depends(require_csrf),
    user: User = Depends(require_permission("can_use_api_keys")),
    db: Session = Depends(get_db),
) -> dict:
    raw = generate_key()
    key = ApiKey(owner_id=user.id, key_hash=hash_key(raw))
    db.add(key)
    db.flush()
    record(db, actor=user.username, action="apikey.created",
           target=f"apikey:{key.id}", ip=client_ip(request))
    db.commit()
    return {"id": key.id, "key": raw}


@router.get("/")
def list_keys(
    user: User = Depends(require_active_user),
    db: Session = Depends(get_db),
) -> dict:
    if user.role == "master":
        keys = db.query(ApiKey).order_by(ApiKey.created_at.desc()).all()
    else:
        keys = db.query(ApiKey).filter_by(owner_id=user.id).order_by(ApiKey.created_at.desc()).all()
    return {
        "keys": [
            {
                "id": k.id,
                "owner_id": k.owner_id,
                "bound_ip": k.bound_ip,
                "active": k.active,
                "created_at": k.created_at.isoformat(),
                "last_used_at": k.last_used_at.isoformat() if k.last_used_at else None,
            }
            for k in keys
        ]
    }


@router.delete("/{key_id}")
def deactivate_key(
    key_id: int,
    request: Request,
    _csrf: SessionRow = Depends(require_csrf),
    user: User = Depends(require_active_user),
    db: Session = Depends(get_db),
) -> dict:
    key = db.get(ApiKey, key_id)
    if key is None:
        raise HTTPException(404, detail="not found")
    if user.role != "master" and key.owner_id != user.id:
        raise HTTPException(403, detail="not your key")
    key.active = False
    record(db, actor=user.username, action="apikey.deactivated",
           target=f"apikey:{key_id}", ip=client_ip(request))
    db.commit()
    return {"status": "deactivated"}


class ResetIpBody(BaseModel):
    password: str


@router.post("/{key_id}/reset-ip")
def reset_key_ip(
    key_id: int,
    body: ResetIpBody,
    request: Request,
    _csrf: SessionRow = Depends(require_csrf),
    user: User = Depends(require_active_user),
    db: Session = Depends(get_db),
) -> dict:
    key = db.get(ApiKey, key_id)
    if key is None:
        raise HTTPException(404, detail="not found")
    if user.role != "master" and key.owner_id != user.id:
        raise HTTPException(403, detail="not your key")
    if not verify_password(body.password, user.password_hash):
        raise HTTPException(401, detail="invalid password")
    key.bound_ip = None
    record(db, actor=user.username, action="apikey.ip_reset",
           target=f"apikey:{key_id}", ip=client_ip(request))
    db.commit()
    return {"status": "ip_reset"}
```

- [ ] **Step 2: Update `/account/me` in `app/routes/account.py`**

Find the `me` function and replace its return dict to include `can_use_api_keys`:

```python
@router.get("/me")
def me(user: User = Depends(require_active_user), db: Session = Depends(get_db)) -> dict:
    from app.permissions.policy import ensure_permissions
    from app.models.file import FileObject
    from sqlalchemy import func
    perm = ensure_permissions(db, user.id, master=(user.role == "master"))
    used = db.query(func.sum(FileObject.stored_size_bytes)).filter_by(owner_id=user.id).scalar() or 0
    db.commit()
    return {
        "id": user.id,
        "username": user.username,
        "role": user.role,
        "quota_bytes": perm.quota_bytes,
        "used_bytes": used,
        "can_use_api_keys": perm.can_use_api_keys,
        "can_upload_client_encrypted": perm.can_upload_client_encrypted,
    }
```

- [ ] **Step 3: Include keys router in `app/main.py`**

Add import and include:

```python
from app.routes.keys import router as keys_router
# in create_app, after other include_router calls:
app.include_router(keys_router)
```

- [ ] **Step 4: Verify**

```
.\.venv\Scripts\python.exe -c "from app.main import create_app; create_app(); print('ok')"
```

- [ ] **Step 5: Commit**

```
git add app/routes/keys.py app/routes/account.py app/main.py
git commit -m "feat: API key CRUD routes (create, list, deactivate, reset-ip)"
```

---

### Task 8: API docs page

**Files:**
- Create: `app/static/api-docs.html`
- Modify: `app/main.py` (add GET /api-docs route)

**Interfaces:**
- Produces: `GET /api-docs` → static HTML page with curl upload/download examples.

- [ ] **Step 1: Create `app/static/api-docs.html`**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>API Docs — fileupload</title>
  <link rel="stylesheet" href="/static/css/theme.css">
  <style>
    .api-block {
      background: var(--surface-2);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 14px 18px;
      font-family: var(--font-mono);
      font-size: 13px;
      color: var(--text-muted);
      white-space: pre-wrap;
      word-break: break-all;
      margin: 10px 0 18px;
    }
    .method { font-weight: 700; color: var(--accent); }
    .endpoint { color: var(--text); }
    .note { font-size: 12px; color: var(--text-muted); margin-bottom: 6px; }
  </style>
</head>
<body>
  <nav class="nav">
    <a href="/" class="nav-logo">fileupload</a>
    <div class="nav-spacer"></div>
    <a href="/files" class="nav-link">Files</a>
  </nav>

  <div class="container" style="max-width:800px">
    <div class="section-label mt-24">API Reference</div>
    <p class="text-sm text-muted mb-24">
      The API accepts Bearer token authentication. Get a key from the Files page → API Keys section.
      All security management (key creation, deletion, IP reset) must be done in-app.
    </p>

    <div class="card mb-16">
      <div class="text-sm" style="font-weight:600;margin-bottom:8px">Authentication</div>
      <div class="note">Include your API key on every request:</div>
      <div class="api-block">curl -H "Authorization: Bearer &lt;your-api-key&gt;" ...</div>
      <div class="note" style="margin-top:8px">
        Keys bind to the first IP that uses them. Use <strong>Reset IP</strong> in-app if your IP changes.
      </div>
    </div>

    <div class="card mb-16">
      <div class="text-sm" style="font-weight:600;margin-bottom:8px">
        <span class="method">POST</span> <span class="endpoint">/files/upload</span> — Upload a file
      </div>
      <div class="note">Upload a file and receive a download link. Returns JSON with the link URL.</div>
      <div class="api-block">curl -X POST https://&lt;host&gt;/files/upload \
  -H "Authorization: Bearer &lt;key&gt;" \
  -F "file=@/path/to/file.txt" \
  -F "original_filename=file.txt"</div>
      <div class="note">Optional form fields:</div>
      <div class="api-block">max_uses=10            # limit download count
expires_in_seconds=86400  # link expires in 24h
encryption_mode=server    # encrypt at rest (adds ?ek= to URL)
compress=true             # zstd compress before storing
is_permanent=false        # mark as temporary
temp_days=7               # delete after 7 days
delete_if_idle_days=30    # delete if no downloads in 30 days</div>
      <div class="note">Response:</div>
      <div class="api-block">{
  "slug": "abc123",
  "url": "https://&lt;host&gt;/file/abc123",
  "raw_url": "https://&lt;host&gt;/file/abc123/raw",
  "encryption_mode": "none",
  "file_key": null
}</div>
    </div>

    <div class="card mb-16">
      <div class="text-sm" style="font-weight:600;margin-bottom:8px">
        <span class="method">GET</span> <span class="endpoint">/file/{slug}/raw</span> — Download raw bytes
      </div>
      <div class="note">Download the file directly. No authentication required (link is the credential).</div>
      <div class="api-block">curl -L -o output.txt "https://&lt;host&gt;/file/abc123/raw"</div>
      <div class="note">Server-side encrypted files require the <code>?ek=</code> key from the upload response:</div>
      <div class="api-block">curl -L -o output.txt "https://&lt;host&gt;/file/abc123/raw?ek=&lt;key&gt;"</div>
      <div class="note">Range downloads:</div>
      <div class="api-block">curl -L -r 0-1023 -o chunk.bin "https://&lt;host&gt;/file/abc123/raw"</div>
    </div>

    <div class="card mb-16">
      <div class="text-sm" style="font-weight:600;margin-bottom:8px">
        <span class="method">GET</span> <span class="endpoint">/file/{slug}/info</span> — File metadata
      </div>
      <div class="api-block">curl "https://&lt;host&gt;/file/abc123/info"</div>
      <div class="note">Returns filename, size, content_type, encryption_mode, use_count, expires_at.</div>
    </div>

    <div class="card">
      <div class="text-sm" style="font-weight:600;margin-bottom:8px">Client-side encrypted files</div>
      <div class="note">
        The key for client-side encrypted files is in the <strong>URL fragment</strong> (#ek=…) and is never sent to the server.
        The server streams raw ciphertext. Decrypt locally with openssl:
      </div>
      <div class="api-block"># PowerShell
$raw = Invoke-RestMethod "https://&lt;host&gt;/file/abc123/raw" -OutFile enc.bin
# (extract KEY from #ek= fragment of the share URL)
$key = [System.Convert]::FromBase64String($KEY.Replace('-','+').Replace('_','/') + "==")
# Decrypt with openssl (after converting FUPL format — use the in-app download page)</div>
      <div class="note mt-8">For client-side encrypted files, use the in-app download page for browser-based decryption.</div>
    </div>
  </div>
</body>
</html>
```

- [ ] **Step 2: Add route in `app/main.py`**

Add after the `/admin` route:

```python
    @app.get("/api-docs")
    def api_docs_page():
        return FileResponse(str(_STATIC / "api-docs.html"))
```

- [ ] **Step 3: Commit**

```
git add app/static/api-docs.html app/main.py
git commit -m "feat: simple API docs page at /api-docs"
```

---

### Task 9: JavaScript AEAD Web Worker

**Files:**
- Create: `app/static/js/aead-worker.js`

**Interfaces:**
- Consumes: `postMessage({type: "encrypt", plaintext: ArrayBuffer, key: Uint8Array | null})` → generates key if null, encrypts, posts back `{type: "encrypted", ciphertext: ArrayBuffer, keyBytes: Uint8Array}`.
- Consumes: `postMessage({type: "decrypt", ciphertext: ArrayBuffer, key: Uint8Array})` → posts back `{type: "decrypted", plaintext: ArrayBuffer}` or `{type: "error", message: str}`.
- Same FUPL wire format as Python aead.py (magic, base_nonce, total_chunk_count, per-chunk nonce/AAD).

- [ ] **Step 1: Create `app/static/js/aead-worker.js`**

```javascript
// FUPL chunked AEAD worker — same wire format as app/crypto/aead.py
'use strict';

const MAGIC = new Uint8Array([0x46, 0x55, 0x50, 0x4C]); // "FUPL"
const VERSION = 0x01;
const PLAINTEXT_CHUNK = 2 * 1024 * 1024; // 2 MiB

function xorNonce(base, idx, isLast) {
  const result = new Uint8Array(12);
  const delta = new Uint8Array(12);
  const view = new DataView(delta.buffer);
  view.setUint32(7, idx, false); // big-endian at offset 7
  delta[11] = isLast ? 0x01 : 0x00;
  for (let i = 0; i < 12; i++) result[i] = base[i] ^ delta[i];
  return result;
}

function makeAAD(idx, isLast) {
  const aad = new Uint8Array(21); // 16 zeros + 4 bytes idx + 1 byte flag
  const view = new DataView(aad.buffer);
  view.setUint32(16, idx, false);
  aad[20] = isLast ? 0x01 : 0x00;
  return aad;
}

async function importKey(keyBytes) {
  return crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

async function encryptData(plaintext, keyBytes) {
  if (!keyBytes) keyBytes = crypto.getRandomValues(new Uint8Array(32));
  const key = await importKey(keyBytes);
  const baseNonce = crypto.getRandomValues(new Uint8Array(12));
  const buf = new Uint8Array(plaintext);

  const chunks = [];
  let offset = 0;
  while (offset < buf.length || chunks.length === 0) {
    chunks.push(buf.slice(offset, offset + PLAINTEXT_CHUNK));
    offset += PLAINTEXT_CHUNK;
    if (offset >= buf.length) break;
  }
  const total = chunks.length;

  const encryptedChunks = [];
  let totalSize = 21; // header
  for (let idx = 0; idx < total; idx++) {
    const isLast = idx === total - 1;
    const nonce = xorNonce(baseNonce, idx, isLast);
    const aad = makeAAD(idx, isLast);
    const ct = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce, additionalData: aad, tagLength: 128 },
      key, chunks[idx]
    );
    encryptedChunks.push(new Uint8Array(ct));
    totalSize += ct.byteLength;
  }

  const out = new Uint8Array(totalSize);
  let pos = 0;
  out.set(MAGIC, pos); pos += 4;
  out[pos++] = VERSION;
  out.set(baseNonce, pos); pos += 12;
  const countView = new DataView(out.buffer, pos, 4);
  countView.setUint32(0, total, false); pos += 4;
  for (const chunk of encryptedChunks) { out.set(chunk, pos); pos += chunk.length; }

  return { ciphertext: out.buffer, keyBytes };
}

async function decryptData(ciphertext, keyBytes) {
  const buf = new Uint8Array(ciphertext);
  let pos = 0;

  // Check magic
  for (let i = 0; i < 4; i++) {
    if (buf[pos + i] !== MAGIC[i]) throw new Error('not a FUPL file');
  }
  pos += 4;
  if (buf[pos++] !== VERSION) throw new Error('unsupported version');

  const baseNonce = buf.slice(pos, pos + 12); pos += 12;
  const total = new DataView(buf.buffer, pos, 4).getUint32(0, false); pos += 4;

  const key = await importKey(keyBytes);
  const plaintextChunks = [];
  const encChunkSize = PLAINTEXT_CHUNK + 16; // plaintext + GCM tag

  for (let idx = 0; idx < total; idx++) {
    const isLast = idx === total - 1;
    const ctChunk = isLast ? buf.slice(pos) : buf.slice(pos, pos + encChunkSize);
    pos += ctChunk.length;
    const nonce = xorNonce(baseNonce, idx, isLast);
    const aad = makeAAD(idx, isLast);
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: nonce, additionalData: aad, tagLength: 128 },
      key, ctChunk
    );
    plaintextChunks.push(new Uint8Array(pt));
  }

  const totalLen = plaintextChunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(totalLen);
  let outPos = 0;
  for (const c of plaintextChunks) { out.set(c, outPos); outPos += c.length; }
  return out.buffer;
}

self.onmessage = async (e) => {
  const { type, plaintext, ciphertext, key } = e.data;
  try {
    if (type === 'encrypt') {
      const result = await encryptData(plaintext, key || null);
      self.postMessage({ type: 'encrypted', ciphertext: result.ciphertext, keyBytes: result.keyBytes }, [result.ciphertext]);
    } else if (type === 'decrypt') {
      const pt = await decryptData(ciphertext, key);
      self.postMessage({ type: 'decrypted', plaintext: pt }, [pt]);
    }
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message });
  }
};
```

- [ ] **Step 2: Commit**

```
git add app/static/js/aead-worker.js
git commit -m "feat: AEAD Web Worker (WebCrypto AES-256-GCM, FUPL wire format)"
```

---

### Task 10: Frontend upload options wiring

**Files:**
- Modify: `app/static/files.html`
- Modify: `app/static/js/files.js`

**Interfaces:**
- Remove all `phase-badge` spans and `disabled` attributes from: encryption select, compress toggle, temp days, archive days, delete-days.
- `files.js` sends all new form fields in the upload FormData.
- Client-side encryption uses `aead-worker.js` to encrypt before uploading.
- On upload success: show share URL, QR code (canvas-based), PowerShell/openssl decrypt snippet for client-side files, `file_key` prominently.

- [ ] **Step 1: Update `app/static/files.html` — remove phase-2 badges, enable controls**

Replace the options section (lines 101–182 approximately). Replace each disabled control block:

**Encryption block** — change:
```html
              <div class="osr-ctrl">
                <span class="phase-badge">phase 2</span>
                <select id="opt-encrypt" disabled>
```
to:
```html
              <div class="osr-ctrl">
                <select id="opt-encrypt">
```

**Compress block** — change:
```html
              <div class="osr-ctrl">
                <span class="phase-badge">phase 2</span>
                <label class="toggle">
                  <input type="checkbox" id="opt-compress" disabled>
```
to:
```html
              <div class="osr-ctrl">
                <label class="toggle">
                  <input type="checkbox" id="opt-compress">
```

**Temp days block** — change:
```html
              <div class="osr-ctrl">
                <span class="phase-badge">phase 2</span>
                <input type="number" min="1" placeholder="Days" style="width:72px" disabled id="opt-temp-days">
```
to:
```html
              <div class="osr-ctrl">
                <input type="number" min="1" placeholder="Days" style="width:72px" id="opt-temp-days">
```

**Archive days block** — change:
```html
              <div class="osr-ctrl">
                <span class="phase-badge">phase 2</span>
                <input type="number" min="1" placeholder="5" style="width:72px" disabled id="opt-archive-days">
```
to:
```html
              <div class="osr-ctrl">
                <input type="number" min="1" placeholder="5" style="width:72px" id="opt-archive-days">
```

**Delete days block** — change:
```html
              <div class="osr-ctrl">
                <span class="phase-badge">phase 2</span>
                <input type="number" min="1" placeholder="30" style="width:72px" disabled id="opt-delete-days">
```
to:
```html
              <div class="osr-ctrl">
                <input type="number" min="1" placeholder="30" style="width:72px" id="opt-delete-days">
```

Also add a success modal before `</body>`:

```html
  <!-- Upload success modal -->
  <div class="modal-overlay hidden" id="success-modal">
    <div class="modal" style="max-width:520px">
      <div class="modal-title">Upload complete</div>
      <div id="success-body"></div>
      <div id="qr-wrap" style="text-align:center;margin:16px 0"></div>
      <div class="modal-footer">
        <button class="btn btn-primary" id="success-close">Done</button>
      </div>
    </div>
  </div>
```

- [ ] **Step 2: Update `app/static/js/files.js` to send all new options and handle success**

Read the current files.js (it's large) to find the XHR upload section. The key change is to the FormData construction in the upload function. Find where `formData.append` calls happen and add:

```javascript
// After existing appends (original_filename, max_uses, expires_in_seconds):
const encMode = document.getElementById('opt-encrypt').value;
formData.append('encryption_mode', encMode);
formData.append('compress', document.getElementById('opt-compress').checked ? 'true' : 'false');
const tempDays = document.getElementById('opt-temp-days').value;
if (tempDays) {
  formData.append('is_permanent', 'false');
  formData.append('temp_days', tempDays);
} else {
  formData.append('is_permanent', 'true');
}
const archDays = document.getElementById('opt-archive-days').value;
if (archDays) formData.append('archive_after_idle_days', archDays);
const delDays = document.getElementById('opt-delete-days').value;
if (delDays) formData.append('delete_if_idle_days', delDays);
formData.append('randomize_filename', document.getElementById('opt-randomize').checked ? 'true' : 'false');
```

For client-side encryption (`encMode === 'client'`), intercept the upload to encrypt first. Add a helper function before the XHR:

```javascript
async function encryptFileClientSide(file) {
  return new Promise((resolve, reject) => {
    const worker = new Worker('/static/js/aead-worker.js');
    const reader = new FileReader();
    reader.onload = (e) => {
      worker.postMessage({ type: 'encrypt', plaintext: e.target.result }, [e.target.result]);
    };
    worker.onmessage = (e) => {
      if (e.data.type === 'encrypted') {
        resolve({ ciphertext: e.data.ciphertext, keyBytes: e.data.keyBytes });
        worker.terminate();
      } else if (e.data.type === 'error') {
        reject(new Error(e.data.message));
        worker.terminate();
      }
    };
    reader.readAsArrayBuffer(file);
  });
}
```

For the success handler in the XHR `onload`, replace the existing handling with:

```javascript
function showSuccessModal(data, encMode) {
  const body = document.getElementById('success-body');
  const shareUrl = data.url;
  const rawUrl = data.raw_url;

  let html = `
    <div class="copy-row">
      <span class="copy-row-text" style="font-size:12px;word-break:break-all">${shareUrl}</span>
      <button class="btn btn-ghost btn-sm" onclick="navigator.clipboard.writeText('${shareUrl}')">Copy</button>
    </div>`;

  if (encMode === 'client' && data.file_key) {
    const ek = data.file_key;
    const shareWithKey = shareUrl + '#ek=' + ek;
    html += `
      <div class="text-xs text-muted mt-8">Share URL with key (client-side — never sent to server):</div>
      <div class="copy-row">
        <span class="copy-row-text" style="font-size:11px;word-break:break-all">${shareWithKey}</span>
        <button class="btn btn-ghost btn-sm" onclick="navigator.clipboard.writeText('${shareWithKey}')">Copy</button>
      </div>
      <div class="text-xs text-muted mt-8" style="color:var(--warning)">⚠ Save the key — it cannot be recovered from the server.</div>`;
  } else if (encMode === 'server' && data.file_key) {
    html += `<div class="text-xs text-muted mt-8">The <code>?ek=</code> key is embedded in the URL above.</div>`;
  }

  body.innerHTML = html;

  // QR code
  const qrWrap = document.getElementById('qr-wrap');
  drawQR(qrWrap, encMode === 'client' ? shareUrl + '#ek=' + data.file_key : shareUrl);

  document.getElementById('success-modal').classList.remove('hidden');
  document.getElementById('success-close').onclick = () => {
    document.getElementById('success-modal').classList.add('hidden');
  };
}

function drawQR(container, text) {
  // Simple QR using qrcode.js if available, else just show text
  container.innerHTML = '';
  if (typeof QRCode !== 'undefined') {
    new QRCode(container, { text, width: 120, height: 120, colorDark: '#e2e8f0', colorLight: '#1a1f2e' });
  } else {
    const a = document.createElement('a');
    a.href = text;
    a.textContent = 'Open link';
    a.className = 'btn btn-ghost btn-sm';
    container.appendChild(a);
  }
}
```

Download qrcode.min.js locally (no CDN — avoids SRI/supply-chain risk):

```
curl -Lo app/static/js/qrcode.min.js https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js
```

Then add to `files.html` head (served from own origin, no integrity concern):

```html
  <script src="/static/js/qrcode.min.js"></script>
```

Also hide the client-side encryption option if `can_upload_client_encrypted` is false. In the JS `init()` function where `/account/me` is called, add:

```javascript
if (!me.can_upload_client_encrypted) {
  const opt = document.querySelector('#opt-encrypt option[value="client"]');
  if (opt) opt.remove();
}
```

- [ ] **Step 3: Commit**

```
git add app/static/files.html app/static/js/files.js
git commit -m "feat: wire all upload options, client-side encryption flow, success QR modal"
```

---

### Task 11: Download page client-side decryption

**Files:**
- Modify: `app/static/js/download.js`

**Interfaces:**
- Consumes: `GET /file/{slug}/info` for file metadata.
- If `encryption_mode === "client"`: reads `#ek=` from URL fragment, fetches `/raw`, decrypts via `aead-worker.js`, triggers browser download with decrypted blob.
- If `encryption_mode === "server"`: `?ek=` already in URL if provided by share link; server handles decryption. Download button points to `/raw?ek=KEY`.
- If key missing: shows prompt.

- [ ] **Step 1: Read current `app/static/js/download.js` and identify where to add decryption**

```
type app\static\js\download.js
```

- [ ] **Step 2: Add `#ek=` handling to `download.js`**

Add this function near the top (after imports / at module level):

```javascript
function getFragmentKey() {
  const hash = window.location.hash;
  const match = hash.match(/[#&]ek=([^&]*)/);
  return match ? match[1] : null;
}

async function clientDecryptAndDownload(slug, fragmentKey, filename) {
  const statusEl = document.getElementById('dl-button');
  const origText = statusEl.textContent;
  statusEl.textContent = '⟳ Decrypting…';
  statusEl.style.pointerEvents = 'none';

  try {
    const resp = await fetch(`/file/${slug}/raw`);
    if (!resp.ok) throw new Error(`Download failed: ${resp.status}`);
    const ciphertext = await resp.arrayBuffer();

    // Decode key from base64url
    const pad = 4 - fragmentKey.length % 4;
    const b64 = (fragmentKey + '===='.slice(0, pad % 4)).replace(/-/g, '+').replace(/_/g, '/');
    const keyBytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));

    const plaintext = await new Promise((resolve, reject) => {
      const worker = new Worker('/static/js/aead-worker.js');
      worker.postMessage({ type: 'decrypt', ciphertext, key: keyBytes }, [ciphertext]);
      worker.onmessage = (e) => {
        worker.terminate();
        if (e.data.type === 'decrypted') resolve(e.data.plaintext);
        else reject(new Error(e.data.message));
      };
    });

    const blob = new Blob([plaintext]);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  } catch (err) {
    alert('Decryption failed: ' + err.message);
  } finally {
    statusEl.textContent = origText;
    statusEl.style.pointerEvents = '';
  }
}
```

In the existing code where the download button is set up (after file info is loaded), add:

```javascript
const fragmentKey = getFragmentKey();
const encMode = info.encryption_mode;

if (encMode === 'client') {
  if (fragmentKey) {
    dlButton.addEventListener('click', (e) => {
      e.preventDefault();
      clientDecryptAndDownload(slug, fragmentKey, info.filename);
    });
  } else {
    // Prompt for key
    dlButton.textContent = '🔑 Enter key to decrypt';
    dlButton.addEventListener('click', (e) => {
      e.preventDefault();
      const k = prompt('Paste the #ek= key from the share URL:');
      if (k) clientDecryptAndDownload(slug, k.trim(), info.filename);
    });
  }
} else if (encMode === 'server') {
  const urlEk = new URLSearchParams(window.location.search).get('ek');
  dlButton.href = `/file/${slug}/raw` + (urlEk ? `?ek=${urlEk}` : '');
} else {
  dlButton.href = `/file/${slug}/raw`;
}
```

- [ ] **Step 3: Commit**

```
git add app/static/js/download.js
git commit -m "feat: download page client-side decryption via #ek= fragment and aead-worker.js"
```

---

### Task 12: Admin panel API Keys tab

**Files:**
- Modify: `app/static/admin.html` (add API Keys tab)
- Modify: `app/static/js/admin.js` (add key management functions)

**Interfaces:**
- Consumes: `GET /keys/`, `POST /keys/`, `DELETE /keys/{id}`, `POST /keys/{id}/reset-ip`.
- Shows master's own keys and all keys (master sees all). Create, deactivate, reset-IP with password confirmation.

- [ ] **Step 1: Read `app/static/admin.html` to find the tabs section**

```
type app\static\admin.html
```

- [ ] **Step 2: Add API Keys tab to admin.html**

In the tabs nav, add after the last tab button:

```html
<button class="tab-btn" data-tab="keys">API Keys</button>
```

Add the tab panel (before closing `</div>` of the tabs container):

```html
    <div class="tab-panel hidden" id="tab-keys">
      <div class="flex items-center mb-16" style="gap:12px">
        <div class="section-label" style="margin:0;flex:1">API Keys</div>
        <button class="btn btn-ghost btn-sm" id="create-key-btn">+ New key</button>
      </div>
      <div class="text-xs text-muted mb-12">
        Keys bind to the first IP that uses them. 
        Use <code style="font-family:var(--font-mono)">Authorization: Bearer &lt;key&gt;</code>.
        <a href="/api-docs" style="color:var(--accent);text-decoration:none">API docs →</a>
      </div>
      <div id="keys-list">
        <div class="empty"><div class="empty-icon">⟳</div>Loading…</div>
      </div>
    </div>
```

Add key creation modal before `</body>`:

```html
  <div class="modal-overlay hidden" id="new-key-modal">
    <div class="modal">
      <div class="modal-title">New API Key</div>
      <div id="new-key-body"></div>
      <div class="modal-footer">
        <button class="btn btn-primary" id="new-key-close">Done</button>
      </div>
    </div>
  </div>

  <div class="modal-overlay hidden" id="reset-ip-modal">
    <div class="modal">
      <div class="modal-title">Reset key IP binding</div>
      <div class="form-group">
        <label>Confirm your password</label>
        <input type="password" id="reset-ip-pw" placeholder="Password">
      </div>
      <div class="modal-footer">
        <button class="btn btn-ghost" id="reset-ip-cancel">Cancel</button>
        <button class="btn btn-primary" id="reset-ip-confirm">Reset IP</button>
      </div>
    </div>
  </div>
```

- [ ] **Step 3: Add key management functions to `app/static/js/admin.js`**

Append to `admin.js`:

```javascript
// --- API Keys tab ---

async function loadKeys() {
  const resp = await apiGet('/keys/');
  const list = document.getElementById('keys-list');
  if (!resp.keys.length) {
    list.innerHTML = '<div class="empty"><div class="empty-icon">🔑</div>No API keys yet.</div>';
    return;
  }
  list.innerHTML = resp.keys.map(k => `
    <div class="file-card" style="margin-bottom:8px">
      <div class="file-card-header">
        <span class="file-name" style="font-family:var(--font-mono)">Key #${k.id}</span>
        <span class="file-meta">${k.bound_ip ? '📍 ' + k.bound_ip : 'unbound'}</span>
        <span class="file-meta" style="margin-left:8px">${k.active ? '✓ active' : '✗ inactive'}</span>
        ${k.active ? `
          <button class="btn btn-ghost btn-sm" onclick="resetKeyIP(${k.id})">Reset IP</button>
          <button class="btn btn-ghost btn-sm" style="color:var(--danger)" onclick="deactivateKey(${k.id})">Revoke</button>
        ` : ''}
      </div>
      <div style="padding:0 16px 10px;font-size:12px;color:var(--text-muted)">
        Created: ${new Date(k.created_at).toLocaleString()}
        ${k.last_used_at ? ' · Last used: ' + new Date(k.last_used_at).toLocaleString() : ''}
      </div>
    </div>
  `).join('');
}

async function createKey() {
  const resp = await apiPost('/keys/', {});
  const modal = document.getElementById('new-key-modal');
  document.getElementById('new-key-body').innerHTML = `
    <div class="text-sm mb-8" style="color:var(--warning)">⚠ Copy this key now — it won't be shown again.</div>
    <div style="background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius);padding:10px 14px;font-family:var(--font-mono);font-size:13px;word-break:break-all;margin-bottom:8px">${resp.key}</div>
    <button class="btn btn-ghost btn-sm" onclick="navigator.clipboard.writeText('${resp.key}')">Copy key</button>
  `;
  modal.classList.remove('hidden');
  document.getElementById('new-key-close').onclick = () => {
    modal.classList.add('hidden');
    loadKeys();
  };
}

async function deactivateKey(id) {
  if (!confirm('Revoke this key?')) return;
  await apiDelete(`/keys/${id}`);
  loadKeys();
}

let _resetKeyId = null;
function resetKeyIP(id) {
  _resetKeyId = id;
  document.getElementById('reset-ip-pw').value = '';
  document.getElementById('reset-ip-modal').classList.remove('hidden');
}

document.getElementById('reset-ip-cancel')?.addEventListener('click', () => {
  document.getElementById('reset-ip-modal').classList.add('hidden');
});
document.getElementById('reset-ip-confirm')?.addEventListener('click', async () => {
  const pw = document.getElementById('reset-ip-pw').value;
  if (!pw) return;
  await apiPost(`/keys/${_resetKeyId}/reset-ip`, { password: pw });
  document.getElementById('reset-ip-modal').classList.add('hidden');
  loadKeys();
});

document.getElementById('create-key-btn')?.addEventListener('click', createKey);

// Wire tab switching to load keys
document.querySelectorAll('.tab-btn[data-tab="keys"]').forEach(btn => {
  btn.addEventListener('click', loadKeys);
});
```

- [ ] **Step 4: Commit**

```
git add app/static/admin.html app/static/js/admin.js
git commit -m "feat: admin API Keys tab with create/revoke/reset-IP"
```

---

### Task 13: Shared test fixtures + key route tests + Range download tests

**Files:**
- Modify: `tests/conftest.py`
- Create: `tests/test_key_routes.py`
- Create: `tests/test_range_download.py`

- [ ] **Step 1: Write `tests/conftest.py`**

```python
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.deps import AppState


@pytest.fixture
def app_client(tmp_path):
    app = create_app(
        config_path=str(tmp_path / "app.env"),
        database_url="sqlite:///:memory:",
    )
    state: AppState = app.state.app_state
    with TestClient(app) as c:
        yield c, state


@pytest.fixture
def master_session(app_client):
    c, state = app_client
    bootstrap_pw = state.bootstrap_password
    r = c.post("/auth/login", json={"username": "admin", "password": bootstrap_pw})
    assert r.status_code == 200
    csrf1 = r.json()["csrf_token"]
    new_pw = "masterpass1234"
    c.post(
        "/account/change-credentials",
        json={"current_password": bootstrap_pw, "new_username": "admin", "new_password": new_pw},
        headers={"X-CSRF-Token": csrf1},
    )
    r2 = c.post("/auth/login", json={"username": "admin", "password": new_pw})
    assert r2.status_code == 200
    csrf2 = r2.json()["csrf_token"]
    return c, csrf2, new_pw
```

- [ ] **Step 2: Write `tests/test_key_routes.py`**

```python
from __future__ import annotations


def _create_key(c, csrf):
    return c.post("/keys/", headers={"X-CSRF-Token": csrf})


def test_create_key_success(master_session):
    c, csrf, _ = master_session
    r = _create_key(c, csrf)
    assert r.status_code == 200
    d = r.json()
    assert "key" in d and len(d["key"]) > 20
    assert "id" in d


def test_list_keys_no_raw_key(master_session):
    c, csrf, _ = master_session
    _create_key(c, csrf)
    r = c.get("/keys/")
    assert r.status_code == 200
    for k in r.json()["keys"]:
        assert "key" not in k
        assert "key_hash" not in k


def test_deactivate_key(master_session):
    c, csrf, _ = master_session
    key_id = _create_key(c, csrf).json()["id"]
    r = c.delete(f"/keys/{key_id}", headers={"X-CSRF-Token": csrf})
    assert r.status_code == 200
    keys = c.get("/keys/").json()["keys"]
    k = next(x for x in keys if x["id"] == key_id)
    assert k["active"] is False


def test_reset_ip_success(master_session):
    c, csrf, pw = master_session
    key_id = _create_key(c, csrf).json()["id"]
    r = c.post(f"/keys/{key_id}/reset-ip", json={"password": pw}, headers={"X-CSRF-Token": csrf})
    assert r.status_code == 200
    assert r.json()["status"] == "ip_reset"


def test_reset_ip_wrong_password(master_session):
    c, csrf, _ = master_session
    key_id = _create_key(c, csrf).json()["id"]
    r = c.post(f"/keys/{key_id}/reset-ip", json={"password": "wrongpw"}, headers={"X-CSRF-Token": csrf})
    assert r.status_code == 401


def test_me_includes_can_use_api_keys(master_session):
    c, csrf, _ = master_session
    r = c.get("/account/me")
    assert r.status_code == 200
    assert "can_use_api_keys" in r.json()
```

- [ ] **Step 3: Write `tests/test_range_download.py`**

```python
from __future__ import annotations


def _upload(c, csrf, content=b"0123456789abcdef"):
    r = c.post(
        "/files/upload",
        files={"file": ("r.bin", content, "application/octet-stream")},
        data={"original_filename": "r.bin"},
        headers={"X-CSRF-Token": csrf},
    )
    return r.json()["slug"]


def test_full_download_200(master_session):
    c, csrf, _ = master_session
    slug = _upload(c, csrf)
    r = c.get(f"/file/{slug}/raw")
    assert r.status_code == 200
    assert r.headers.get("Accept-Ranges") == "bytes"


def test_range_returns_206(master_session):
    c, csrf, _ = master_session
    slug = _upload(c, csrf, b"0123456789abcdef")
    r = c.get(f"/file/{slug}/raw", headers={"Range": "bytes=0-4"})
    assert r.status_code == 206
    assert r.content == b"01234"
    assert r.headers["Content-Range"] == "bytes 0-4/16"


def test_range_to_end(master_session):
    c, csrf, _ = master_session
    slug = _upload(c, csrf, b"hello world")
    r = c.get(f"/file/{slug}/raw", headers={"Range": "bytes=6-"})
    assert r.status_code == 206
    assert r.content == b"world"


def test_range_suffix(master_session):
    c, csrf, _ = master_session
    slug = _upload(c, csrf, b"hello world")
    r = c.get(f"/file/{slug}/raw", headers={"Range": "bytes=-5"})
    assert r.status_code == 206
    assert r.content == b"world"


def test_range_invalid_416(master_session):
    c, csrf, _ = master_session
    slug = _upload(c, csrf, b"hello")
    r = c.get(f"/file/{slug}/raw", headers={"Range": "bytes=10-20"})
    assert r.status_code == 416
```

- [ ] **Step 4: Run all tests**

```
.\.venv\Scripts\python.exe -m pytest tests/test_aead.py tests/test_compress.py tests/test_key_routes.py tests/test_range_download.py -v
```

Expected: all pass (fix any failures before moving on).

- [ ] **Step 5: Commit**

```
git add tests/
git commit -m "test: conftest fixtures, key route tests, Range download tests"
```

---

## Self-Review Checklist

**Spec coverage (§ references):**
- §4.1 Chunked AEAD → Task 2 (Python) + Task 9 (JS worker)
- §4 server-side encryption (`?ek=`) → Task 4 upload + Task 5 download
- §4 client-side encryption (`#ek=`) → Task 9 + Task 10 + Task 11
- §5 archival/compression → Task 3 + Task 4 (upload compress) + Task 5 (download decompress) + Task 6 (scheduler)
- §5 quota / `stored_size_bytes` → Task 4 (updated after pipeline)
- §6 API keys → Task 7 routes + Task 12 admin UI
- §6 dual auth / CSRF exempt for Bearer → Task 4 (`get_upload_user`)
- §7 all upload options → Task 10 frontend + Task 4 backend
- §7 QR + decrypt snippets on success → Task 10
- §8 Range downloads → Task 5
- §8 archived files unarchived before download → Task 5
- §9 API keys tab in admin panel → Task 12
- API docs page → Task 8

**Missing from spec that is deferred (not P2P):**
- TOTP/WebAuthn 2FA — pre-existing gap, not in this plan scope
- Folder zip-on-upload (client-side) — not in this plan (UI mode exists but zip worker not implemented)
- Tus resumable uploads — replaced by simple multipart POST; Tus is Phase 2
- Brute-force lockout UI display — backend exists, not wired to login page yet
