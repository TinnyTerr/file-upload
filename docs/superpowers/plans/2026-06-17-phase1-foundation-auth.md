# Phase 1 — Foundation & Core Auth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the FastAPI project skeleton with first-run secret generation, a SQLite database, a single master admin account, secure server-side sessions, login with brute-force lockout, forced first-login credential change, CSRF protection, and a tamper-evident append-only audit log.

**Architecture:** A FastAPI app created by a factory (`create_app`). Configuration and long-lived secrets are loaded/generated on first run into a `0600` env file. Persistence is SQLite via SQLAlchemy 2.0 (sync ORM; FastAPI runs sync handlers in a threadpool). Auth uses opaque server-side sessions (a `sessions` row) referenced by a signed cookie. Every security-relevant action appends to a hash-chained audit log.

**Tech Stack:** Python 3.12+, FastAPI, uvicorn, SQLAlchemy 2.0, SQLite, argon2-cffi (argon2id), itsdangerous (cookie signing), pydantic-settings, pytest + httpx TestClient.

## Global Constraints

These apply to **every** task. Values are copied verbatim from the spec (`docs/superpowers/specs/2026-06-17-fileupload-design.md`).

- Python **3.12+**.
- **Argon2id** params: `m=65536` (64 MiB), `t=3`, `p=4`, **16-byte** salt, **32-byte** hash.
- **Login lockout:** 5 failed attempts → **15-minute** lockout, tracked **per username AND per IP**; every failed attempt is logged to `audit_log` with IP.
- **Session cookie flags:** `HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=86400`, signed. `Secure` is **omitted only when `APP_ENV=dev`** (local HTTP); required otherwise.
- **CSRF:** all cookie-authenticated state-changing requests require a valid `X-CSRF-Token` header (double-submit). GET/HEAD are never state-changing. Header-authenticated requests (future API keys / Tus) are exempt.
- **Audit log is append-only:** app only INSERTs; SQLite triggers reject UPDATE/DELETE; each row stores `entry_hash = SHA-256(prev_hash || canonical_row_fields)`.
- **First-run admin:** default password is **randomly generated at startup and printed to the console**, never hardcoded, never stored in plaintext; `must_change_credentials=True` gates every authenticated endpoint until cleared.
- **Reverse-proxy trust:** app binds to `127.0.0.1` only; client IP is taken trusting exactly **one** proxy hop (rightmost `X-Forwarded-For` entry); never trust a raw client-supplied IP.
- **Secrets** (`SECRET_KEY` for cookie signing, `MASTER_KEY` for at-rest encryption) live in a first-run-generated env file with `0600` permissions, on a path separate from `storage/`.
- Master key is 32 bytes from `secrets.token_bytes(32)`; cookie `SECRET_KEY` is `secrets.token_urlsafe(32)`.

---

### Task 1: Project scaffold, dependencies, and health endpoint

**Files:**
- Create: `pyproject.toml`
- Create: `app/__init__.py`
- Create: `app/main.py`
- Create: `tests/__init__.py`
- Create: `tests/conftest.py`
- Test: `tests/test_health.py`

**Interfaces:**
- Produces: `app.main.create_app() -> FastAPI` — the application factory used by every later task and by tests.

- [ ] **Step 1: Write `pyproject.toml`**

```toml
[project]
name = "fileupload"
version = "0.1.0"
requires-python = ">=3.12"
dependencies = [
    "fastapi>=0.115",
    "uvicorn[standard]>=0.30",
    "sqlalchemy>=2.0",
    "argon2-cffi>=23.1",
    "itsdangerous>=2.2",
    "pydantic-settings>=2.4",
    "python-multipart>=0.0.9",
]

[project.optional-dependencies]
dev = ["pytest>=8.0", "httpx>=0.27"]

[build-system]
requires = ["setuptools>=68"]
build-backend = "setuptools.build_meta"

[tool.setuptools.packages.find]
include = ["app*"]

[tool.pytest.ini_options]
testpaths = ["tests"]
```

- [ ] **Step 2: Create empty package markers**

Create `app/__init__.py` (empty) and `tests/__init__.py` (empty).

- [ ] **Step 3: Install the project into a virtual environment**

Run (Linux/macOS / Git Bash):
```bash
python -m venv .venv && . .venv/bin/activate && pip install -e ".[dev]"
```
Run (Windows PowerShell):
```powershell
python -m venv .venv; .venv\Scripts\Activate.ps1; pip install -e ".[dev]"
```
Expected: installs succeed, `pytest` is available.

- [ ] **Step 4: Write the failing test**

`tests/test_health.py`:
```python
from fastapi.testclient import TestClient
from app.main import create_app


def test_health_returns_ok():
    client = TestClient(create_app())
    resp = client.get("/health")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}
```

- [ ] **Step 5: Write `tests/conftest.py` (shared fixtures placeholder)**

```python
# Shared fixtures are added by later tasks. This file marks tests/ as configured.
```

- [ ] **Step 6: Run test to verify it fails**

Run: `pytest tests/test_health.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.main'` or `ImportError: create_app`.

- [ ] **Step 7: Write minimal `app/main.py`**

```python
from fastapi import FastAPI


def create_app() -> FastAPI:
    app = FastAPI(title="fileupload")

    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    return app
```

- [ ] **Step 8: Run test to verify it passes**

Run: `pytest tests/test_health.py -v`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add pyproject.toml app tests
git commit -m "feat: project scaffold with health endpoint"
```

---

### Task 2: Configuration & first-run secret generation

**Files:**
- Create: `app/config.py`
- Test: `tests/test_config.py`

**Interfaces:**
- Produces:
  - `app.config.Settings` — pydantic-settings model with fields `app_env: str` (default `"dev"`), `database_url: str` (default `"sqlite:///./data/app.db"`), `secret_key: str`, `master_key_b64: str`, `config_path: str`.
  - `app.config.load_settings(config_path: str | None = None) -> Settings` — reads the env file; if missing, **generates** `SECRET_KEY` + `MASTER_KEY`, writes the file with `0600`, and returns the populated settings.
  - `app.config.get_master_key(settings: Settings) -> bytes` — returns the 32 raw bytes decoded from `master_key_b64`.

- [ ] **Step 1: Write the failing test**

`tests/test_config.py`:
```python
import base64
import os
import stat
from app.config import load_settings, get_master_key


