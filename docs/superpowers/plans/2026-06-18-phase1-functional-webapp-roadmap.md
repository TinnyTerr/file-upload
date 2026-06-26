# Phase 1 — Functional Webapp Roadmap & Checklist

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status snapshot (2026-06-18):**
- Plan 1 — Foundation & Auth: ✅ **all 11 tasks complete**, merged-ready on `fileupload-app`.
- Plan 2 — Data Model & Permissions: ✅ **all 11 tasks complete** on `phase1-data-model` (current branch).
- Full test suite: **67 passed** locally (`./.venv/Scripts/python.exe -m pytest`).
- Branch diff vs `main`: 12 commits ahead on `phase1-data-model`.
- **This document** is the checklist for the remaining Phase 1 work — what it takes to go from "models + auth + tests pass" to "I can log in, upload a file, share a link, and download it in a browser."

**Goal:** Ship a usable private-club file-upload webapp end-to-end (log in → upload → link → download) with a dark minimal UI. Master can add users. Encryption and TOTP are deferred (not required for a functional v1).

**Architecture:** A small set of new routes (`app/routes/files.py`, `app/routes/users.py`, `app/routes/audit_view.py`) mounted by `app/main.py`, plus a `static/` directory with hand-rolled HTML/JS/CSS served by FastAPI's `StaticFiles`. Uploads stream to `storage/<random>` chunk-by-chunk (no full buffering) — matching the §5 memory discipline. The download route enforces link activation atomically (`consume_use` already exists), streams bytes, and renders the public download page. Server-side encryption and the chunked AEAD engine are stubbed for v1 (mode=`none` only; the field is reserved).

