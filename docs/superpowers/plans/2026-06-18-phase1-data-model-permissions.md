# Phase 1 — Data Model, Roles & Permissions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the remaining persistent data model (files, links, permissions, api_keys, credentials), the at-rest encryption primitive, and role/permission enforcement — the foundation every upload/download/panel feature builds on.

**Architecture:** Extends the existing SQLAlchemy 2.0 + SQLite layer (`app/db.py` `Base`/`UTCDateTime`, `init_db`). Each new table is one focused model module. A small `app/security/secretbox.py` provides AES-256-GCM seal/open under the first-run master key (used for server-side per-file key wrapping and TOTP secrets). Permission checks and role gates are FastAPI dependencies layered on the existing `require_active_user`. API keys authenticate via `Authorization: Bearer` (not the session cookie) and bind to the first IP that uses them.

**Tech Stack:** FastAPI, SQLAlchemy 2.0 (sync), SQLite, `cryptography` (AES-256-GCM AEAD), pytest. Python 3.12 in `.venv` (run tests with `./.venv/Scripts/python.exe -m pytest <path> -q`).

## Global Constraints

- All datetime columns MUST use `app.db.UTCDateTime` (SQLite strips tzinfo otherwise). Use `_utcnow()` (`datetime.now(timezone.utc)`) for defaults, matching existing models.
- Every new model MUST be imported in `app.db.init_db` before `create_all`, or its table is never created.
- Foreign keys are enforced (`PRAGMA foreign_keys=ON` is already set in `make_engine`). All FKs to `users.id`.
- At-rest encryption is **AES-256-GCM with a random 12-byte IV** (never raw/ECB). The 32-byte master key comes from `app.config.get_master_key(settings)`; it is never logged.
- Public link slugs are `secrets.token_urlsafe(16)` (≈128 bits), non-enumerable, unique.
- `max_uses` enforcement MUST be atomic: `UPDATE links SET use_count = use_count + 1 WHERE id = ? AND (max_uses IS NULL OR use_count < max_uses)` checked by rowcount — never read-modify-write.
- API keys: stored hashed (SHA-256), the plaintext key shown once; bind to the first IP that uses them (`bound_ip` NULL until first use); requests from any other IP are rejected. Client IP via the existing `app.deps.client_ip` (one proxy hop).
- `can_upload_client_encrypted` defaults **off**. Quota defaults: **10 GB/file**, **100 GB/user total**.
- Secrets/keys never stored or logged in plaintext; passwords already handled by `app.security.passwords`.
- Roles are `master` | `user`. Master manages everything; user manages only their own.

---

### Task 1: At-rest secret box (AES-256-GCM seal/open)

**Files:**
- Modify: `pyproject.toml` (add `cryptography` dependency)
- Create: `app/security/secretbox.py`
- Test: `tests/test_secretbox.py`

**Interfaces:**
- Consumes: nothing (takes raw 32-byte key as argument).
- Produces:
  - `seal(key: bytes, plaintext: bytes, aad: bytes = b"") -> bytes` — returns `iv(12) || ciphertext || tag(16)` as one bytestring.
  - `open_box(key: bytes, blob: bytes, aad: bytes = b"") -> bytes` — inverse; raises `cryptography.exceptions.InvalidTag` on tamper/wrong key.

- [ ] **Step 1: Add the dependency**

In `pyproject.toml`, add `"cryptography>=43"` to the `dependencies` list (alongside the existing entries). Then install:

```bash
./.venv/Scripts/python.exe -m pip install "cryptography>=43"
```

- [ ] **Step 2: Write the failing test**

`tests/test_secretbox.py`:
```python
import os

import pytest
from cryptography.exceptions import InvalidTag

from app.security.secretbox import seal, open_box


def test_round_trip():
    key = os.urandom(32)
    pt = b"the quick brown fox"
    blob = seal(key, pt)
    assert blob != pt
    assert open_box(key, blob) == pt


def test_unique_iv_per_seal():
    key = os.urandom(32)
    a = seal(key, b"same")
    b = seal(key, b"same")
    assert a != b  # random IV => different ciphertext each time


def test_tamper_is_rejected():
    key = os.urandom(32)
    blob = bytearray(seal(key, b"data"))
    blob[-1] ^= 0x01  # flip a tag bit
    with pytest.raises(InvalidTag):
        open_box(key, bytes(blob))


def test_wrong_key_is_rejected():
    blob = seal(os.urandom(32), b"data")
    with pytest.raises(InvalidTag):
        open_box(os.urandom(32), blob)


def test_aad_mismatch_is_rejected():
    key = os.urandom(32)
    blob = seal(key, b"data", aad=b"file:1")
    with pytest.raises(InvalidTag):
        open_box(key, blob, aad=b"file:2")
```

- [ ] **Step 3: Run test to verify it fails**

Run: `./.venv/Scripts/python.exe -m pytest tests/test_secretbox.py -q`
Expected: FAIL — `ModuleNotFoundError: app.security.secretbox`.

- [ ] **Step 4: Implement**

`app/security/secretbox.py`:
```python
from __future__ import annotations

import os

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

IV_LEN = 12


def seal(key: bytes, plaintext: bytes, aad: bytes = b"") -> bytes:
    """Encrypt with AES-256-GCM under a fresh random 12-byte IV.

    Returns iv || ciphertext || tag. The IV is generated per call and never
    reused. `aad` is authenticated but not encrypted.
    """
    iv = os.urandom(IV_LEN)
    ct = AESGCM(key).encrypt(iv, plaintext, aad)
    return iv + ct


def open_box(key: bytes, blob: bytes, aad: bytes = b"") -> bytes:
    """Inverse of seal(). Raises cryptography InvalidTag on tamper/wrong key."""
    iv, ct = blob[:IV_LEN], blob[IV_LEN:]
    return AESGCM(key).decrypt(iv, ct, aad)
```