def test_first_run_generates_secrets(tmp_path):
    cfg = tmp_path / "app.env"
    settings = load_settings(str(cfg))

    assert cfg.exists()
    assert len(settings.secret_key) >= 32
    assert len(get_master_key(settings)) == 32
    # 0600 perms (skip the check on Windows where st_mode differs)
    if os.name == "posix":
        mode = stat.S_IMODE(os.stat(cfg).st_mode)
        assert mode == 0o600


def test_second_load_is_stable(tmp_path):
    cfg = tmp_path / "app.env"
    first = load_settings(str(cfg))
    second = load_settings(str(cfg))
    assert first.secret_key == second.secret_key
    assert first.master_key_b64 == second.master_key_b64
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_config.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.config'`.

- [ ] **Step 3: Write `app/config.py`**

```python
from __future__ import annotations

import base64
import os
import secrets
from pathlib import Path

from pydantic_settings import BaseSettings

DEFAULT_CONFIG_PATH = os.environ.get("FILEUPLOAD_CONFIG", "./data/app.env")


class Settings(BaseSettings):
    app_env: str = "dev"
    database_url: str = "sqlite:///./data/app.db"
    secret_key: str = ""
    master_key_b64: str = ""
    config_path: str = DEFAULT_CONFIG_PATH


def _generate_file(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    secret_key = secrets.token_urlsafe(32)
    master_key_b64 = base64.b64encode(secrets.token_bytes(32)).decode()
    body = (
        f"APP_ENV=dev\n"
        f"SECRET_KEY={secret_key}\n"
        f"MASTER_KEY_B64={master_key_b64}\n"
    )
    # Write then tighten perms to owner-only.
    path.write_text(body, encoding="utf-8")
    if os.name == "posix":
        os.chmod(path, 0o600)


def _parse_env_file(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        values[key.strip()] = val.strip()
    return values


def load_settings(config_path: str | None = None) -> Settings:
    path = Path(config_path or DEFAULT_CONFIG_PATH)
    if not path.exists():
        _generate_file(path)
    raw = _parse_env_file(path)
    return Settings(
        app_env=raw.get("APP_ENV", "dev"),
        database_url=raw.get("DATABASE_URL", "sqlite:///./data/app.db"),
        secret_key=raw["SECRET_KEY"],
        master_key_b64=raw["MASTER_KEY_B64"],
        config_path=str(path),
    )


def get_master_key(settings: Settings) -> bytes:
    return base64.b64decode(settings.master_key_b64)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_config.py -v`
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
git add app/config.py tests/test_config.py
git commit -m "feat: first-run config + secret generation (0600)"
```

---

### Task 3: Database engine, base, and User model

**Files:**
- Create: `app/db.py`
- Create: `app/models/__init__.py`
- Create: `app/models/user.py`
- Test: `tests/test_user_model.py`

**Interfaces:**
- Produces:
  - `app.db.Base` — SQLAlchemy declarative base.
  - `app.db.make_engine(database_url: str)` and `app.db.make_session_factory(engine)` — engine/session factory builders.
  - `app.db.init_db(engine)` — creates all tables.
  - `app.models.user.User` — columns: `id: int` (pk), `username: str` (unique), `password_hash: str`, `role: str` (`"master"|"user"`), `must_change_credentials: bool`, `created_at: datetime`.

- [ ] **Step 1: Write the failing test**

`tests/test_user_model.py`:
```python
from app.db import Base, make_engine, make_session_factory, init_db
from app.models.user import User


def test_can_persist_and_read_user():
    engine = make_engine("sqlite:///:memory:")
    init_db(engine)
    Session = make_session_factory(engine)
    with Session() as s:
        s.add(User(username="root", password_hash="x", role="master",
                   must_change_credentials=True))
        s.commit()
    with Session() as s:
        u = s.query(User).filter_by(username="root").one()
        assert u.role == "master"
        assert u.must_change_credentials is True
        assert u.created_at is not None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_user_model.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.db'`.

- [ ] **Step 3: Write `app/db.py`**

```python
from __future__ import annotations

from sqlalchemy import create_engine, event
from sqlalchemy.engine import Engine
from sqlalchemy.orm import DeclarativeBase, sessionmaker
from sqlalchemy.pool import StaticPool


class Base(DeclarativeBase):
    pass


def make_engine(database_url: str) -> Engine:
    connect_args: dict = {}
    extra: dict = {}
    if database_url.startswith("sqlite"):
        connect_args["check_same_thread"] = False
        # In-memory DBs are per-connection; a single shared connection
        # (StaticPool) is required so all sessions/threads see the same tables.
        if ":memory:" in database_url or database_url == "sqlite://":
            extra["poolclass"] = StaticPool
    engine = create_engine(database_url, connect_args=connect_args, future=True, **extra)

    # Enforce foreign keys + better concurrency for SQLite.
    if database_url.startswith("sqlite"):
        @event.listens_for(engine, "connect")
        def _set_sqlite_pragma(dbapi_conn, _):
            cur = dbapi_conn.cursor()
            cur.execute("PRAGMA foreign_keys=ON")
            cur.execute("PRAGMA journal_mode=WAL")
            cur.close()

    return engine


def make_session_factory(engine: Engine):
    return sessionmaker(bind=engine, expire_on_commit=False, future=True)


def init_db(engine: Engine) -> None:
    # Import models so they register on Base.metadata before create_all.
    from app.models import user as _user  # noqa: F401
    Base.metadata.create_all(engine)
```

- [ ] **Step 4: Write `app/models/__init__.py`** (empty file).

- [ ] **Step 5: Write `app/models/user.py`**

```python
from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import Boolean, DateTime, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    username: Mapped[str] = mapped_column(String(255), unique=True, nullable=False)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    role: Mapped[str] = mapped_column(String(16), nullable=False, default="user")
    must_change_credentials: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pytest tests/test_user_model.py -v`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add app/db.py app/models tests/test_user_model.py
