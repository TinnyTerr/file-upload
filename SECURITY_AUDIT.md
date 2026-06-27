# Security Audit Report — Oxymoron File Upload Service

**Date:** 2026-06-26  
**Auditor:** Claude Sonnet 4.6 (automated static analysis)  
**Scope:** Full codebase — `app/`, `tests/`, configuration  
**Threat model:** Internet-facing file storage service (API + Web UI), stores sensitive user files  
**Compliance:** General security best practices, OWASP Top 10  
**Risk tolerance:** Balanced (industry-standard posture)

---

## Executive Summary

The application has a strong security foundation: Argon2id password hashing, per-session CSRF tokens, AES-256-GCM file encryption, atomic link-consumption to prevent race conditions, append-only audit log with hash-chain integrity, and path-traversal guards on every storage operation. The core cryptographic design is sound.

Two high-severity findings require immediate action: secrets are committed to the git repository, and the HTTPS redirect middleware is vulnerable to an open redirect when `trust_proxy` is enabled. Several medium-severity findings around session management, denial-of-service, and missing browser security mechanisms follow.

---

## Findings Summary

| ID  | Severity | Title |
|-----|----------|-------|
| H1  | **HIGH** | Secrets committed to git repository |
| H2  | **HIGH** | Open redirect via `X-Forwarded-Host` (trust_proxy mode) |
| M1  | **MEDIUM** | No session invalidation on credential change |
| M2  | **MEDIUM** | Directory ZIP download loads all files into memory (DoS) |
| M3  | **MEDIUM** | Missing `Strict-Transport-Security` (HSTS) header |
| M4  | **MEDIUM** | Decompression bomb ratio check bypassed when `original_size == 0` |
| M5  | **MEDIUM** | Audit log hash-chain race condition under concurrent writes |
| M6  | **MEDIUM** | No rate limiting on downloads or API key creation |
| L1  | **LOW** | `lifecycle.py` file deletion bypasses `safe_join` |
| L2  | **LOW** | `_sweep_stale_parts()` called on every chunked upload init |
| L3  | **LOW** | Legacy server-encrypted files bypass the `?ek=` access key check |
| L4  | **LOW** | Username field has no API-level length constraint |
| L5  | **LOW** | API keys hashed with fast SHA-256 |
| L6  | **LOW** | `files.html` referenced in `main.py` but missing from static assets |
| I1  | **INFO** | `can_use_p2p` permission flag defined but never enforced |
| I2  | **INFO** | `Credential` model defined but entirely unused |
| I3  | **INFO** | Raw SQL string formatting in migration helper |
| I4  | **INFO** | Naive env file parser (no quote/escape handling) |

---

## HIGH Severity

### H1 — Secrets committed to git repository

**File:** `data/app.env`  
**OWASP:** A02 — Cryptographic Failures

The live configuration file containing `SECRET_KEY` (session signing key) and `MASTER_KEY_B64` (AES-256-GCM master encryption key) is tracked in the repository:

```
SECRET_KEY=vqr3pbeWUSHr4K3gf85Gi5AYvIlNW5iMsQTS8atUzMw
MASTER_KEY_B64=A0aT3SS7MO3Y0o/xYW80ifzcwa9mZo+4Xn7DFuYkt8Q=
```

Anyone with repository read access can:
1. Forge arbitrary session cookies (by reusing `SECRET_KEY` with `itsdangerous.URLSafeSerializer`)
2. Decrypt every server-encrypted file stored on disk (by using `MASTER_KEY_B64` directly)
3. Recover all sealed access credentials and per-file encryption keys

**Impact:** Full compromise of all encrypted data and all active sessions.

**Remediation:**
1. Rotate both keys immediately — generate new values and redeploy.
2. Remove `data/` from version control and add it to `.gitignore`.
3. Use environment variables or a secrets manager (Vault, AWS Secrets Manager) for production.
4. Purge the file from git history with `git filter-repo` or BFG.

---

### H2 — Open redirect via `X-Forwarded-Host` in HTTPS redirect middleware

**File:** `app/main.py:146–168`  
**OWASP:** A01 — Broken Access Control

When `trust_proxy=True`, the `_HttpsRedirect` middleware constructs the redirect destination using the `X-Forwarded-Host` header:

```python
fwd_host = headers.get(b"x-forwarded-host", b"").decode()
if fwd_host:
    host = fwd_host.split(",", 1)[0].strip()
...
location = f"https://{host}{path}"
```

If the upstream reverse proxy does not strip or override `X-Forwarded-Host` from incoming requests, an attacker can craft a request with `X-Forwarded-Host: evil.com` and cause the server to issue a `308 Permanent Redirect` to `https://evil.com/...`. Because the redirect is `308`, browsers and crawlers will cache it and follow it to the attacker-controlled domain.