- [ ] **Step 5: Run test to verify it passes**

Run: `./.venv/Scripts/python.exe -m pytest tests/test_secretbox.py -q`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add pyproject.toml app/security/secretbox.py tests/test_secretbox.py
git commit -m "feat: at-rest AES-256-GCM secret box under master key"
```

---

### Task 2: Permissions model

**Files:**
- Create: `app/models/permission.py`
- Modify: `app/db.py:70-76` (register model in `init_db`)
- Test: `tests/test_permission_model.py`

**Interfaces:**
- Consumes: `Base`, `UTCDateTime` from `app.db`; `users.id` FK.
- Produces: `Permission` ORM model with columns: `id` (pk), `user_id` (FK users.id, unique — one row per user), `can_upload` (bool, default True), `can_upload_client_encrypted` (bool, default False), `can_delete` (bool, default True), `can_regenerate_links` (bool, default True), `can_use_api_keys` (bool, default False), `can_use_p2p` (bool, default False), `quota_bytes` (int, default 100 * 1024**3), `max_file_bytes` (int, default 10 * 1024**3), `archive_after_idle_days` (int, default 5), `created_at`.

- [ ] **Step 1: Write the failing test**

`tests/test_permission_model.py`:
```python
from app.db import Base, make_engine, make_session_factory, init_db
from app.models.user import User
from app.models.permission import Permission


def _session():
    engine = make_engine("sqlite:///:memory:")
    init_db(engine)
    return make_session_factory(engine)()


def test_permission_defaults():
    s = _session()
    u = User(username="u", password_hash="x", role="user")
    s.add(u)
    s.flush()
    p = Permission(user_id=u.id)
    s.add(p)
    s.commit()

    got = s.query(Permission).filter_by(user_id=u.id).one()
    assert got.can_upload is True
    assert got.can_upload_client_encrypted is False
    assert got.can_use_api_keys is False
    assert got.can_use_p2p is False
    assert got.quota_bytes == 100 * 1024 ** 3
    assert got.max_file_bytes == 10 * 1024 ** 3
    assert got.archive_after_idle_days == 5
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./.venv/Scripts/python.exe -m pytest tests/test_permission_model.py -q`
Expected: FAIL — `ModuleNotFoundError: app.models.permission`.

- [ ] **Step 3: Implement the model**

`app/models/permission.py`:
```python
from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import Boolean, BigInteger, ForeignKey, Integer
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base, UTCDateTime

_GB = 1024 ** 3


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Permission(Base):
    __tablename__ = "permissions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("users.id"), unique=True, nullable=False
    )
    can_upload: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    can_upload_client_encrypted: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False
    )
    can_delete: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    can_regenerate_links: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True
    )
    can_use_api_keys: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False
    )
    can_use_p2p: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    quota_bytes: Mapped[int] = mapped_column(
        BigInteger, nullable=False, default=100 * _GB
    )
    max_file_bytes: Mapped[int] = mapped_column(
        BigInteger, nullable=False, default=10 * _GB
    )
    archive_after_idle_days: Mapped[int] = mapped_column(
        Integer, nullable=False, default=5
    )
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=_utcnow)
```

- [ ] **Step 4: Register the model in `init_db`**

In `app/db.py`, inside `init_db`, add to the import block (after the `login_attempt` import):
```python
    from app.models import permission as _permission  # noqa: F401
```

- [ ] **Step 5: Run test to verify it passes**

Run: `./.venv/Scripts/python.exe -m pytest tests/test_permission_model.py -q`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add app/models/permission.py app/db.py tests/test_permission_model.py
git commit -m "feat: permissions model with spec defaults"
```

---

### Task 3: Permission policy service

**Files:**
- Create: `app/permissions/__init__.py` (empty)
- Create: `app/permissions/policy.py`
- Test: `tests/test_permission_policy.py`

**Interfaces:**
- Consumes: `Permission` model, a `Session`.
- Produces:
  - `ensure_permissions(session, user_id, *, master=False) -> Permission` — returns the user's Permission row, creating it (flush, no commit) if absent. When `master=True`, the created row has every boolean flag True (a master may do anything). Idempotent: returns the existing row unchanged if one exists.
  - `get_permissions(session, user_id) -> Permission | None`.
  - `has_permission(perm: Permission, name: str) -> bool` — reads the named boolean attribute; raises `AttributeError` for an unknown name (fail-closed against typos).

- [ ] **Step 1: Write the failing test**

`tests/test_permission_policy.py`:
```python
import pytest

from app.db import make_engine, make_session_factory, init_db
from app.models.user import User
from app.permissions.policy import ensure_permissions, get_permissions, has_permission


def _session():
    engine = make_engine("sqlite:///:memory:")
    init_db(engine)
    return make_session_factory(engine)()


def _user(s, role="user"):
    u = User(username=f"u{role}", password_hash="x", role=role)
    s.add(u)
    s.flush()
    return u


def test_ensure_creates_user_defaults():
    s = _session()
    u = _user(s)
    p = ensure_permissions(s, u.id)
    assert p.can_upload is True
    assert p.can_use_api_keys is False


def test_ensure_master_enables_everything():
    s = _session()
    u = _user(s, role="master")
    p = ensure_permissions(s, u.id, master=True)
    assert p.can_use_api_keys is True
    assert p.can_upload_client_encrypted is True
    assert p.can_use_p2p is True


def test_ensure_is_idempotent():
    s = _session()
    u = _user(s)
    first = ensure_permissions(s, u.id)
    first.can_use_api_keys = True
    s.flush()
    second = ensure_permissions(s, u.id)
    assert second.id == first.id
    assert second.can_use_api_keys is True  # not reset


def test_get_returns_none_when_absent():
    s = _session()
    u = _user(s)
    assert get_permissions(s, u.id) is None


def test_has_permission_reads_flag():
    s = _session()
    u = _user(s)
    p = ensure_permissions(s, u.id)
    assert has_permission(p, "can_upload") is True
    assert has_permission(p, "can_use_p2p") is False


def test_has_permission_unknown_name_raises():
    s = _session()
    u = _user(s)
    p = ensure_permissions(s, u.id)
    with pytest.raises(AttributeError):
        has_permission(p, "can_fly")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./.venv/Scripts/python.exe -m pytest tests/test_permission_policy.py -q`