git commit -m "feat: sqlite engine, declarative base, User model"
```

---

### Task 4: Append-only, hash-chained audit log

**Files:**
- Create: `app/models/audit.py`
- Create: `app/audit/__init__.py`
- Create: `app/audit/log.py`
- Test: `tests/test_audit.py`

**Interfaces:**
- Consumes: `app.db.Base`, `app.db.init_db`.
- Produces:
  - `app.models.audit.AuditEntry` — columns: `id: int` pk, `actor: str`, `action: str`, `target: str | None`, `ip: str | None`, `created_at: datetime`, `prev_hash: str`, `entry_hash: str`.
  - `app.audit.log.install_append_only_triggers(engine)` — creates SQLite triggers blocking UPDATE/DELETE on `audit_log`.
  - `app.audit.log.record(session, actor, action, target=None, ip=None) -> AuditEntry` — appends one hash-chained row and commits.
  - `app.audit.log.verify_chain(session) -> bool` — returns True iff the chain is intact.

- [ ] **Step 1: Write the failing test**

`tests/test_audit.py`:
```python
import pytest
from sqlalchemy.exc import IntegrityError, OperationalError

from app.db import make_engine, make_session_factory, init_db
from app.audit.log import install_append_only_triggers, record, verify_chain
from app.models.audit import AuditEntry


def _setup():
    engine = make_engine("sqlite:///:memory:")
    init_db(engine)
    install_append_only_triggers(engine)
    return make_session_factory(engine)


def test_record_builds_chain_and_verifies():
    Session = _setup()
    with Session() as s:
        record(s, actor="root", action="login.success", ip="1.2.3.4")
        record(s, actor="root", action="link.create", target="file:1", ip="1.2.3.4")
        assert verify_chain(s) is True
        rows = s.query(AuditEntry).order_by(AuditEntry.id).all()
        assert rows[1].prev_hash == rows[0].entry_hash


def test_update_and_delete_are_blocked():
    Session = _setup()
    with Session() as s:
        record(s, actor="root", action="login.success", ip="1.2.3.4")
    with Session() as s:
        with pytest.raises((IntegrityError, OperationalError)):
            s.execute(AuditEntry.__table__.update().values(action="tampered"))
            s.commit()
    with Session() as s:
        with pytest.raises((IntegrityError, OperationalError)):
            s.execute(AuditEntry.__table__.delete())
            s.commit()


def test_tampered_chain_fails_verification():
    # Use an engine WITHOUT append-only triggers so a row CAN be mutated at the
    # storage layer, then prove verify_chain detects the broken chain.
    from sqlalchemy import update
    from app.db import make_engine, make_session_factory, init_db
    engine = make_engine("sqlite:///:memory:")
    init_db(engine)
    Session = make_session_factory(engine)
    with Session() as s:
        record(s, actor="root", action="a", ip="1.1.1.1")
        record(s, actor="root", action="b", ip="1.1.1.1")
        assert verify_chain(s) is True
        s.execute(update(AuditEntry).where(AuditEntry.id == 1).values(action="tampered"))
        s.commit()
        s.expire_all()
        assert verify_chain(s) is False
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_audit.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.audit'`.

- [ ] **Step 3: Write `app/models/audit.py`**

```python
from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import DateTime, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class AuditEntry(Base):
    __tablename__ = "audit_log"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    actor: Mapped[str] = mapped_column(String(255), nullable=False)
    action: Mapped[str] = mapped_column(String(64), nullable=False)
    target: Mapped[str | None] = mapped_column(String(255), nullable=True)
    ip: Mapped[str | None] = mapped_column(String(64), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)
    prev_hash: Mapped[str] = mapped_column(Text, nullable=False)
    entry_hash: Mapped[str] = mapped_column(Text, nullable=False)
```

Add the model to `init_db`'s import in `app/db.py` so its table is created:
```python
def init_db(engine: Engine) -> None:
    from app.models import user as _user  # noqa: F401
    from app.models import audit as _audit  # noqa: F401
    Base.metadata.create_all(engine)
```

- [ ] **Step 4: Write `app/audit/__init__.py`** (empty file).

- [ ] **Step 5: Write `app/audit/log.py`**

```python
from __future__ import annotations

import hashlib

from sqlalchemy import text
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session

from app.models.audit import AuditEntry

GENESIS = "0" * 64


def install_append_only_triggers(engine: Engine) -> None:
    stmts = [
        """CREATE TRIGGER IF NOT EXISTS audit_no_update
           BEFORE UPDATE ON audit_log
           BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;""",
        """CREATE TRIGGER IF NOT EXISTS audit_no_delete
           BEFORE DELETE ON audit_log
           BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;""",
    ]
    with engine.begin() as conn:
        for s in stmts:
            conn.execute(text(s))


def _hash_row(prev_hash: str, actor: str, action: str,
              target: str | None, ip: str | None) -> str:
    canonical = "|".join([prev_hash, actor, action, target or "", ip or ""])
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def record(session: Session, actor: str, action: str,
           target: str | None = None, ip: str | None = None) -> AuditEntry:
    last = session.query(AuditEntry).order_by(AuditEntry.id.desc()).first()
    prev_hash = last.entry_hash if last else GENESIS
    entry_hash = _hash_row(prev_hash, actor, action, target, ip)
    entry = AuditEntry(actor=actor, action=action, target=target, ip=ip,
                       prev_hash=prev_hash, entry_hash=entry_hash)
    session.add(entry)
    session.commit()
    return entry


def verify_chain(session: Session) -> bool:
    prev = GENESIS
    for row in session.query(AuditEntry).order_by(AuditEntry.id).all():
        expected = _hash_row(prev, row.actor, row.action, row.target, row.ip)
        if row.prev_hash != prev or row.entry_hash != expected:
            return False
        prev = row.entry_hash
    return True
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pytest tests/test_audit.py -v`
Expected: PASS (all three tests).

- [ ] **Step 7: Commit**

```bash
git add app/models/audit.py app/audit app/db.py tests/test_audit.py
git commit -m "feat: append-only hash-chained audit log"
```

---

### Task 5: Password hashing (argon2id)

**Files:**
- Create: `app/security/__init__.py`
- Create: `app/security/passwords.py`
- Test: `tests/test_passwords.py`

**Interfaces:**
- Produces:
  - `app.security.passwords.hash_password(plain: str) -> str`
  - `app.security.passwords.verify_password(plain: str, hashed: str) -> bool`
  Uses argon2id with the Global-Constraints params.

- [ ] **Step 1: Write the failing test**

`tests/test_passwords.py`:
```python
from app.security.passwords import hash_password, verify_password


def test_hash_roundtrip():
    h = hash_password("correct horse")
    assert h != "correct horse"
    assert h.startswith("$argon2id$")
    assert verify_password("correct horse", h) is True
    assert verify_password("wrong", h) is False
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_passwords.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.security'`.