**Attack scenario:** Attacker sends a specially-crafted HTTP link to a victim. Victim's browser hits the server over HTTP, server issues `308 Permanent Redirect` to `https://evil.com/login`. Victim enters credentials on the phishing page.

**Remediation:**
1. Validate that the redirected host matches a configured allowlist (e.g., `settings.allowed_hosts`).
2. Or simply never use `X-Forwarded-Host` for redirect construction — use the bound server hostname from configuration instead.

---

## MEDIUM Severity

### M1 — No session invalidation on credential change

**File:** `app/routes/account.py:23–44`  
**OWASP:** A07 — Identification and Authentication Failures

When a user changes their username and password via `POST /account/change-credentials`, existing sessions (including any stolen or leaked ones) are **not invalidated**:

```python
user.username = body.new_username
user.password_hash = hash_password(body.new_password)
user.must_change_credentials = False
# ← no session cleanup here
```

An attacker who has stolen a session cookie (via network interception, browser compromise, etc.) retains full access for up to 24 hours after the victim changes their password. There is no self-service "logout all sessions" endpoint.

**Remediation:** Delete all `SessionRow` records for `user.id` (except the currently-authenticated one) inside the `change_credentials` handler before committing.

---

### M2 — Directory ZIP download loads all member files into memory

**File:** `app/routes/directories.py:384–411`  
**OWASP:** A05 — Security Misconfiguration (DoS)

The `GET /d/{slug}/zip` endpoint builds the ZIP archive by reading every member file's full plaintext bytes into memory via `_member_plaintext()`:

```python
with zipfile.ZipFile(tmp, "w", zipfile.ZIP_STORED) as zf:
    for f, _lk in pairs:
        name = _safe_arcname(f.original_filename, seen)
        zf.writestr(name, _member_plaintext(request, f))  # full file in RAM
```

A directory containing many large files (e.g., 100 × 10 GB each — within the per-file quota) will exhaust server memory before the ZIP is complete. There is no size cap, file count limit, or streaming path for the server-side ZIP.

Additionally, every directory ZIP download is unauthenticated (public via slug). An attacker knowing a valid slug can hammer this endpoint to trigger repeated large memory allocations.

**Remediation:** Use `zipfile.ZipFile.write()` or streaming `zipfile` patterns rather than `writestr()`. Enforce a maximum total bytes cap on ZIP generation (e.g., reject if `d.total_bytes > MAX_ZIP_BYTES`).

---

### M3 — Missing `Strict-Transport-Security` (HSTS) header

**File:** `app/main.py:110–132`  
**OWASP:** A05 — Security Misconfiguration

The `_SecurityHeaders` middleware sets `X-Content-Type-Options`, `X-Frame-Options`, and `Referrer-Policy`, but does NOT set `Strict-Transport-Security`:

```python
# Headers added:
hdrs.append((b"x-content-type-options", b"nosniff"))
hdrs.append((b"x-frame-options", b"DENY"))
hdrs.append((b"referrer-policy", b"no-referrer"))
# Missing: Strict-Transport-Security
```

Without HSTS, browsers will make the initial request to the server over plain HTTP before being redirected, giving an attacker on-path the opportunity to intercept the request (including any cookie sent on the first hop), and browsers will not refuse to connect over HTTP even after visiting the site previously.

**Remediation:** Add to `_SecurityHeaders` (in non-dev mode):
```python
hdrs.append((b"strict-transport-security", b"max-age=63072000; includeSubDomains"))
```

---

### M4 — Decompression bomb ratio check bypassed when `original_size == 0`

**File:** `app/storage/compress.py:46`  
**OWASP:** A05 — Security Misconfiguration

The ratio-based bomb guard short-circuits when `original_size == 0`:

```python
if original_size > 0 and produced > original_size * _BOMB_RATIO:
    raise ValueError("decompression bomb detected")
```

If any code path calls `decompress_stream(path, 0)`, only the absolute 10 GiB cap (`_BOMB_MAX`) applies, not the 50× ratio limit. This matters because a 1-byte compressed file that expands to 5 GiB would not be caught by the ratio check.

The public download route passes `f.size_bytes` to `decompress_stream`. A file stored with `size_bytes=0` (possible for empty files or if the field is incorrectly populated) removes the ratio protection entirely, allowing a crafted Zstandard file to expand to 10 GiB before being rejected.

**Remediation:** Remove the `original_size > 0` guard, or substitute a safe fallback:
```python
if produced > max(original_size * _BOMB_RATIO, _READ_SIZE * 10) and produced > _READ_SIZE:
    raise ValueError("decompression bomb detected")
```
Alternatively, always ensure `f.size_bytes > 0` before invoking `decompress_stream`.

---

### M5 — Audit log hash-chain race condition under concurrent writes