Expected: FAIL — `ModuleNotFoundError: app.permissions.policy`.

- [ ] **Step 3: Implement**

`app/permissions/__init__.py`: empty file.

`app/permissions/policy.py`:
```python
from __future__ import annotations

from sqlalchemy.orm import Session

from app.models.permission import Permission

_BOOL_FLAGS = (
    "can_upload",
    "can_upload_client_encrypted",
    "can_delete",
    "can_regenerate_links",
    "can_use_api_keys",
    "can_use_p2p",
)


def get_permissions(session: Session, user_id: int) -> Permission | None:
    return session.query(Permission).filter_by(user_id=user_id).one_or_none()


def ensure_permissions(session: Session, user_id: int, *, master: bool = False) -> Permission:
    existing = get_permissions(session, user_id)
    if existing is not None:
        return existing
    perm = Permission(user_id=user_id)
    if master:
        for flag in _BOOL_FLAGS:
            setattr(perm, flag, True)
    session.add(perm)
    session.flush()
    return perm


def has_permission(perm: Permission, name: str) -> bool:
    if name not in _BOOL_FLAGS:
        raise AttributeError(f"unknown permission flag: {name}")
    return bool(getattr(perm, name))
```

- [ ] **Step 4: Run test to verify it passes**

Run: `./.venv/Scripts/python.exe -m pytest tests/test_permission_policy.py -q`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add app/permissions/ tests/test_permission_policy.py
git commit -m "feat: permission policy service (ensure/get/has)"
```

---

### Task 4: Role and permission dependencies

**Files:**
- Modify: `app/deps.py` (add `require_master`, `require_permission`)
- Test: `tests/test_role_deps.py`

**Interfaces:**
- Consumes: `require_active_user` (returns `User`), `get_db`, `ensure_permissions`/`has_permission`.
- Produces:
  - `require_master(user: User = Depends(require_active_user)) -> User` — raises 403 (`detail="master only"`) if `user.role != "master"`, else returns the user.
  - `require_permission(name: str) -> Callable` — a dependency factory; the returned dependency loads the user's Permission row (creating defaults if absent) and raises 403 (`detail="permission denied: <name>"`) when the flag is False, else returns the `User`.

- [ ] **Step 1: Write the failing test**

`tests/test_role_deps.py`:
```python
import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from app.main import create_app
from app.deps import require_master, require_permission, get_db, require_active_user
from app.models.user import User
from app.permissions.policy import ensure_permissions


@pytest.fixture
def client(tmp_path):
    app = create_app(config_path=str(tmp_path / "app.env"),
                     database_url="sqlite:///:memory:")
    # Test-only routes exercising the guards.
    @app.get("/_t/master")
    def _master(u: User = Depends(require_master)):
        return {"u": u.username}

    @app.get("/_t/p2p")
    def _p2p(u: User = Depends(require_permission("can_use_p2p"))):
        return {"u": u.username}

    with TestClient(app) as c:
        yield c, app.state.app_state


def _login_and_change(c, state):
    # Bootstrap admin is master but flagged; change creds to clear the flag.
    csrf = c.post("/auth/login",
                  json={"username": "admin", "password": state.bootstrap_password}
                  ).json()["csrf_token"]
    c.post("/account/change-credentials", headers={"X-CSRF-Token": csrf},
           json={"new_username": "boss", "current_password": state.bootstrap_password,
                 "new_password": "a-strong-new-password"})
    return csrf


def test_master_passes_master_gate(client):
    c, state = client
    _login_and_change(c, state)
    assert c.get("/_t/master").status_code == 200


def test_permission_denied_when_flag_false(client):
    c, state = client
    _login_and_change(c, state)
    # Master bootstrap grants all perms, so flip can_use_p2p off to prove the gate.
    with state.session_factory() as s:
        u = s.query(User).filter_by(username="boss").one()
        p = ensure_permissions(s, u.id)
        p.can_use_p2p = False
        s.commit()
    assert c.get("/_t/p2p").status_code == 403


def test_permission_allows_when_flag_true(client):
    c, state = client
    _login_and_change(c, state)
    with state.session_factory() as s:
        u = s.query(User).filter_by(username="boss").one()
        p = ensure_permissions(s, u.id)
        p.can_use_p2p = True
        s.commit()
    assert c.get("/_t/p2p").status_code == 200
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./.venv/Scripts/python.exe -m pytest tests/test_role_deps.py -q`
Expected: FAIL — `ImportError: cannot import name 'require_master'`.

- [ ] **Step 3: Implement in `app/deps.py`**

Add these imports at the top of `app/deps.py` (alongside existing imports):
```python
from typing import Callable
```
Add to the bottom of `app/deps.py`:
```python
def require_master(user: User = Depends(require_active_user)) -> User:
    if user.role != "master":
        raise HTTPException(status_code=403, detail="master only")
    return user


def require_permission(name: str) -> Callable[..., User]:
    from app.permissions.policy import ensure_permissions, has_permission

    def _dep(user: User = Depends(require_active_user),
             db: Session = Depends(get_db)) -> User:
        perm = ensure_permissions(db, user.id, master=(user.role == "master"))
        db.commit()
        if not has_permission(perm, name):
            raise HTTPException(status_code=403, detail=f"permission denied: {name}")
        return user

    return _dep
