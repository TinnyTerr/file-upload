# Unresolved Issues

Findings from the three-agent review (static bugs / logical flow / security) that were
**not fixed** in the bug-fix pass, with the reason each was deferred and a suggested
remediation. The Critical/High/Medium correctness & access-control findings were fixed
and verified; what remains below is either deployment-dependent, a larger design change,
low-severity, or outside the backend scope.

Date: 2026-06-28

---

## Deferred — non-trivial / risk or scope

### Quota race: `with_for_update()` is a no-op on SQLite (M2/M3, logical)
- **Where:** `app/routes/files.py:191-196` (per-user), `app/storage/accounting.py:109-114` + `app/routes/files.py:186` (global), same gap in `app/routes/dropbox.py` and `app/routes/remote_upload.py:139`.
- **Issue:** Concurrent uploads each read `used < quota` before either inserts its row, so the per-user `quota_bytes` and the global cap can both be exceeded. `SELECT ... FOR UPDATE` is silently ignored by SQLite.
- **Why deferred:** Only exploitable on SQLite (real serialization on Postgres). A correct fix needs an atomic `UPDATE ... WHERE used+size<=quota` guard or `BEGIN IMMEDIATE`, which is a broader transactional change and easy to regress.
- **Suggested fix:** Enforce the quota with a single atomic conditional UPDATE on an accounting row, or run the finalize step under an explicit `BEGIN IMMEDIATE` transaction.

### X-Forwarded-For spoofing defeats lockout + API-key IP binding (M-1, security)
- **Where:** `app/deps.py:39-46` (`client_ip`); consumers `app/security/lockout.py`, `app/security/api_keys.py`, `app/deps.py:105-110`.
- **Issue:** When `trust_proxy=True`, the left-most XFF entry is trusted with no trusted-proxy allow-list or hop count. A client that can reach the origin directly (or a proxy that *appends* XFF) can forge the client IP — nullifying per-IP lockout and bypassing API-key IP binding by setting `X-Forwarded-For: <bound-ip>`.
- **Why deferred:** This is a deployment-configuration concern, not a one-line code fix; the correct hop depends on the actual proxy topology.
- **Suggested fix:** Only honor XFF from a configured list of trusted proxy IPs and parse the right-most untrusted hop (e.g. uvicorn `--proxy-headers` / `forwarded_allow_ips`, or Starlette `ProxyHeadersMiddleware`). Never trust raw XFF for security decisions.

### API keys stored as fast unsalted SHA-256 (L-3, security)
- **Where:** `app/security/api_keys.py:15-16`.
- **Issue:** `hash_key` is plain `sha256(plain)`. Practically safe given 256-bit random keys, but a DB exfil + GPU trivially recovers any reduced-entropy key.
- **Why deferred:** Changing the hash scheme invalidates every existing stored key (no migration path in-repo).
- **Suggested fix:** Keyed HMAC under the server master key — `hmac.new(master_key, raw, sha256)` — so stolen hashes are useless without the master key. Roll out behind a key-rotation/migration.

### No rate-limiting on public download / zip / dropbox endpoints (M-2, security)
- **Where:** `app/routes/public.py:124-307` (`/file/{slug}/raw`), `app/routes/directories.py:682-731` (`/d/{slug}/zip`), dropbox upload endpoints.
- **Issue:** Anyone holding a slug can force unbounded server-side AES-GCM decryption, zstd decompression to temp files, and full-bundle ZIP assembly — CPU/disk/IO amplification, fully unauthenticated.
- **Why deferred:** Best addressed at the proxy/application-middleware layer; no rate-limiter exists in the app and adding one is a cross-cutting feature, not a bug fix. (Decompression-bomb caps in `app/storage/compress.py` are already present and correct.)
- **Suggested fix:** Per-IP and per-slug rate limits on download/zip; cap concurrent server-side zip jobs and total bytes per zip.

### Client build cannot compile in this checkout (M1, static — repo hygiene)
- **Where:** `.gitignore:17` (`lib/` rule); missing files `client/src/lib/base64url.ts`, `client/src/lib/download.ts`, `client/src/lib/bytes.ts`, `client/src/features/files/lib/uploadCore.ts`, `client/src/features/files/lib/fileMeta.ts`.
- **Issue:** The broad Python-venv `lib/` ignore rule also matches `client/src/**/lib/`, so several required TypeScript source modules were never committed and are absent here. They are imported widely (`@/lib/base64url`, `@/lib/download`, `../lib/uploadCore`, …), so `client/` cannot build. (`node_modules` is also not installed in this checkout.)
- **Why deferred:** Pre-existing and unrelated to the reviewed bugs; the source contains crypto/upload logic that must not be blindly reconstructed. The author's working tree presumably still has these files.
- **Suggested fix:** Scope the ignore to the venv (e.g. `/lib/`, `/lib64/`) or add `!client/src/**/lib/`, then commit the missing source files.