- [ ] **Step 3: Write `app/security/__init__.py`** (empty file).

- [ ] **Step 4: Write `app/security/passwords.py`**

```python
from __future__ import annotations

from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError, VerificationError, InvalidHashError

# Global-Constraints params: argon2id, m=64 MiB, t=3, p=4, 16-byte salt, 32-byte hash.
_hasher = PasswordHasher(
    time_cost=3,
    memory_cost=65536,
    parallelism=4,
    hash_len=32,
    salt_len=16,
)


def hash_password(plain: str) -> str:
    return _hasher.hash(plain)


def verify_password(plain: str, hashed: str) -> bool:
    try:
        return _hasher.verify(hashed, plain)
    except (VerifyMismatchError, VerificationError, InvalidHashError):
        return False
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pytest tests/test_passwords.py -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add app/security tests/test_passwords.py
git commit -m "feat: argon2id password hashing"
```

---

### Task 6: First-run master bootstrap

**Files:**
- Create: `app/bootstrap.py`
- Test: `tests/test_bootstrap.py`

**Interfaces:**
- Consumes: `User`, `hash_password`, `record`.
- Produces:
  - `app.bootstrap.ensure_master(session, print_fn=print) -> str | None` — if no user exists, creates the master with a **random** password (`secrets.token_urlsafe(12)`), `role="master"`, `must_change_credentials=True`, writes an audit entry, prints the password via `print_fn`, and returns it. If a user already exists, returns `None` and prints nothing.

- [ ] **Step 1: Write the failing test**

`tests/test_bootstrap.py`:
```python
from app.db import make_engine, make_session_factory, init_db
from app.audit.log import install_append_only_triggers
from app.bootstrap import ensure_master
from app.models.user import User
from app.security.passwords import verify_password


def _session():
    engine = make_engine("sqlite:///:memory:")
    init_db(engine)
    install_append_only_triggers(engine)
    return make_session_factory(engine)


def test_creates_master_once_with_printed_password():
    Session = _session()
    printed = []
    with Session() as s:
        pw = ensure_master(s, print_fn=printed.append)
        assert pw is not None
        u = s.query(User).one()
        assert u.role == "master"
        assert u.must_change_credentials is True
        assert verify_password(pw, u.password_hash)
        assert any(pw in line for line in printed)


def test_second_call_is_noop():
    Session = _session()
    with Session() as s:
        ensure_master(s, print_fn=lambda _: None)
    with Session() as s:
        assert ensure_master(s, print_fn=lambda _: None) is None
        assert s.query(User).count() == 1
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_bootstrap.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.bootstrap'`.

- [ ] **Step 3: Write `app/bootstrap.py`**

```python
from __future__ import annotations

import secrets
from typing import Callable

from sqlalchemy.orm import Session

from app.audit.log import record
from app.models.user import User
from app.security.passwords import hash_password

DEFAULT_USERNAME = "admin"


def ensure_master(session: Session, print_fn: Callable[[str], None] = print) -> str | None:
    if session.query(User).count() > 0:
        return None
    password = secrets.token_urlsafe(12)
    master = User(
        username=DEFAULT_USERNAME,
        password_hash=hash_password(password),
        role="master",
        must_change_credentials=True,
    )
    session.add(master)
    session.commit()
    record(session, actor="system", action="bootstrap.master_created",
           target=f"user:{master.id}")
    print_fn("=" * 60)
    print_fn(" FIRST-RUN ADMIN CREATED")
    print_fn(f"   username: {DEFAULT_USERNAME}")
    print_fn(f"   password: {password}")
    print_fn("   You MUST change the username and password on first login.")
    print_fn("=" * 60)
    return password
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_bootstrap.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/bootstrap.py tests/test_bootstrap.py
git commit -m "feat: first-run master bootstrap with printed random password"
```

---

### Task 7: Server-side sessions + signed cookie

**Files:**
- Create: `app/models/session.py`
- Create: `app/security/sessions.py`
- Test: `tests/test_sessions.py`

**Interfaces:**
- Consumes: `Base`, `User`, settings (`secret_key`, `app_env`).
- Produces:
  - `app.models.session.SessionRow` — columns: `id: str` pk (random token), `user_id: int` fk→users, `csrf_token: str`, `created_at: datetime`, `expires_at: datetime`.
  - `app.security.sessions.SessionManager(secret_key, secure)`:
    - `.create(session, user_id) -> tuple[str, str]` — returns `(signed_cookie_value, csrf_token)`; persists a `SessionRow` with 24h expiry.
    - `.resolve(session, cookie_value) -> SessionRow | None` — unsigns the cookie, loads a non-expired row, else None.
    - `.destroy(session, cookie_value) -> None`.
    - `.cookie_params() -> dict` — kwargs for `Response.set_cookie` (`httponly=True, samesite="strict", secure=<flag>, max_age=86400, path="/"`).
    - constant `COOKIE_NAME = "fu_session"`.

- [ ] **Step 1: Write the failing test**

`tests/test_sessions.py`:
```python
from app.db import make_engine, make_session_factory, init_db
from app.models.user import User
from app.security.sessions import SessionManager


def _ctx():
    engine = make_engine("sqlite:///:memory:")
    init_db(engine)
    Session = make_session_factory(engine)
    with Session() as s:
        u = User(username="root", password_hash="x", role="master")
        s.add(u); s.commit()
        uid = u.id
    return Session, uid


def test_create_resolve_destroy():
    Session, uid = _ctx()
    mgr = SessionManager(secret_key="k" * 40, secure=False)
    with Session() as s:
        cookie, csrf = mgr.create(s, uid)
        assert csrf
        row = mgr.resolve(s, cookie)
        assert row is not None and row.user_id == uid and row.csrf_token == csrf
        mgr.destroy(s, cookie)
        assert mgr.resolve(s, cookie) is None


def test_tampered_cookie_resolves_none():
    Session, uid = _ctx()
    mgr = SessionManager(secret_key="k" * 40, secure=False)
    with Session() as s:
        cookie, _ = mgr.create(s, uid)
        assert mgr.resolve(s, cookie + "garbage") is None


def test_cookie_params_respect_secure_flag():
    assert SessionManager("k" * 40, secure=True).cookie_params()["secure"] is True
    assert SessionManager("k" * 40, secure=False).cookie_params()["secure"] is False
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_sessions.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.security.sessions'`.