```

- [ ] **Step 4: Run test to verify it passes**

Run: `./.venv/Scripts/python.exe -m pytest tests/test_role_deps.py -q`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add app/deps.py tests/test_role_deps.py
git commit -m "feat: require_master and require_permission dependencies"
```

---

### Task 5: File model

**Files:**
- Create: `app/models/file.py`
- Modify: `app/db.py` (register model in `init_db`)
- Test: `tests/test_file_model.py`

**Interfaces:**
- Consumes: `Base`, `UTCDateTime`; `users.id` FK.
- Produces: `FileObject` ORM model, `__tablename__ = "files"`, columns:
  - `id` (pk), `owner_id` (FK users.id, nullable=False)
  - `storage_path` (str, nullable=False) — internal random path on disk
  - `original_filename` (str, nullable=False)
  - `size_bytes` (BigInteger, default 0) — plaintext logical size
  - `stored_size_bytes` (BigInteger, default 0) — actual bytes on disk
  - `content_type` (str, default "application/octet-stream")
  - `encryption_mode` (str, default "none") — one of `none|server|client`
  - `compressed` (bool, default False)
  - `archived` (bool, default False)
  - `archive_codec` (str, nullable=True)
  - `lifecycle_state` (str, default "active") — one of `active|archiving|archived|unarchiving`
  - `is_permanent` (bool, default True)
  - `expires_at` (UTCDateTime, nullable=True) — temp-storage expiry
  - `delete_if_idle_days` (int, nullable=True) — delete if not downloaded in N days
  - `auto_unarchive_on_download` (bool, default True)
  - `created_at` (UTCDateTime), `last_downloaded_at` (UTCDateTime, nullable=True)

- [ ] **Step 1: Write the failing test**

`tests/test_file_model.py`:
```python
from app.db import make_engine, make_session_factory, init_db
from app.models.user import User
from app.models.file import FileObject


def _session():
    engine = make_engine("sqlite:///:memory:")
    init_db(engine)
    return make_session_factory(engine)()


def test_file_defaults():
    s = _session()
    u = User(username="o", password_hash="x", role="user")
    s.add(u)
    s.flush()
    f = FileObject(owner_id=u.id, storage_path="ab/cd/rand", original_filename="x.txt")
    s.add(f)
    s.commit()

    got = s.query(FileObject).one()
    assert got.encryption_mode == "none"
    assert got.lifecycle_state == "active"
    assert got.is_permanent is True
    assert got.archived is False
    assert got.auto_unarchive_on_download is True
    assert got.size_bytes == 0
    assert got.last_downloaded_at is None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./.venv/Scripts/python.exe -m pytest tests/test_file_model.py -q`
Expected: FAIL — `ModuleNotFoundError: app.models.file`.

- [ ] **Step 3: Implement the model**

`app/models/file.py`:
```python
from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import BigInteger, Boolean, ForeignKey, Integer, String
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
    compressed: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    archived: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    archive_codec: Mapped[str | None] = mapped_column(String(16), nullable=True)
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

- [ ] **Step 4: Register the model in `init_db`**

In `app/db.py` `init_db`, add after the `permission` import:
```python
    from app.models import file as _file  # noqa: F401
```

- [ ] **Step 5: Run test to verify it passes**

Run: `./.venv/Scripts/python.exe -m pytest tests/test_file_model.py -q`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add app/models/file.py app/db.py tests/test_file_model.py
git commit -m "feat: file object model with retention/encryption fields"
```

---

### Task 6: Link model + slug generator

**Files:**
- Create: `app/links/__init__.py` (empty)
- Create: `app/links/slugs.py`
- Create: `app/models/link.py`
- Modify: `app/db.py` (register model in `init_db`)
- Test: `tests/test_link_model.py`

**Interfaces:**
- Consumes: `Base`, `UTCDateTime`; `files.id` FK.
- Produces:
  - `app.links.slugs.new_slug() -> str` — `secrets.token_urlsafe(16)`.
  - `Link` ORM model, `__tablename__ = "links"`, columns: `id` (pk), `file_id` (FK files.id, nullable=False), `slug` (str, unique, nullable=False, indexed), `max_uses` (int, nullable=True — NULL = unlimited), `use_count` (int, default 0), `expires_at` (UTCDateTime, nullable=True), `active` (bool, default True), `created_at`.

- [ ] **Step 1: Write the failing test**

`tests/test_link_model.py`:
```python
from app.db import make_engine, make_session_factory, init_db
from app.links.slugs import new_slug
from app.models.user import User
from app.models.file import FileObject
from app.models.link import Link


def _session():
    engine = make_engine("sqlite:///:memory:")
    init_db(engine)
    return make_session_factory(engine)()


def test_slug_is_random_and_urlsafe():
    a, b = new_slug(), new_slug()
    assert a != b
    assert len(a) >= 22  # token_urlsafe(16) ~ 22 chars
    assert "/" not in a and "+" not in a


def test_link_defaults_and_fk():
    s = _session()
    u = User(username="o", password_hash="x", role="user")
    s.add(u)
    s.flush()
    f = FileObject(owner_id=u.id, storage_path="p", original_filename="x")
    s.add(f)
    s.flush()
    link = Link(file_id=f.id, slug=new_slug())
    s.add(link)
    s.commit()

    got = s.query(Link).one()
    assert got.use_count == 0
    assert got.max_uses is None
    assert got.active is True
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./.venv/Scripts/python.exe -m pytest tests/test_link_model.py -q`
Expected: FAIL — `ModuleNotFoundError: app.links.slugs`.

- [ ] **Step 3: Implement slug + model**

`app/links/__init__.py`: empty file.

`app/links/slugs.py`:
```python
from __future__ import annotations

import secrets


def new_slug() -> str:
    """A non-enumerable public link slug (~128 bits of entropy)."""
    return secrets.token_urlsafe(16)
```