**Tech Stack:** FastAPI + uvicorn (already wired), SQLAlchemy 2.0 sync, SQLite (existing), `python-multipart` (already in deps), `tuspy`/`aiohttp` **deferred** to v2 (we'll use plain `UploadFile` for v1; Tus adds resumable uploads which is not needed for a working v1). Frontend = vanilla HTML/JS, no framework. Dark CSS, one accent color, system monospace + sans.

**Reference spec sections already covered:** §3 (data model), §4 (encryption model *field level* — server-side primitive + per-file key wrap deferred), §5 (*partially* — quotas enforced at upload time, archival jobs deferred), §6 (auth, roles, permissions, API keys — all DONE).

**Reference spec sections NOT covered by this roadmap (deferred to later phases):** §4.1 chunked AEAD wire format, §7 Tus chunked uploads, §8 HTTP Range (we'll do basic streaming + Content-Length only), §9 admin panel *UI* (we'll do a minimal text-based version), §10 polished aesthetic (v1 will be functional-not-pretty), §11 Phase 2 video, §12 Phase 3 P2P.

---

## What's already done — DON'T redo

- [x] `app/config.py` — settings + first-run secret generation
- [x] `app/db.py` — engine, `Base`, `UTCDateTime`, `init_db` (all models registered)
- [x] `app/models/{user,audit,session,login_attempt,permission,file,link,api_key,credential}.py`
- [x] `app/security/{passwords,sessions,lockout,csrf,secretbox,api_keys}.py`
- [x] `app/audit/log.py` — append-only hash chain + `record()`
- [x] `app/bootstrap.py` — `ensure_master` + auto-grants full `Permission` row
- [x] `app/deps.py` — `AppState`, `get_db`, `client_ip`, `current_session`, `require_active_user`, `require_master`, `require_permission`, `require_api_key`
- [x] `app/permissions/policy.py` — `ensure_permissions`, `has_permission`
- [x] `app/links/{slugs,consume}.py` — slug generator + atomic `consume_use`/`resolve_active_link`
- [x] `app/routes/auth.py` — `POST /auth/login`, `POST /auth/logout`
- [x] `app/routes/account.py` — `POST /account/change-credentials`, `GET /account/me`
- [x] `app/__main__.py` — `python -m app` runs uvicorn bound to 127.0.0.1

---

## Remaining work — checklist

Order is roughly: storage plumbing → upload route → download routes → list/delete → master user mgmt → static UI → wire it all → smoke test. Each item is sized for one task in the eventual subagent-driven plan.

### A. Storage layer (foundation for upload/download)

- [ ] **A1. Storage paths + atomic write**
  - Files: `app/storage/__init__.py`, `app/storage/paths.py`, `tests/test_storage_paths.py`
  - API: `app.storage.paths.storage_root() -> Path`, `new_internal_path() -> Path` (random hex), `safe_join(root, rel) -> Path` (rejects `..`)
  - Why: every file lives at `<storage_root>/<ab>/<cd>/<rand>` — random so listings don't leak.

- [ ] **A2. Streaming file writer**
  - Files: `app/storage/writer.py`, `tests/test_storage_writer.py`
  - API: `open_writer() -> BinaryIO` (creates the file under `new_internal_path()`, returns handle; finalizes on close, rolls back if exception)
  - Why: streaming chunks from FastAPI's `UploadFile` to disk without loading whole file into memory. Honor §5 memory rule.

- [ ] **A3. Storage directory created on startup**
  - Modify: `app/main.py` lifespan → `storage_root().mkdir(parents=True, exist_ok=True)` after `init_db`.

### B. Upload pipeline

- [ ] **B1. `POST /files/upload` — multipart single-file upload**
  - Files: `app/routes/files.py`, modify `app/main.py` (include router), test `tests/test_upload_route.py`
  - Body: multipart fields: `file` (binary), `original_filename` (string), `max_uses` (int, optional), `expires_in_seconds` (int, optional)
  - Auth: `require_active_user` + `require_permission("can_upload")`.
  - Quota: reject if `file.size + used_bytes(user) > permissions.quota_bytes` or `file.size > permissions.max_file_bytes` — server-authoritative (§5).
  - Action: stream to disk via `open_writer`, create `FileObject` (mode=`none` for v1), create a default `Link` with new slug, commit, audit `file.uploaded`.
  - Response: `{file_id, slug, url, raw_url, max_uses, expires_at}`.
  - Tests: happy path, oversized rejected, quota-exceeded rejected, unauthenticated 401, no-permission 403.

- [ ] **B2. `GET /files/` — list my files (or all if master)**
  - Files: modify `app/routes/files.py`, test `tests/test_list_files.py`
  - Auth: `require_active_user`.
  - Master: returns all files grouped by owner (for the admin panel later); user: returns own only.
  - Response: `[{id, original_filename, size_bytes, content_type, encryption_mode, created_at, links: [{slug, url, max_uses, use_count, expires_at, active}]}]`.

- [ ] **B3. `DELETE /files/<id>` — delete a file (owner or master)**
  - Files: modify `app/routes/files.py`, test `tests/test_delete_file.py`
  - Auth: `require_active_user`, `require_permission("can_delete")`. Owner check (or master bypass).
  - Action: delete from disk, delete `FileObject` (cascade links), audit `file.deleted`.

### C. Download pipeline

- [ ] **C1. `GET /file/<slug>` — public download page (HTML)**
  - Files: `app/routes/public.py` (new — no auth required), modify `app/main.py`, test `tests/test_download_page.py`
  - No auth (anyone with the slug gets the page).
  - Logic: `resolve_active_link(slug)` → if None, 404. Else render HTML with filename, size, type, Download button (`/file/<slug>/raw`), and a copy-link button.
  - Security headers: `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, CSP `default-src 'self'; script-src 'self'; object-src 'none'` (§8 preview hardening).
  - For v1: skip the in-browser preview (download button only) — preview hardening can be a follow-up.

- [ ] **C2. `GET /file/<slug>/raw` — raw bytes**
  - Files: modify `app/routes/public.py`, test `tests/test_download_raw.py`
  - No auth (the slug is the credential).
  - Logic: `consume_use(slug)` atomic — if False, 404 (used up / expired / inactive). Stream the file with `Content-Disposition: attachment; filename="<original>"` and `Content-Type: <file.content_type>`.
  - Audit `file.downloaded` with IP (best-effort; don't block stream on audit failure).
  - Tests: success 200 with right bytes, used-up 404, expired 404, max_uses atomic (concurrency-style: two requests, one wins).

- [ ] **C3. `POST /files/<id>/links` — mint a new link with options**
  - Files: modify `app/routes/files.py`, test `tests/test_mint_link.py`
  - Auth: `require_active_user`, `require_permission("can_regenerate_links")`. Owner check.
  - Body: `{max_uses?, expires_in_seconds?}`
  - Action: create `Link` for the file, return `{slug, url}`. Audit `link.created`.

### D. Master user management

- [ ] **D1. `POST /users/` — create a new user (master only)**
  - Files: `app/routes/users.py` (new), modify `app/main.py`, test `tests/test_create_user.py`
  - Auth: `require_master`.
  - Body: `{username, password, role ("user"|"master"), permissions: {can_upload?, quota_bytes?, max_file_bytes?, ...}}`
  - Action: create `User` (argon2 hash, `must_change_credentials=False`), create `Permission` row via `ensure_permissions`. Audit `user.created`.
  - Validation: username uniqueness (409), password length ≥ 12.

- [ ] **D2. `DELETE /users/<id>` — delete a user (master only)**
  - Files: modify `app/routes/users.py`, test `tests/test_delete_user.py`
  - Auth: `require_master`. Refuse to delete self (400).
  - Action: delete user + permissions + sessions. Audit `user.deleted`. Files owned by that user remain (orphaned) for now — could add re-assign or cascade later.

- [ ] **D3. `POST /users/<id>/permissions` — update permissions (master only)**
  - Files: modify `app/routes/users.py`, test `tests/test_update_perms.py`
  - Auth: `require_master`.
  - Body: partial Permission fields (only the ones you want to change).
  - Action: load Permission (ensure exists), patch fields, commit. Audit `permissions.updated`.

- [ ] **D4. `GET /audit/` — audit log (master only)**
  - Files: `app/routes/audit_view.py` (new), modify `app/main.py`, test `tests/test_audit_view.py`
  - Auth: `require_master`.
  - Query: `?limit=100&offset=0&actor=...&action=...`.
  - Response: `{entries: [{id, actor, action, target, ip, created_at}], chain_ok: <bool from verify_chain>}`.

### E. Static UI (vanilla HTML/JS/CSS — dark, minimal)

- [ ] **E1. Static dir layout + dark theme CSS**
  - Files: `app/static/css/theme.css` (CSS variables for dark palette, monospace + sans, accent color), `app/static/index.html` (redirects to `/login` or `/files` based on session).
  - One accent color (suggest `#ff8a4c` — warm orange on near-black). Generous spacing. System font stack.

- [ ] **E2. Login page (`/login`)**
  - Files: `app/static/login.html`, `app/static/js/login.js`
  - Form: username + password → POST `/auth/login` → save `csrf_token` to `localStorage`/cookie → redirect `/files`.
  - Show error on 401/429. On 200 with `must_change_credentials=true`, redirect `/account/change` instead.

- [ ] **E3. Change-credentials page (`/account/change`)**
  - Files: `app/static/change.html`, `app/static/js/change.js`
  - Form: current password + new username + new password (twice). POST `/account/change-credentials`. Show success → redirect `/files`.

- [ ] **E4. Upload page (`/files`)**
  - Files: `app/static/files.html`, `app/static/js/files.js`
  - Drag-drop zone (single file for v1) + per-file options (max uses, expires-in-seconds). Submits as multipart POST `/files/upload`. On success show the share URL + copy button + raw URL + curl one-liner.
  - Lists the user's files below with delete + mint-link buttons (calling D routes via fetch).

- [ ] **E5. Download page (`/file/<slug>` — the public route already serves HTML)**
  - Modify: `app/routes/public.py` to render `app/static/download.html` (or inline template for v1 — Jinja not installed).
  - File: `app/static/download.html`, `app/static/js/download.js`
  - Shows filename, size, type. Single "Download" button → `/file/<slug>/raw` (triggers browser save).

- [ ] **E6. Admin panel page (`/admin`, master only)**
  - Files: `app/static/admin.html`, `app/static/js/admin.js`
  - Tabs: Users (list + create + delete + edit permissions), Audit Log (paginated table from `/audit/`).
  - Hide entirely for non-master users.

- [ ] **E7. Mount static dir in `main.py`**
  - Modify: `app/main.py` → `app.mount("/static", StaticFiles(directory="app/static"))`. Optionally redirect `/` → `/static/index.html`.
  - Add `index.html` redirect logic (FastAPI `StaticFiles` already serves `index.html` automatically).

### F. Smoke test (run the app end-to-end)

- [ ] **F1. `python -m app` smoke test script**
  - Files: `scripts/smoke.sh` (or `scripts/smoke.ps1` for Windows).
  - What it does: starts uvicorn, waits for `/health`, logs in as bootstrap admin, changes credentials, uploads a small test file, downloads it via the public slug, asserts byte equality, kills the server.
  - Run: `./scripts/smoke.ps1` (or `./scripts/smoke.sh` on Linux/Mac). Should exit 0.

- [ ] **F2. Manual browser smoke (the human does this one)**
  - Steps documented in README or a `RUN.md`: `python -m app`, open `http://127.0.0.1:8000/`, log in, upload, share URL, open in incognito, download.
  - Take screenshots if you want — not required.

### G. Polish + invariants (do these as you go, don't skip)

- [ ] **G1. Quota accounting**
  - When upload succeeds, `permissions`-level quota tracking OR a `users.used_bytes` column (denormalized). v1: just `SUM(files.stored_size_bytes) WHERE owner_id=?` per request — fine for SQLite + single-process.
  - Enforce at upload-time (reject) AND at storage accounting display time.

- [ ] **G2. Atomic link use + audit reliability**
  - The `consume_use` rowcount check is already there (§8). Confirm `audit file.downloaded` is best-effort (don't break the download if the audit insert fails — log + move on).

- [ ] **G3. Security headers everywhere**
  - Confirm `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer` are set on `/file/<slug>` and `/file/<slug>/raw` (§8 hardening). Add a small FastAPI middleware OR set per-route.

- [ ] **G4. Update `README.md` + add `RUN.md`**
  - `README.md`: project pitch, status (Phase 1 in progress), quick start (3 commands).
  - `RUN.md`: detailed walkthrough — first-run admin password, how to log in, how to add a user, how to upload, where the storage dir is.

---

## Explicitly DEFERRED (not part of "functional webapp" — separate later plans)

- [ ] **Tus chunked uploads** (spec §7) — needs `tuspy` server + Uppy Tus client. Skipped for v1; we use plain multipart.
- [ ] **HTTP Range support** (spec §8) — v1 streams whole file via `Content-Length` + `StreamingResponse`. Range adds resume + seeking.
- [ ] **Server-side encryption engine** (spec §4) — `FileObject.encryption_mode = "none"` is the only value produced in v1. The `seal`/`open_box` primitive is already shipped (Plan 2 Task 1); wiring it into a per-file key flow is its own plan.
- [ ] **Client-side encryption in browser** (spec §4 + §4.1) — WebCrypto + Web Worker pipeline. Gated by `can_upload_client_encrypted` (off by default).
- [ ] **TOTP / WebAuthn 2FA** (spec §6) — `Credential` model already shipped (Plan 2 Task 10); enrollment + verification routes are a separate plan.
- [ ] **Archival jobs / APScheduler** (spec §5) — file-level compression, idle expiry, link expiry GC.
- [ ] **P2P tab / WebRTC** (spec §12) — entirely Phase 3.
- [ ] **Service Worker video streaming** (spec §11) — entirely Phase 2.
- [ ] **Polished UI** (spec §10) — v1 is functional-not-pretty. Dark + minimal. No animations.

---

## Sequencing suggestion

1. Land `A1–A3` first (storage primitives + tests).
2. Then `B1` (upload route — exercises storage + creates FileObject + Link).
3. Then `C1` + `C2` (download — closes the loop: upload → download).
4. Then `B2`, `B3`, `C3` (list/delete/mint-link) — manage page support.
5. Then `D1–D4` (user mgmt + audit view) — admin panel support.
6. Then `E1–E7` (UI). E5 needs C1 done.
7. Then `F1` (automated smoke) + `G3` (security headers) + `G4` (docs).
8. Then `G1–G2` (quota + audit reliability — fold into the route tasks).

The whole roadmap is roughly **5–7 subagent tasks** at the size the writing-plans skill expects (each task = one route + its test + its UI hook, plus one final smoke). Bigger tasks are allowed for E (UI bundles multiple pages).

---

## Done-when checklist

The branch is "Phase 1 functional" when ALL of these are true:

- [ ] `python -m app` starts the server on `127.0.0.1:8000`.
- [ ] First-run admin password is printed to the console.
- [ ] Logging in via `/login` sets a session cookie + redirects to `/files`.
- [ ] Force-change-credentials flow works (clear the `must_change_credentials` flag).
- [ ] Uploading a file from `/files` returns a `/file/<slug>` URL.
- [ ] Opening `/file/<slug>` in an incognito window shows the download page.
- [ ] Clicking download saves the exact bytes uploaded.
- [ ] Master can create a new user from `/admin` and log in as that user.
- [ ] Master can see the audit log on `/admin`.
- [ ] `max_uses` is enforced (link stops working after N downloads).
- [ ] Quota rejection works (upload over the limit → 4xx with clear message).
- [ ] `./scripts/smoke.ps1` (or `.sh`) exits 0 end-to-end.
- [ ] README + RUN.md updated.
- [ ] Full test suite still green (`pytest -q` → all pass).

**NOT required for "functional"** (deferred as above): encryption of any kind, TOTP, Tus, Range, archival, P2P, video streaming, polished UI.

---

## How to use this document

This is a **checklist + roadmap**, not a subagent-ready plan. To turn it into one, split each section's items into bite-sized TDD tasks (each task = test + impl + commit), follow the writing-plans skill's per-task format (interface contracts, exact paths, code in every step), then dispatch via `superpowers:subagent-driven-development` or `superpowers:executing-plans`.

If you want the bite-sized subagent-ready plan now, the next step is to take section **A** + **B** + **C** (storage + upload + download) and turn it into a plan file at `docs/superpowers/plans/2026-06-19-phase1-upload-download.md`. Sections **D** + **E** + **F** can be a follow-up plan file once the backend routes land.