- [ ] **Step 3: Write `app/models/session.py`**

```python
from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import DateTime, ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class SessionRow(Base):
    __tablename__ = "sessions"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[int] = mapped_column(Integer, ForeignKey("users.id"), nullable=False)
    csrf_token: Mapped[str] = mapped_column(String(64), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
```

Register it in `init_db` (`app/db.py`):
```python
    from app.models import session as _session  # noqa: F401
```

- [ ] **Step 4: Write `app/security/sessions.py`**

```python
from __future__ import annotations

import secrets
from datetime import datetime, timedelta, timezone

from itsdangerous import BadSignature, URLSafeSerializer
from sqlalchemy.orm import Session

from app.models.session import SessionRow

COOKIE_NAME = "fu_session"
SESSION_TTL_SECONDS = 86400


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class SessionManager:
    def __init__(self, secret_key: str, secure: bool):
        self._serializer = URLSafeSerializer(secret_key, salt="session")
        self._secure = secure

    def create(self, session: Session, user_id: int) -> tuple[str, str]:
        sid = secrets.token_urlsafe(32)
        csrf = secrets.token_urlsafe(32)
        row = SessionRow(
            id=sid, user_id=user_id, csrf_token=csrf,
            expires_at=_utcnow() + timedelta(seconds=SESSION_TTL_SECONDS),
        )
        session.add(row)
        session.commit()
        return self._serializer.dumps(sid), csrf

    def _unsign(self, cookie_value: str) -> str | None:
        try:
            return self._serializer.loads(cookie_value)
        except BadSignature:
            return None

    def resolve(self, session: Session, cookie_value: str | None) -> SessionRow | None:
        if not cookie_value:
            return None
        sid = self._unsign(cookie_value)
        if sid is None:
            return None
        row = session.get(SessionRow, sid)
        if row is None:
            return None
        exp = row.expires_at
        if exp.tzinfo is None:
            exp = exp.replace(tzinfo=timezone.utc)
        if exp < _utcnow():
            return None
        return row

    def destroy(self, session: Session, cookie_value: str | None) -> None:
        if not cookie_value:
            return
        sid = self._unsign(cookie_value)
        if sid is None:
            return
        row = session.get(SessionRow, sid)
        if row is not None:
            session.delete(row)
            session.commit()

    def cookie_params(self) -> dict:
        return {
            "httponly": True,
            "samesite": "strict",
            "secure": self._secure,
            "max_age": SESSION_TTL_SECONDS,
            "path": "/",
        }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pytest tests/test_sessions.py -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add app/models/session.py app/security/sessions.py app/db.py tests/test_sessions.py
git commit -m "feat: server-side sessions with signed cookie"
```

---

### Task 8: Brute-force lockout (per-username and per-IP)

**Files:**
- Create: `app/models/login_attempt.py`
- Create: `app/security/lockout.py`
- Test: `tests/test_lockout.py`

**Interfaces:**
- Consumes: `Base`.
- Produces:
  - `app.models.login_attempt.LoginAttempt` — columns: `id: int` pk, `identifier: str`, `identifier_type: str` (`"user"|"ip"`), `failed_count: int`, `locked_until: datetime | None`, `updated_at: datetime`. Unique on (`identifier`, `identifier_type`).
  - `app.security.lockout.LockoutPolicy(max_attempts=5, lockout_seconds=900)`:
    - `.is_locked(session, identifier, identifier_type) -> bool`
    - `.register_failure(session, identifier, identifier_type) -> None` — increments; sets `locked_until` once `max_attempts` reached.
    - `.reset(session, identifier, identifier_type) -> None` — clears on success.
    - `.check_login_allowed(session, username, ip) -> bool` — locked if EITHER the username OR the ip is locked.

- [ ] **Step 1: Write the failing test**

`tests/test_lockout.py`:
```python
from datetime import datetime, timedelta, timezone

from app.db import make_engine, make_session_factory, init_db
from app.security.lockout import LockoutPolicy


def _session():
    engine = make_engine("sqlite:///:memory:")
    init_db(engine)
    return make_session_factory(engine)


def test_locks_after_max_attempts():
    Session = _session()
    policy = LockoutPolicy(max_attempts=3, lockout_seconds=900)
    with Session() as s:
        for _ in range(3):
            assert policy.check_login_allowed(s, "root", "1.2.3.4") is True
            policy.register_failure(s, "root", "user")
            policy.register_failure(s, "1.2.3.4", "ip")
        assert policy.check_login_allowed(s, "root", "1.2.3.4") is False


def test_reset_clears_lock():
    Session = _session()
    policy = LockoutPolicy(max_attempts=2, lockout_seconds=900)
    with Session() as s:
        policy.register_failure(s, "root", "user")
        policy.register_failure(s, "root", "user")
        assert policy.is_locked(s, "root", "user") is True
        policy.reset(s, "root", "user")
        assert policy.is_locked(s, "root", "user") is False


def test_either_identifier_locks_login():
    Session = _session()
    policy = LockoutPolicy(max_attempts=1, lockout_seconds=900)
    with Session() as s:
        policy.register_failure(s, "9.9.9.9", "ip")
        # username clean but IP is locked -> login blocked
        assert policy.check_login_allowed(s, "someone", "9.9.9.9") is False
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_lockout.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.security.lockout'`.

- [ ] **Step 3: Write `app/models/login_attempt.py`**

```python
from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import DateTime, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class LoginAttempt(Base):
    __tablename__ = "login_attempts"
    __table_args__ = (UniqueConstraint("identifier", "identifier_type"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    identifier: Mapped[str] = mapped_column(String(255), nullable=False)
    identifier_type: Mapped[str] = mapped_column(String(8), nullable=False)
    failed_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    locked_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)
```

Register in `init_db` (`app/db.py`):
```python
    from app.models import login_attempt as _la  # noqa: F401
```

- [ ] **Step 4: Write `app/security/lockout.py`**