`app/models/link.py`:
```python
from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import Boolean, ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base, UTCDateTime


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Link(Base):
    __tablename__ = "links"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    file_id: Mapped[int] = mapped_column(Integer, ForeignKey("files.id"), nullable=False)
    slug: Mapped[str] = mapped_column(String(64), unique=True, nullable=False, index=True)
    max_uses: Mapped[int | None] = mapped_column(Integer, nullable=True)
    use_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    expires_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
    active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=_utcnow)
```

- [ ] **Step 4: Register the model in `init_db`**

In `app/db.py` `init_db`, add after the `file` import:
```python
    from app.models import link as _link  # noqa: F401
```

- [ ] **Step 5: Run test to verify it passes**

Run: `./.venv/Scripts/python.exe -m pytest tests/test_link_model.py -q`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add app/links/ app/models/link.py app/db.py tests/test_link_model.py
git commit -m "feat: link model + random slug generator"
```

---

### Task 7: Atomic link-use consumption

**Files:**
- Create: `app/links/consume.py`
- Test: `tests/test_link_consume.py`

**Interfaces:**
- Consumes: `Link` model, a `Session`. Uses `app.models.link` table directly via Core `update()`.
- Produces:
  - `resolve_active_link(session, slug, now=None) -> Link | None` — returns the Link only if `active` and not expired (`expires_at is None or expires_at > now`); else None. `now` defaults to `datetime.now(timezone.utc)`.
  - `consume_use(session, slug, now=None) -> bool` — atomically increments `use_count` with `UPDATE ... WHERE slug=? AND active AND (expires_at IS NULL OR expires_at > now) AND (max_uses IS NULL OR use_count < max_uses)`; returns True iff exactly one row changed (rowcount == 1). Caller commits. No read-modify-write.

- [ ] **Step 1: Write the failing test**

`tests/test_link_consume.py`:
```python
from datetime import datetime, timedelta, timezone

from app.db import make_engine, make_session_factory, init_db
from app.models.user import User
from app.models.file import FileObject
from app.models.link import Link
from app.links.slugs import new_slug
from app.links.consume import resolve_active_link, consume_use


def _setup():
    engine = make_engine("sqlite:///:memory:")
    init_db(engine)
    return make_session_factory(engine)()


def _file(s):
    u = User(username="o", password_hash="x", role="user")
    s.add(u)
    s.flush()
    f = FileObject(owner_id=u.id, storage_path="p", original_filename="x")
    s.add(f)
    s.flush()
    return f


def test_consume_respects_max_uses():
    s = _setup()
    f = _file(s)
    slug = new_slug()
    s.add(Link(file_id=f.id, slug=slug, max_uses=2))
    s.commit()

    assert consume_use(s, slug) is True
    s.commit()
    assert consume_use(s, slug) is True
    s.commit()
    assert consume_use(s, slug) is False  # cap reached
    s.commit()
    assert s.query(Link).filter_by(slug=slug).one().use_count == 2


def test_unlimited_uses_when_max_is_null():
    s = _setup()
    f = _file(s)
    slug = new_slug()
    s.add(Link(file_id=f.id, slug=slug, max_uses=None))
    s.commit()
    for _ in range(5):
        assert consume_use(s, slug) is True
        s.commit()


def test_resolve_skips_expired_and_inactive():
    s = _setup()
    f = _file(s)
    past = datetime.now(timezone.utc) - timedelta(hours=1)
    expired = new_slug()
    inactive = new_slug()
    s.add(Link(file_id=f.id, slug=expired, expires_at=past))
    s.add(Link(file_id=f.id, slug=inactive, active=False))
    s.commit()
    assert resolve_active_link(s, expired) is None
    assert resolve_active_link(s, inactive) is None
    assert consume_use(s, expired) is False
    assert consume_use(s, inactive) is False


def test_resolve_returns_live_link():
    s = _setup()
    f = _file(s)
    slug = new_slug()
    s.add(Link(file_id=f.id, slug=slug))
    s.commit()
    assert resolve_active_link(s, slug).slug == slug
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./.venv/Scripts/python.exe -m pytest tests/test_link_consume.py -q`
Expected: FAIL — `ModuleNotFoundError: app.links.consume`.

- [ ] **Step 3: Implement**

`app/links/consume.py`:
```python
from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import and_, or_, update
from sqlalchemy.orm import Session

from app.models.link import Link


def _now(now: datetime | None) -> datetime:
    return now or datetime.now(timezone.utc)


def resolve_active_link(session: Session, slug: str, now: datetime | None = None) -> Link | None:
    now = _now(now)
    link = session.query(Link).filter_by(slug=slug).one_or_none()
    if link is None or not link.active:
        return None
    if link.expires_at is not None and link.expires_at <= now:
        return None
    return link


def consume_use(session: Session, slug: str, now: datetime | None = None) -> bool:
    """Atomically claim one use. Returns True iff a row was consumed.

    The WHERE clause enforces active/expiry/max_uses in a single statement so
    there is no read-modify-write race on use_count. Caller commits.
    """
    now = _now(now)
    stmt = (
        update(Link)
        .where(
            and_(
                Link.slug == slug,
                Link.active.is_(True),
                or_(Link.expires_at.is_(None), Link.expires_at > now),
                or_(Link.max_uses.is_(None), Link.use_count < Link.max_uses),
            )
        )
        .values(use_count=Link.use_count + 1)
    )
    result = session.execute(stmt)
    return result.rowcount == 1
```

- [ ] **Step 4: Run test to verify it passes**

Run: `./.venv/Scripts/python.exe -m pytest tests/test_link_consume.py -q`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add app/links/consume.py tests/test_link_consume.py
git commit -m "feat: atomic link-use consumption (rowcount-checked)"
```