---

## Low severity — not fixed

### Login timing oracle enables username enumeration (L-1, security)
- **Where:** `app/routes/auth.py:34-40`.
- **Issue:** Argon2 verification only runs when the username exists, so a non-existent user returns markedly faster than a valid user with a wrong password — a reliable timing oracle despite the identical error string.
- **Suggested fix:** Verify against a fixed dummy Argon2 hash when the user is absent so both paths cost the same.

### Successful login resets the shared IP lockout (L1, logical)
- **Where:** `app/routes/auth.py:42-43`.
- **Issue:** On success both the user *and* the IP lockout counters are reset. An attacker holding one valid credential can periodically log in to clear the per-IP throttle, weakening brute-force protection for other accounts from the same IP.
- **Suggested fix:** Reset only the user identifier on success (leave the IP counter), or don't reset IP on success.

### Legacy server-encrypted files with `enc_access_blob IS NULL` skip the `?ek=` gate (L-2, security)
- **Where:** `app/routes/public.py:59-66` (`_verify_access_key` returns `True` when the blob is falsy).
- **Issue:** Such files download with no access credential — slug guessability is the only gate.
- **Suggested fix:** Confirm none exist in production (`encryption_mode='server' AND enc_access_blob IS NULL`); migrate/seal them or block download.

### Inconsistent expiry boundary comparisons (L2, logical)
- **Where:** `app/links/consume.py:20,42` use `<=`/`>` (inclusive), while `app/routes/directories.py:91` and `app/routes/admin.py:68` use `<`.
- **Issue:** At the exact `expires_at` instant, `/info` and the actual gate can disagree for one tick.
- **Suggested fix:** Standardize on `expires_at <= now ⇒ expired` everywhere.

### `Accept-Ranges: bytes` advertised but `Range` ignored for encrypted/compressed downloads (M2, static)
- **Where:** `app/routes/public.py:162-258`.
- **Issue:** The decrypt/decompress branches return a full `200` body but still send `Accept-Ranges: bytes`; a client issuing a `Range:` request expecting `206` gets the whole file.
- **Suggested fix:** Drop `Accept-Ranges` from the encrypted/compressed responses (Range is only honored in the plaintext-uncompressed branch).

### `directory_zip` records the download-audit row in a swallowed transaction (M3, static)
- **Where:** `app/routes/directories.py:717-722`.
- **Issue:** The audit `record(...)` + `commit()` are wrapped in `try/except: rollback()`, so a download can be served with no audit trail and no signal (compare `download_raw`, which 500s if the download record fails to commit).
- **Suggested fix:** Decide whether the audit row is mandatory; if so, fail the request on commit error.

### `_safe_arcname` produces leading-space names for dotfiles (L2, static)
- **Where:** `app/routes/directories.py:734-750`.
- **Issue:** `"file".partition(".")` on `.env` yields an empty stem, so a collision rename becomes `" (1).env"` (leading space). Cosmetic.
- **Suggested fix:** Fall back to the `base` form when `stem` is empty.

### Dropbox single-shot upload skips the up-front size precheck (L3, static)
- **Where:** `app/routes/dropbox.py:403-437`.
- **Issue:** Streams to disk and only checks `max_file_bytes` per-chunk + quota after the full write, unlike the chunked path's `_precheck_declared_size`. Wastes I/O on a doomed oversized upload (caps are still enforced).
- **Suggested fix:** Add the same declared-size precheck before streaming.

### `useSaveFolder` response type mismatch (L1, static — client)
- **Where:** `client/src/features/folder-view/hooks/useSaveFolder.ts:7`.
- **Issue:** Declares `{ directory_id: number }` but `save_directory` returns `{ id, slug, url, saved_files, ... }` (no `directory_id`). Harmless today (value unused) but the type is wrong.
- **Suggested fix:** Type it as `{ id: number; slug: string }`.

---

## Verified not an issue
- **`CreateUserBody.username` length (L-4, security):** already bounded — `app/routes/users.py:31` has `Field(..., max_length=255)`. No change needed.