```python
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.login_attempt import LoginAttempt


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class LockoutPolicy:
    def __init__(self, max_attempts: int = 5, lockout_seconds: int = 900):
        self.max_attempts = max_attempts
        self.lockout_seconds = lockout_seconds

    def _get(self, session: Session, identifier: str, identifier_type: str) -> LoginAttempt | None:
        return session.execute(
            select(LoginAttempt).where(
                LoginAttempt.identifier == identifier,
                LoginAttempt.identifier_type == identifier_type,
            )
        ).scalar_one_or_none()

    def is_locked(self, session: Session, identifier: str, identifier_type: str) -> bool:
        row = self._get(session, identifier, identifier_type)
        if row is None or row.locked_until is None:
            return False
        until = row.locked_until
        if until.tzinfo is None:
            until = until.replace(tzinfo=timezone.utc)
        return until > _utcnow()

    def register_failure(self, session: Session, identifier: str, identifier_type: str) -> None:
        row = self._get(session, identifier, identifier_type)
        if row is None:
            row = LoginAttempt(identifier=identifier, identifier_type=identifier_type, failed_count=0)
            session.add(row)
        row.failed_count += 1
        row.updated_at = _utcnow()
        if row.failed_count >= self.max_attempts:
            row.locked_until = _utcnow() + timedelta(seconds=self.lockout_seconds)
        session.commit()

    def reset(self, session: Session, identifier: str, identifier_type: str) -> None:
        row = self._get(session, identifier, identifier_type)
        if row is not None:
            row.failed_count = 0
            row.locked_until = None
            row.updated_at = _utcnow()
            session.commit()

    def check_login_allowed(self, session: Session, username: str, ip: str) -> bool:
        return not (self.is_locked(session, username, "user") or self.is_locked(session, ip, "ip"))
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pytest tests/test_lockout.py -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add app/models/login_attempt.py app/security/lockout.py app/db.py tests/test_lockout.py
git commit -m "feat: brute-force lockout per-username and per-IP"
```

---

### Task 9: App wiring — dependencies, client-IP, and login/logout routes

**Files:**
- Create: `app/deps.py`
- Create: `app/routes/__init__.py`
- Create: `app/routes/auth.py`
- Modify: `app/main.py`
- Test: `tests/test_auth_routes.py`

**Interfaces:**
- Consumes: everything above.
- Produces:
  - `app.deps.AppState` — holds `settings`, `session_factory`, `session_manager`, `lockout`. Stored on `app.state.app_state`.
  - `app.deps.get_db()` (FastAPI dependency yielding a DB session).
  - `app.deps.client_ip(request) -> str` — rightmost `X-Forwarded-For` entry if present (one trusted hop), else `request.client.host`.
  - `app.deps.current_session(request, ...)` dependency → `SessionRow` or raises 401.
  - Routes: `POST /auth/login` (body `{username, password}`) → sets cookie, returns `{csrf_token, must_change_credentials}`; `POST /auth/logout`.

- [ ] **Step 1: Write the failing test**

`tests/test_auth_routes.py`:
```python
import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.deps import AppState


@pytest.fixture
def client(tmp_path):
    app = create_app(config_path=str(tmp_path / "app.env"),
                     database_url="sqlite:///:memory:")
    state: AppState = app.state.app_state
    # Capture the bootstrap password printed at startup.
    with TestClient(app) as c:
        yield c, state


def _login(c, state, username="admin"):
    pw = state.bootstrap_password
    return c.post("/auth/login", json={"username": username, "password": pw})


def test_login_success_sets_cookie_and_flags_change(client):
    c, state = client
    resp = _login(c, state)
    assert resp.status_code == 200
    body = resp.json()
    assert body["must_change_credentials"] is True
    assert body["csrf_token"]
    assert "fu_session" in resp.cookies


def test_login_wrong_password_fails(client):
    c, state = client
    resp = c.post("/auth/login", json={"username": "admin", "password": "nope"})
    assert resp.status_code == 401


def test_lockout_after_five_failures(client):
    c, state = client
    for _ in range(5):
        c.post("/auth/login", json={"username": "admin", "password": "nope"})
    # 6th attempt, even with correct password, is locked out.
    resp = _login(c, state)
    assert resp.status_code == 429


def test_logout_clears_session(client):
    c, state = client
    login = _login(c, state)
    csrf = login.json()["csrf_token"]
    resp = c.post("/auth/logout", headers={"X-CSRF-Token": csrf})
    assert resp.status_code == 200
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_auth_routes.py -v`
Expected: FAIL — `create_app()` does not accept `config_path`/`database_url`, no `app_state`.

- [ ] **Step 3: Write `app/deps.py`**

```python
from __future__ import annotations

from dataclasses import dataclass
from typing import Iterator

from fastapi import Depends, HTTPException, Request
from sqlalchemy.orm import Session

from app.config import Settings
from app.security.lockout import LockoutPolicy
from app.security.sessions import COOKIE_NAME, SessionManager
from app.models.session import SessionRow


@dataclass
class AppState:
    settings: Settings
    session_factory: object
    session_manager: SessionManager
    lockout: LockoutPolicy
    bootstrap_password: str | None = None


def get_state(request: Request) -> AppState:
    return request.app.state.app_state


def get_db(request: Request) -> Iterator[Session]:
    state = get_state(request)
    db = state.session_factory()
    try:
        yield db
    finally:
        db.close()


def client_ip(request: Request) -> str:
    xff = request.headers.get("x-forwarded-for")
    if xff:
        # Trust exactly one proxy hop: rightmost entry is the proxy's view of the client.
        return xff.split(",")[-1].strip()
    return request.client.host if request.client else "unknown"


def current_session(request: Request, db: Session = Depends(get_db)) -> SessionRow:
    state = get_state(request)
    cookie = request.cookies.get(COOKIE_NAME)
    row = state.session_manager.resolve(db, cookie)
    if row is None:
        raise HTTPException(status_code=401, detail="not authenticated")
    return row
```

- [ ] **Step 4: Write `app/routes/__init__.py`** (empty file).

- [ ] **Step 5: Write `app/routes/auth.py`**