---

### Task 8: API key model + security helpers

**Files:**
- Create: `app/models/api_key.py`
- Create: `app/security/api_keys.py`
- Modify: `app/db.py` (register model in `init_db`)
- Test: `tests/test_api_keys.py`

**Interfaces:**
- Consumes: `Base`, `UTCDateTime`; `users.id` FK; `app.deps.client_ip` (in Task 9, not here).
- Produces:
  - `ApiKey` ORM model, `__tablename__ = "api_keys"`, columns: `id` (pk), `owner_id` (FK users.id, nullable=False), `key_hash` (str, unique, nullable=False, indexed), `bound_ip` (str, nullable=True), `active` (bool, default True), `created_at`, `last_used_at` (UTCDateTime, nullable=True).
  - `app.security.api_keys.generate_key() -> str` — `secrets.token_urlsafe(32)` (shown once).
  - `hash_key(plain: str) -> str` — hex SHA-256.
  - `bind_or_reject(api_key: ApiKey, ip: str, now: datetime) -> bool` — if `bound_ip is None`, set it to `ip`, set `last_used_at=now`, return True (first use binds). If `bound_ip == ip`, set `last_used_at=now`, return True. Otherwise return False (mismatched IP) and mutate nothing. Mutates the passed row; caller flushes/commits.

- [ ] **Step 1: Write the failing test**

`tests/test_api_keys.py`:
```python
from datetime import datetime, timezone

from app.db import make_engine, make_session_factory, init_db
from app.models.user import User
from app.models.api_key import ApiKey
from app.security.api_keys import generate_key, hash_key, bind_or_reject


def _session():
    engine = make_engine("sqlite:///:memory:")
    init_db(engine)
    return make_session_factory(engine)()


def test_generate_is_random_and_long():
    a, b = generate_key(), generate_key()
    assert a != b
    assert len(a) >= 40


def test_hash_is_stable_and_hex():
    h = hash_key("abc")
    assert h == hash_key("abc")
    assert len(h) == 64
    int(h, 16)  # valid hex


def test_first_use_binds_ip():
    now = datetime.now(timezone.utc)
    k = ApiKey(owner_id=1, key_hash=hash_key("x"))
    assert bind_or_reject(k, "10.0.0.5", now) is True
    assert k.bound_ip == "10.0.0.5"
    assert k.last_used_at == now


def test_same_ip_allowed_updates_last_used():
    now = datetime.now(timezone.utc)
    k = ApiKey(owner_id=1, key_hash=hash_key("x"), bound_ip="10.0.0.5")
    assert bind_or_reject(k, "10.0.0.5", now) is True
    assert k.last_used_at == now


def test_different_ip_rejected_no_mutation():
    k = ApiKey(owner_id=1, key_hash=hash_key("x"), bound_ip="10.0.0.5")
    assert bind_or_reject(k, "10.0.0.9", datetime.now(timezone.utc)) is False
    assert k.bound_ip == "10.0.0.5"  # unchanged
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./.venv/Scripts/python.exe -m pytest tests/test_api_keys.py -q`
Expected: FAIL — `ModuleNotFoundError: app.models.api_key`.

- [ ] **Step 3: Implement model + helpers**

`app/models/api_key.py`:
```python
from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import Boolean, ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base, UTCDateTime


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class ApiKey(Base):
    __tablename__ = "api_keys"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    owner_id: Mapped[int] = mapped_column(Integer, ForeignKey("users.id"), nullable=False)
    key_hash: Mapped[str] = mapped_column(String(64), unique=True, nullable=False, index=True)
    bound_ip: Mapped[str | None] = mapped_column(String(64), nullable=True)
    active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=_utcnow)
    last_used_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
```

`app/security/api_keys.py`:
```python
from __future__ import annotations

import hashlib
import secrets
from datetime import datetime

from app.models.api_key import ApiKey


def generate_key() -> str:
    """A fresh API key, shown to the user exactly once."""
    return secrets.token_urlsafe(32)


def hash_key(plain: str) -> str:
    return hashlib.sha256(plain.encode("utf-8")).hexdigest()


def bind_or_reject(api_key: ApiKey, ip: str, now: datetime) -> bool:
    """Bind the key to its first IP, allow the bound IP, reject others.

    Returns True if the request is permitted (binding on first use), False if
    the IP does not match the bound IP. On rejection nothing is mutated.
    Caller flushes/commits.
    """
    if api_key.bound_ip is None:
        api_key.bound_ip = ip
        api_key.last_used_at = now
        return True
    if api_key.bound_ip == ip:
        api_key.last_used_at = now
        return True
    return False
```

- [ ] **Step 4: Register the model in `init_db`**

In `app/db.py` `init_db`, add after the `link` import:
```python
    from app.models import api_key as _api_key  # noqa: F401
```

- [ ] **Step 5: Run test to verify it passes**

Run: `./.venv/Scripts/python.exe -m pytest tests/test_api_keys.py -q`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add app/models/api_key.py app/security/api_keys.py app/db.py tests/test_api_keys.py
git commit -m "feat: api key model + hashing + per-IP bind logic"
```

---

### Task 9: API-key authentication dependency

**Files:**
- Modify: `app/deps.py` (add `require_api_key`)
- Test: `tests/test_api_key_auth.py`

**Interfaces:**
- Consumes: `get_db`, `client_ip`, `ApiKey`, `hash_key`, `bind_or_reject`, `record` (audit).
- Produces:
  - `require_api_key(request, db) -> ApiKey` — reads `Authorization: Bearer <key>` header; 401 (`detail="missing api key"`) if absent/malformed; looks up the active key by `hash_key`; 401 (`detail="invalid api key"`) if not found/inactive; calls `bind_or_reject` with `client_ip(request)` and `datetime.now(timezone.utc)`; on rejection audits `apikey.ip_rejected` and raises 403 (`detail="api key ip mismatch"`); on success commits the binding/last_used update and returns the `ApiKey`.

- [ ] **Step 1: Write the failing test**

`tests/test_api_key_auth.py`:
```python
import pytest
from fastapi import Depends
from fastapi.testclient import TestClient