**File:** `app/audit/log.py:59–62`  
**OWASP:** A09 — Security Logging and Monitoring Failures

The audit chain is built by reading the last entry's hash and then inserting a new one:

```python
last = session.query(AuditEntry).order_by(AuditEntry.id.desc()).first()
prev_hash = last.entry_hash if last else GENESIS
```

If two transactions execute this read concurrently (before either commits), both will compute their `prev_hash` from the same predecessor, creating a **hash-chain fork**. After the fork, `verify_chain()` will permanently return `False`, falsely indicating tampering and undermining the integrity assurance of the audit system.

SQLite's WAL mode substantially reduces the probability window, but it does not eliminate it: concurrent sessions can still see the same snapshot under read isolation.

**Remediation:** Use `SELECT ... FOR UPDATE` (or SQLite equivalent via `BEGIN EXCLUSIVE`) when reading the last entry, or insert with a unique sequence constraint that forces serialization. A simpler approach: make `record()` always re-query inside a `SERIALIZABLE` isolation level or use a DB-level sequence for `prev_hash`.

---

### M6 — No rate limiting on downloads or API key creation

**Files:** `app/routes/public.py`, `app/routes/keys.py`  
**OWASP:** A05 — Security Misconfiguration

**Download endpoint:** `GET /file/{slug}/raw` is public and unauthenticated. For server-encrypted files, each request triggers AES-GCM decryption and optionally Zstd decompression entirely on the server. An attacker knowing any active slug can hammer this endpoint to exhaust CPU and I/O with no IP-level throttle. There is no per-slug download rate limit.

**API key creation:** `POST /keys/` has no rate limit and no maximum keys per user. A user with `can_use_api_keys=True` can create an unbounded number of keys. Each key creation writes to the DB and is permanently stored (only deactivated, never deleted). This allows unbounded DB and index growth.

**Remediation:** Implement rate limiting at the reverse proxy or application layer (e.g., `slowapi` for FastAPI). For downloads, limit by IP or slug. For key creation, enforce a per-user maximum (e.g., 10 active keys).

---

## LOW Severity

### L1 — File deletion in `lifecycle.py` bypasses `safe_join`

**File:** `app/jobs/lifecycle.py:104`

Background lifecycle jobs delete files via:
```python
path = storage_root() / f.storage_path
path.unlink(missing_ok=True)
```

This does not call `safe_join()`. If `f.storage_path` in the database contained a path traversal sequence (e.g., `../../etc/important`), the job would delete an arbitrary file outside the storage root. Storage paths are always generated by the app using `secrets.token_hex(32)`, so this is not exploitable without prior DB compromise. However, it is inconsistent with every other file operation in the codebase, which correctly uses `safe_join`.

**Remediation:** Replace with `safe_join(storage_root(), f.storage_path)` for defensive consistency.

---

### L2 — `_sweep_stale_parts()` on every chunked upload init

**File:** `app/routes/files.py:490`

Every call to `POST /files/upload/init` triggers `_sweep_stale_parts()`, which walks the entire storage root with `rglob("*.parts")` and `rglob("*.part")`:

```python
def upload_init(...):
    _sweep_stale_parts()  # full rglob scan
    ...
```

On a large storage volume with many files, this scan blocks the request handler and can be slow. Under concurrent upload initiation (e.g., many API clients simultaneously starting chunked uploads), the overlapping scans create unnecessary I/O amplification.

**Remediation:** Move the sweep to a background job (e.g., run via APScheduler like the other lifecycle jobs) and remove it from the hot upload path.

---

### L3 — Legacy server-encrypted files bypass the `?ek=` access key check

**File:** `app/routes/public.py:64–65`

Files encrypted before the `enc_access_blob` field was added have `enc_access_blob = NULL`. The access key verifier explicitly allows these to download without any credential:

```python
def _verify_access_key(request: Request, f: FileObject, ek: str | None) -> bool:
    if not f.enc_access_blob:
        return True  # legacy server-encrypted file — no credential required
```

While this is a deliberate backwards-compatibility decision, it means any server-encrypted file without an `enc_access_blob` can be downloaded by anyone who knows its slug — removing the link-unguessability protection as the only gate. If those files handle sensitive content, this is a meaningful gap.

**Remediation:** Audit whether any production files have `encryption_mode='server'` and `enc_access_blob IS NULL`. If so, consider a migration to retroactively seal access credentials for them.

---

### L4 — Username field lacks API-level length constraint

**File:** `app/routes/users.py:19–26`

```python
class CreateUserBody(BaseModel):
    username: str   # no max_length
    password: str
```

The database column enforces `String(255)`, but Pydantic will accept arbitrarily long usernames before the DB raises a truncation or constraint error. This is a defense-in-depth gap — unnecessary large payloads are processed by the application layer before being rejected. (Only master users can create accounts, which limits the attack surface.)