```python
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.audit.log import record
from app.deps import AppState, client_ip, get_db, get_state
from app.models.user import User
from app.security.passwords import verify_password
from app.security.sessions import COOKIE_NAME

router = APIRouter(prefix="/auth", tags=["auth"])


class LoginBody(BaseModel):
    username: str
    password: str


@router.post("/login")
def login(body: LoginBody, request: Request, response: Response,
          db: Session = Depends(get_db)) -> dict:
    state: AppState = get_state(request)
    ip = client_ip(request)

    if not state.lockout.check_login_allowed(db, body.username, ip):
        record(db, actor=body.username, action="login.locked_out", ip=ip)
        raise HTTPException(status_code=429, detail="too many attempts, try later")

    user = db.query(User).filter_by(username=body.username).one_or_none()
    if user is None or not verify_password(body.password, user.password_hash):
        state.lockout.register_failure(db, body.username, "user")
        state.lockout.register_failure(db, ip, "ip")
        record(db, actor=body.username, action="login.failure", ip=ip)
        raise HTTPException(status_code=401, detail="invalid credentials")

    state.lockout.reset(db, body.username, "user")
    state.lockout.reset(db, ip, "ip")
    cookie_value, csrf = state.session_manager.create(db, user.id)
    response.set_cookie(COOKIE_NAME, cookie_value, **state.session_manager.cookie_params())
    record(db, actor=user.username, action="login.success", target=f"user:{user.id}", ip=ip)
    return {"csrf_token": csrf, "must_change_credentials": user.must_change_credentials}


@router.post("/logout")
def logout(request: Request, response: Response, db: Session = Depends(get_db)) -> dict:
    state: AppState = get_state(request)
    cookie = request.cookies.get(COOKIE_NAME)
    state.session_manager.destroy(db, cookie)
    response.delete_cookie(COOKIE_NAME, path="/")
    return {"status": "logged_out"}
```

- [ ] **Step 6: Rewrite `app/main.py` to wire everything**

```python
from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.audit.log import install_append_only_triggers
from app.bootstrap import ensure_master
from app.config import load_settings
from app.db import make_engine, make_session_factory, init_db
from app.deps import AppState
from app.security.lockout import LockoutPolicy
from app.security.sessions import SessionManager
from app.routes.auth import router as auth_router


def create_app(config_path: str | None = None, database_url: str | None = None) -> FastAPI:
    settings = load_settings(config_path)
    db_url = database_url or settings.database_url
    engine = make_engine(db_url)
    init_db(engine)
    install_append_only_triggers(engine)
    session_factory = make_session_factory(engine)

    secure = settings.app_env != "dev"
    state = AppState(
        settings=settings,
        session_factory=session_factory,
        session_manager=SessionManager(settings.secret_key, secure=secure),
        lockout=LockoutPolicy(max_attempts=5, lockout_seconds=900),
    )

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        with session_factory() as s:
            state.bootstrap_password = ensure_master(s)
        yield

    app = FastAPI(title="fileupload", lifespan=lifespan)
    app.state.app_state = state

    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    app.include_router(auth_router)
    return app
```

- [ ] **Step 7: Run test to verify it passes**

Run: `pytest tests/test_auth_routes.py -v`
Expected: PASS (all four tests).

- [ ] **Step 8: Run the full suite**

Run: `pytest -v`
Expected: ALL PASS.

- [ ] **Step 9: Commit**

```bash
git add app/deps.py app/routes app/main.py tests/test_auth_routes.py
git commit -m "feat: login/logout routes with lockout, sessions, audit"
```

---

### Task 10: CSRF protection for cookie-authenticated mutations

**Files:**
- Create: `app/security/csrf.py`
- Test: `tests/test_csrf.py`

**Interfaces:**
- Consumes: `current_session`.
- Produces:
  - `app.security.csrf.require_csrf(request, session_row)` — FastAPI dependency that, for cookie-authenticated requests, compares the `X-CSRF-Token` header to `session_row.csrf_token`; raises 403 on mismatch/absence. Used on every state-changing cookie-auth route.

- [ ] **Step 1: Write the failing test**

`tests/test_csrf.py`:
```python
import pytest
from fastapi.testclient import TestClient

from app.main import create_app


@pytest.fixture
def client(tmp_path):
    app = create_app(config_path=str(tmp_path / "app.env"),
                     database_url="sqlite:///:memory:")
    with TestClient(app) as c:
        yield c, app.state.app_state


def test_logout_without_csrf_is_rejected(client):
    c, state = client
    c.post("/auth/login", json={"username": "admin", "password": state.bootstrap_password})
    resp = c.post("/auth/logout")  # no X-CSRF-Token
    assert resp.status_code == 403


def test_logout_with_bad_csrf_is_rejected(client):
    c, state = client
    c.post("/auth/login", json={"username": "admin", "password": state.bootstrap_password})
    resp = c.post("/auth/logout", headers={"X-CSRF-Token": "wrong"})
    assert resp.status_code == 403
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_csrf.py -v`
Expected: FAIL — logout currently returns 200 without a token.

- [ ] **Step 3: Write `app/security/csrf.py`**

```python
from __future__ import annotations

from fastapi import Depends, HTTPException, Request

from app.deps import current_session
from app.models.session import SessionRow


def require_csrf(request: Request, session_row: SessionRow = Depends(current_session)) -> SessionRow:
    header = request.headers.get("x-csrf-token")
    if not header or header != session_row.csrf_token:
        raise HTTPException(status_code=403, detail="invalid or missing CSRF token")
    return session_row
```

- [ ] **Step 4: Apply CSRF to logout in `app/routes/auth.py`**