from app.main import create_app
from app.deps import require_api_key
from app.models.user import User
from app.models.api_key import ApiKey
from app.security.api_keys import hash_key


@pytest.fixture
def client(tmp_path):
    app = create_app(config_path=str(tmp_path / "app.env"),
                     database_url="sqlite:///:memory:")

    @app.get("/_t/whoami")
    def _whoami(k: ApiKey = Depends(require_api_key)):
        return {"owner": k.owner_id}

    with TestClient(app) as c:
        yield c, app.state.app_state


def _make_key(state, raw="secret-key-value", bound_ip=None):
    with state.session_factory() as s:
        u = User(username="o", password_hash="x", role="user")
        s.add(u)
        s.flush()
        s.add(ApiKey(owner_id=u.id, key_hash=hash_key(raw), bound_ip=bound_ip))
        s.commit()


def test_missing_header_401(client):
    c, _ = client
    assert c.get("/_t/whoami").status_code == 401


def test_invalid_key_401(client):
    c, state = client
    _make_key(state, raw="real")
    assert c.get("/_t/whoami", headers={"Authorization": "Bearer wrong"}).status_code == 401


def test_first_use_binds_and_succeeds(client):
    c, state = client
    _make_key(state, raw="real")
    r = c.get("/_t/whoami", headers={"Authorization": "Bearer real"})
    assert r.status_code == 200
    with state.session_factory() as s:
        assert s.query(ApiKey).one().bound_ip is not None


def test_bound_to_other_ip_rejected(client):
    c, state = client
    _make_key(state, raw="real", bound_ip="203.0.113.7")
    r = c.get("/_t/whoami", headers={"Authorization": "Bearer real"})
    assert r.status_code == 403
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./.venv/Scripts/python.exe -m pytest tests/test_api_key_auth.py -q`
Expected: FAIL — `ImportError: cannot import name 'require_api_key'`.

- [ ] **Step 3: Implement in `app/deps.py`**

Add these imports at the top of `app/deps.py`:
```python
from datetime import datetime, timezone
```
Add to the bottom of `app/deps.py`:
```python
def require_api_key(request: Request, db: Session = Depends(get_db)):
    from app.models.api_key import ApiKey
    from app.security.api_keys import hash_key, bind_or_reject
    from app.audit.log import record

    header = request.headers.get("authorization", "")
    if not header.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="missing api key")
    raw = header[len("Bearer "):].strip()
    if not raw:
        raise HTTPException(status_code=401, detail="missing api key")

    api_key = (
        db.query(ApiKey)
        .filter_by(key_hash=hash_key(raw), active=True)
        .one_or_none()
    )
    if api_key is None:
        raise HTTPException(status_code=401, detail="invalid api key")

    ip = client_ip(request)
    if not bind_or_reject(api_key, ip, datetime.now(timezone.utc)):
        record(db, actor=f"apikey:{api_key.id}", action="apikey.ip_rejected",
               target=f"apikey:{api_key.id}", ip=ip)
        db.commit()
        raise HTTPException(status_code=403, detail="api key ip mismatch")
    db.commit()
    return api_key
```

- [ ] **Step 4: Run test to verify it passes**

Run: `./.venv/Scripts/python.exe -m pytest tests/test_api_key_auth.py -q`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add app/deps.py tests/test_api_key_auth.py
git commit -m "feat: api-key auth dependency with per-IP binding"
```

---

### Task 10: Credential model (TOTP/passkey storage) with encrypted secret

**Files:**
- Create: `app/models/credential.py`
- Modify: `app/db.py` (register model in `init_db`)
- Test: `tests/test_credential_model.py`

**Interfaces:**
- Consumes: `Base`, `UTCDateTime`; `users.id` FK; `app.security.secretbox.seal/open_box`; `app.config.get_master_key`.
- Produces:
  - `Credential` ORM model, `__tablename__ = "credentials"`, columns: `id` (pk), `user_id` (FK users.id, nullable=False), `kind` (str — `totp|webauthn`), `secret_blob` (LargeBinary, nullable=True) — sealed TOTP secret (server-side, via secretbox), `webauthn_id` (str, nullable=True), `webauthn_public_key` (LargeBinary, nullable=True), `sign_count` (int, default 0), `label` (str, nullable=True), `created_at`.
  - This task ships only the table + a documented round-trip of a sealed secret; TOTP/WebAuthn flows are a later plan.

- [ ] **Step 1: Write the failing test**

`tests/test_credential_model.py`:
```python
import os

from app.db import make_engine, make_session_factory, init_db
from app.models.user import User
from app.models.credential import Credential
from app.security.secretbox import seal, open_box


def _session():
    engine = make_engine("sqlite:///:memory:")
    init_db(engine)
    return make_session_factory(engine)()


def test_sealed_totp_secret_round_trips():
    s = _session()
    u = User(username="o", password_hash="x", role="user")
    s.add(u)
    s.flush()

    master_key = os.urandom(32)
    totp_secret = b"JBSWY3DPEHPK3PXP"
    cred = Credential(user_id=u.id, kind="totp", secret_blob=seal(master_key, totp_secret))
    s.add(cred)
    s.commit()

    got = s.query(Credential).one()
    assert got.kind == "totp"
    assert got.secret_blob != totp_secret  # stored sealed, not plaintext
    assert open_box(master_key, got.secret_blob) == totp_secret
    assert got.sign_count == 0
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./.venv/Scripts/python.exe -m pytest tests/test_credential_model.py -q`
Expected: FAIL — `ModuleNotFoundError: app.models.credential`.