**Remediation:** Add `username: str = Field(..., max_length=255)` to `CreateUserBody`.

---

### L5 — API keys hashed with fast SHA-256

**File:** `app/security/api_keys.py:15`

```python
def hash_key(plain: str) -> str:
    return hashlib.sha256(plain.encode("utf-8")).hexdigest()
```

API keys are stored as SHA-256 hashes rather than with a slow/memory-hard hash like Argon2 or bcrypt. The practical risk is low because `secrets.token_urlsafe(32)` produces 256 bits of entropy — large enough to make brute-force impractical. However, if the database is exfiltrated, a GPU cluster can compute SHA-256 at billions of hashes per second, which becomes relevant if any key was generated with reduced entropy or if hash collisions are otherwise exploited.

**Remediation:** Use `hashlib.sha3_256` as a minimal improvement, or switch to a proper keyed HMAC (e.g., `hmac.new(master_key, key_bytes, sha256)`) so key hashes are useless without the server-side master key.

---

### L6 — `files.html` static file referenced but does not exist

**File:** `app/main.py:193–195`

```python
@app.get("/files")
def files_page():
    return FileResponse(str(_STATIC / "files.html"))
```

The static directory contains `index.html`, `admin.html`, `change.html`, `directory.html`, `download.html`, `login.html`, and `api-docs.html` — but no `files.html`. Any request to `GET /files` will produce a `500 Internal Server Error` (FileNotFoundError). This is a reliability bug, but also reveals internal file paths in error responses depending on FastAPI's exception handler configuration.

**Remediation:** Create `app/static/files.html` or correct the route to point to the right file.

---

## Informational

### I1 — `can_use_p2p` permission flag never enforced

**File:** `app/permissions/policy.py`, `app/models/permission.py`

The `can_use_p2p` boolean flag is declared in the permission model and `_BOOL_FLAGS` list, but no route or dependency checks it. If P2P functionality is added later without reference to this flag, the permission system provides no protection.

---

### I2 — `Credential` model defined but entirely unused

**File:** `app/models/credential.py`

A `Credential` table with `webauthn_id`, `webauthn_public_key`, `sign_count`, and `kind` fields is defined but never imported or referenced anywhere in the application routes, dependencies, or migrations. Dead code increases the attack surface if the model is accidentally exposed or if a future developer assumes it is already integrated.

---

### I3 — Raw SQL string formatting in migration helper

**File:** `app/db.py:104`

```python
conn.execute(text(f'ALTER TABLE "{table}" ADD COLUMN {column} {ddl}'))
```

`column` and `ddl` are interpolated directly from the hardcoded `_ADDED_COLUMNS` list, so there is no current injection vector. However, if future developers add entries to `_ADDED_COLUMNS` with user-influenced values (e.g., a column name derived from a config file), this pattern would become a SQL injection sink.

---

### I4 — Naive env file parser

**File:** `app/config.py:54–61`

The env file parser uses a simple `partition("=")` without quote handling, comment inline stripping, or escape processing:

```python
key, _, val = line.partition("=")
values[key.strip()] = val.strip()
```

Values containing `=` characters (e.g., base64 strings with padding) work correctly because `partition` splits on the first `=` only. However, values with leading/trailing spaces, inline comments (`KEY=val # comment`), or quoted strings (`KEY="val"`) are silently mishandled.

---

## What the Codebase Gets Right

The following security controls are correctly and thoughtfully implemented — listed here to distinguish them from the findings above:

- **Argon2id password hashing** with strong parameters (m=64 MiB, t=3, p=4)
- **Per-session CSRF tokens** validated on all state-changing operations
- **SameSite=Strict, HttpOnly, Secure** session cookies
- **Brute-force lockout** tracking both username and IP independently
- **`safe_join()` path traversal guard** on all direct file operations (except `lifecycle.py`)
- **Atomic link consumption** via a single `UPDATE WHERE` to prevent race conditions on `max_uses`
- **Constant-time comparison** (`secrets.compare_digest`) for access key validation
- **Content-type sanitization** — HTML/SVG types rewritten to `application/octet-stream` before storage
- **AES-256-GCM file encryption** with per-file keys sealed under a master key
- **Chunked upload token authentication** — sealed with AEAD using domain-specific AAD
- **Decompression bomb protection** — ratio limit (50×) and absolute cap (10 GiB)
- **Append-only audit log** enforced by DB triggers, with SHA-256 hash-chain integrity
- **Random storage paths** — filenames never reflected in filesystem paths
- **HTTPS redirect** enforced in non-dev environments
- **Content-Security-Policy** headers on all download/upload-facing pages
- **Username enumeration prevention** — identical error for wrong user vs. wrong password

---

*End of report. No code was modified during this audit.*