Replace the `logout` signature and drop the manual cookie lookup to use the validated session:
```python
from app.security.csrf import require_csrf
from app.models.session import SessionRow


@router.post("/logout")
def logout(request: Request, response: Response,
           session_row: SessionRow = Depends(require_csrf),
           db: Session = Depends(get_db)) -> dict:
    state: AppState = get_state(request)
    cookie = request.cookies.get(COOKIE_NAME)
    state.session_manager.destroy(db, cookie)
    response.delete_cookie(COOKIE_NAME, path="/")
    record(db, actor=str(session_row.user_id), action="logout", ip=client_ip(request))
    return {"status": "logged_out"}
```
(Add `from app.deps import client_ip` if not already imported.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `pytest tests/test_csrf.py tests/test_auth_routes.py -v`
Expected: PASS. (The earlier `test_logout_clears_session` already sends `X-CSRF-Token`, so it still passes.)

- [ ] **Step 6: Commit**

```bash
git add app/security/csrf.py app/routes/auth.py tests/test_csrf.py
git commit -m "feat: CSRF protection for cookie-auth mutations"
```

---

### Task 11: Forced credential change + setup gate

**Files:**
- Create: `app/routes/account.py`
- Modify: `app/main.py` (include the new router)
- Modify: `app/deps.py` (add `require_active_user` gate)
- Test: `tests/test_change_credentials.py`

**Interfaces:**
- Consumes: `current_session`, `require_csrf`, `User`, `hash_password`, `verify_password`.
- Produces:
  - `app.deps.require_active_user(session_row, db) -> User` — loads the user; if `must_change_credentials` is True, raises **403** (`detail="must change credentials"`) so every *other* authenticated endpoint is gated until setup completes.
  - Route `POST /account/change-credentials` (body `{new_username, current_password, new_password}`, CSRF-protected): verifies current password, updates username + password, clears `must_change_credentials`, audits. This route does **not** use `require_active_user` (it is the one action a flagged account may take).

- [ ] **Step 1: Write the failing test**

`tests/test_change_credentials.py`:
```python
import pytest
from fastapi.testclient import TestClient

from app.main import create_app


@pytest.fixture
def client(tmp_path):
    app = create_app(config_path=str(tmp_path / "app.env"),
                     database_url="sqlite:///:memory:")
    with TestClient(app) as c:
        yield c, app.state.app_state


def _login(c, pw, username="admin"):
    return c.post("/auth/login", json={"username": username, "password": pw})


def test_change_credentials_clears_flag(client):
    c, state = client
    csrf = _login(c, state.bootstrap_password).json()["csrf_token"]
    resp = c.post("/account/change-credentials",
                  headers={"X-CSRF-Token": csrf},
                  json={"new_username": "axo", "current_password": state.bootstrap_password,
                        "new_password": "a-brand-new-strong-pass"})
    assert resp.status_code == 200
    # Old creds no longer work; new ones do, with flag cleared.
    assert _login(c, state.bootstrap_password).status_code == 401
    new_login = _login(c, "a-brand-new-strong-pass", username="axo")
    assert new_login.status_code == 200
    assert new_login.json()["must_change_credentials"] is False


def test_flagged_account_blocked_from_other_endpoints(client):
    c, state = client
    csrf = _login(c, state.bootstrap_password).json()["csrf_token"]
    # /account/me is gated by require_active_user and must be blocked pre-change.
    resp = c.get("/account/me")
    assert resp.status_code == 403


def test_wrong_current_password_rejected(client):
    c, state = client
    csrf = _login(c, state.bootstrap_password).json()["csrf_token"]
    resp = c.post("/account/change-credentials",
                  headers={"X-CSRF-Token": csrf},
                  json={"new_username": "axo", "current_password": "wrong",
                        "new_password": "whatever-strong"})
    assert resp.status_code == 401
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_change_credentials.py -v`
Expected: FAIL — no `/account/*` routes exist.

- [ ] **Step 3: Add `require_active_user` to `app/deps.py`**

```python
def require_active_user(session_row: SessionRow = Depends(current_session),
                        db: Session = Depends(get_db)) -> "User":
    from app.models.user import User
    user = db.get(User, session_row.user_id)
    if user is None:
        raise HTTPException(status_code=401, detail="not authenticated")
    if user.must_change_credentials:
        raise HTTPException(status_code=403, detail="must change credentials")
    return user
```

- [ ] **Step 4: Write `app/routes/account.py`**

```python
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.audit.log import record
from app.deps import client_ip, current_session, get_db, require_active_user
from app.models.session import SessionRow
from app.models.user import User
from app.security.csrf import require_csrf
from app.security.passwords import hash_password, verify_password

router = APIRouter(prefix="/account", tags=["account"])


class ChangeCredsBody(BaseModel):
    new_username: str
    current_password: str
    new_password: str


@router.post("/change-credentials")
def change_credentials(body: ChangeCredsBody, request: Request,
                       session_row: SessionRow = Depends(require_csrf),
                       db: Session = Depends(get_db)) -> dict:
    user = db.get(User, session_row.user_id)
    if user is None or not verify_password(body.current_password, user.password_hash):
        raise HTTPException(status_code=401, detail="invalid current password")
    existing = db.query(User).filter_by(username=body.new_username).one_or_none()
    if existing is not None and existing.id != user.id:
        raise HTTPException(status_code=409, detail="username taken")
    user.username = body.new_username
    user.password_hash = hash_password(body.new_password)
    user.must_change_credentials = False
    db.commit()
    record(db, actor=user.username, action="account.credentials_changed",
           target=f"user:{user.id}", ip=client_ip(request))
    return {"status": "updated"}


@router.get("/me")
def me(user: User = Depends(require_active_user)) -> dict:
    return {"id": user.id, "username": user.username, "role": user.role}
```

- [ ] **Step 5: Include the router in `app/main.py`**

```python
from app.routes.account import router as account_router
# ... after app.include_router(auth_router):
    app.include_router(account_router)
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pytest tests/test_change_credentials.py -v`
Expected: PASS (all three tests).

- [ ] **Step 7: Run the full suite**

Run: `pytest -v`
Expected: ALL PASS.

- [ ] **Step 8: Commit**

```bash
git add app/routes/account.py app/deps.py app/main.py tests/test_change_credentials.py
git commit -m "feat: forced credential change + setup gate"
```

---

## Plan Self-Review

**Spec coverage (Plan 1 slice):**
- First-run secret generation `0600` → Task 2 ✓
- SQLite + models → Tasks 3, 4, 7, 8 ✓
- Argon2id params → Task 5 ✓
- Random first-run admin to console + `must_change_credentials` gate → Tasks 6, 11 ✓
- Signed `HttpOnly; Secure; SameSite=Strict` session cookie → Task 7 ✓
- Brute-force lockout (per-user + per-IP, 5/15min) + audit on failure → Tasks 8, 9 ✓
- Append-only hash-chained audit log → Task 4 ✓
- CSRF on cookie-auth mutations → Task 10 ✓
- Safe client-IP (one proxy hop) → Task 9 (`client_ip`) ✓
- Deferred to later Phase-1 plans (intentionally out of scope here): TOTP/WebAuthn (Plan 2), permissions/panel/API keys (Plan 3), upload/download/lifecycle (Plans 4–6).

**Placeholder scan:** none — every step ships complete code/commands.

**Type consistency:** `SessionManager.create` returns `(cookie, csrf)` and is consumed that way in Task 9; `current_session` returns `SessionRow` and is consumed by `require_csrf`/`require_active_user`; `client_ip`, `get_db`, `get_state`, `AppState` signatures match across Tasks 9–11; `record(...)` signature consistent across Tasks 4, 6, 9, 10, 11. ✓