- [ ] **Step 3: Implement the model**

`app/models/credential.py`:
```python
from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import ForeignKey, Integer, LargeBinary, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base, UTCDateTime


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Credential(Base):
    __tablename__ = "credentials"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(Integer, ForeignKey("users.id"), nullable=False)
    kind: Mapped[str] = mapped_column(String(16), nullable=False)
    secret_blob: Mapped[bytes | None] = mapped_column(LargeBinary, nullable=True)
    webauthn_id: Mapped[str | None] = mapped_column(String(512), nullable=True)
    webauthn_public_key: Mapped[bytes | None] = mapped_column(LargeBinary, nullable=True)
    sign_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    label: Mapped[str | None] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=_utcnow)
```

- [ ] **Step 4: Register the model in `init_db`**

In `app/db.py` `init_db`, add after the `api_key` import:
```python
    from app.models import credential as _credential  # noqa: F401
```

- [ ] **Step 5: Run test to verify it passes**

Run: `./.venv/Scripts/python.exe -m pytest tests/test_credential_model.py -q`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add app/models/credential.py app/db.py tests/test_credential_model.py
git commit -m "feat: credential model with at-rest sealed TOTP secret"
```

---

### Task 11: Bootstrap grants the master a permissions row

**Files:**
- Modify: `app/bootstrap.py` (create master Permission in `ensure_master`)
- Test: `tests/test_bootstrap.py` (add a case; keep existing cases passing)

**Interfaces:**
- Consumes: `ensure_permissions` from `app.permissions.policy`.
- Produces: after `ensure_master` runs on a fresh DB, the master user has a `Permission` row with all flags True, committed atomically with the user + audit entry.

- [ ] **Step 1: Write the failing test**

Add to `tests/test_bootstrap.py`:
```python
def test_master_gets_full_permissions():
    from app.db import make_engine, make_session_factory, init_db
    from app.models.user import User
    from app.models.permission import Permission
    from app.bootstrap import ensure_master

    engine = make_engine("sqlite:///:memory:")
    init_db(engine)
    s = make_session_factory(engine)()
    ensure_master(s, print_fn=lambda *_: None)

    master = s.query(User).filter_by(role="master").one()
    perm = s.query(Permission).filter_by(user_id=master.id).one()
    assert perm.can_upload is True
    assert perm.can_use_api_keys is True
    assert perm.can_upload_client_encrypted is True
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./.venv/Scripts/python.exe -m pytest tests/test_bootstrap.py::test_master_gets_full_permissions -q`
Expected: FAIL — no Permission row exists (`NoResultFound`).

- [ ] **Step 3: Implement in `app/bootstrap.py`**

Add the import near the top:
```python
from app.permissions.policy import ensure_permissions
```
In `ensure_master`, insert the permission creation after `session.flush()` and before `record(...)` (so the master id exists and everything commits together):
```python
    session.add(master)
    session.flush()
    ensure_permissions(session, master.id, master=True)
    record(session, actor="system", action="bootstrap.master_created",
           target=f"user:{master.id}")
    session.commit()
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `./.venv/Scripts/python.exe -m pytest tests/test_bootstrap.py -q`
Expected: PASS (existing cases + the new one).

- [ ] **Step 5: Run the full suite**

Run: `./.venv/Scripts/python.exe -m pytest -q`
Expected: ALL PASS.

- [ ] **Step 6: Commit**

```bash
git add app/bootstrap.py tests/test_bootstrap.py
git commit -m "feat: bootstrap grants master a full permissions row"
```

---

## Plan Self-Review

**Spec coverage (this slice):**
- §3 `permissions` table → Task 2 ✓; `files` → Task 5 ✓; `links` (random slug, multiple per file, revocable) → Task 6 ✓; `api_keys` (hashed, bound_ip) → Task 8 ✓; `credentials` (TOTP/WebAuthn storage) → Task 10 ✓.
- §4 at-rest AES-256-GCM with random 12-byte IV (server master key) → Task 1 ✓ (consumed by Task 10; server-side per-file wrapping uses the same primitive in the encryption-engine plan).
- §6 roles (master/user) → Task 4 ✓; tiered permission flags + quota/size defaults → Tasks 2,3,4 ✓; API keys per-IP binding + first-use lock → Tasks 8,9 ✓; `can_upload_client_encrypted` off by default → Task 2 ✓.
- §8 atomic `max_uses` enforcement (rowcount, no read-modify-write); expired/inactive links rejected → Task 7 ✓.
- Deferred to later Phase-1 plans (intentionally out of scope here): the encryption engine + chunked AEAD wire format (§4.1), upload/download routes (§7/§8), archival jobs (§5), admin panel (§9), TOTP/WebAuthn enrollment + verification flows (§6), API-key management routes + reset-IP re-auth (§6), UI (§10). This plan ships only the persistent model + enforcement primitives those plans consume.

**Placeholder scan:** none — every step ships complete code/commands.

**Type consistency:** `ensure_permissions(session, user_id, *, master=False) -> Permission` used identically in Tasks 3, 4, 11. `has_permission(perm, name)` consistent (Tasks 3, 4). `Permission` flag names match between model (Task 2), policy `_BOOL_FLAGS` (Task 3), and tests. `new_slug()` (Task 6) consumed by Tasks 6, 7. `consume_use`/`resolve_active_link` signatures consistent (Task 7). `hash_key`, `generate_key`, `bind_or_reject(api_key, ip, now) -> bool` consistent (Tasks 8, 9). `seal`/`open_box(key, blob, aad=b"")` consistent (Tasks 1, 10). All datetime columns use `UTCDateTime`; every new model registered in `init_db` (Tasks 2,5,6,8,10). FK targets (`users.id`, `files.id`) match existing/earlier tasks.
