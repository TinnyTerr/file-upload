# STATE.md — File Upload Webapp: Build Progress & Recovery State

> Living recovery doc. If the chat runs out of tokens, READ THIS FIRST, then
> `cat "$(git rev-parse --git-path sdd)/progress.md"` (the durable task ledger),
> then `git log --oneline`. Trust the ledger + git over any vague recollection.

Last updated: 2026-06-18.

---

## TL;DR — where we are

- **Branch:** `phase1-data-model` (currently checked out; 12 commits ahead of `main`).
- **Tests:** 67/67 passing locally (`.venv/Scripts/python.exe -m pytest -q`).
- **Plan 1 (Foundation & Auth, 11 tasks):** ✅ COMPLETE on `fileupload-app` (merged into main at `604cdfc`).
- **Plan 2 (Data Model & Permissions, 11 tasks):** ✅ COMPLETE on `phase1-data-model` per git log; **ledger entry not yet written** (next-step TODO below).
- **What's left to ship "Phase 1 as a functional webapp":** upload route, download route, static UI, master user mgmt. See **roadmap →** below.

---

## 1. What we're building

A **private-club file upload webapp**. Python backend (FastAPI), vanilla JS + Uppy + WebCrypto frontend. Dark, minimal, function-first UI. Deployed locally now; eventually an Ubuntu VM behind Nginx + Let's Encrypt.

**Model:** ships with a default master (admin) account. First login forces username + password change. Only the master can create more accounts. **Only users the master adds can upload. Anyone can download** given the link (+ key if encrypted) — the key IS the credential.

**Encryption (per-file, 3 modes):** none / server-side (`?ek=` access credential, server decrypts with its stored key) / client-side (`#ek=` fragment, browser decrypts, server NEVER sees key; gated by `can_upload_client_encrypted` permission, OFF by default).

**Links always random:** `files.itsaxo.lol/file/<slug>` (UI page) and `/file/<slug>/raw` (raw bytes for curl) — SAME slug. No key in URL → page prompts for it.

Full vision (encryption wire format, resource mgmt, archival, P2P, video streaming, etc.) lives in the spec — see §2.

---

## 2. Key documents (READ THESE)

- **Spec (approved):** `docs/superpowers/specs/2026-06-17-fileupload-design.md` — the complete vision. §1 Overview, §2 Stack, §3 Data model, §4 Encryption + §4.1 chunked AEAD wire format, §5 Resource mgmt, §6 Auth/roles/permissions/API keys, §7 Upload, §8 Download + preview hardening, §9 Admin panel, §10 UI, §11 Phase 2 video, §12 Phase 3 P2P, §13 Non-goals, §14 Risks.
- **Plan 1 (DONE):** `docs/superpowers/plans/2026-06-17-phase1-foundation-auth.md` — Phase 1 Foundation & Auth, 11 TDD tasks.
- **Plan 2 (DONE):** `docs/superpowers/plans/2026-06-18-phase1-data-model-permissions.md` — Phase 1 Data Model & Permissions, 11 TDD tasks.
- **Roadmap (NEXT, the checklist the user just asked for):** `docs/superpowers/plans/2026-06-18-phase1-functional-webapp-roadmap.md` — what remains to ship a functional webapp (upload + download + UI + admin).
- **Durable ledger:** `.git/sdd/progress.md` — currently covers only Plan 1 (Task 1–11 all complete + fix wave + final review). **Plan 2 ledger entry is a TODO** before resuming.

**Build strategy:** ONE vision spec → phased build. Phase 1 = Core (this plan). Future phases: Phase 2 video streaming, Phase 3 P2P. Plans 3+ (TOTP/Passkeys; Upload pipeline; Download; Admin panel + lifecycle jobs) get written via `superpowers:writing-plans` when reached — see roadmap for sequencing.

---

## 3. What's done (consolidated from both plans)

**Plan 1 — Foundation & Auth (all 11 tasks complete on `fileupload-app`):**
- Tasks 1–11 all merged-ready. 34 tests pass. Fix wave resolved 4 Important findings (loopback entrypoint, audit atomicity, record() flush-only refactor, audit created_at in hash chain). Final review approved.

**Plan 2 — Data Model & Permissions (all 11 tasks complete on `phase1-data-model` per git log):**
- Task 1: `app/security/secretbox.py` — AES-256-GCM seal/open with random 12-byte IV (`8cc223a`).
- Task 2: `app/models/permission.py` — Permission ORM with spec defaults (`3c0e581`).
- Task 3: `app/permissions/policy.py` — ensure/get/has (`46aeb7b`).
- Task 4: `app/deps.py` `require_master` + `require_permission` (`f676965`).
- Task 5: `app/models/file.py` — FileObject with retention/encryption fields (`ab79d0a`).
- Task 6: `app/models/link.py` + `app/links/slugs.py` — random slug generator (`5acdec9`).
- Task 7: `app/links/consume.py` — atomic `consume_use` / `resolve_active_link` (`9a8da29`).
- Task 8: `app/models/api_key.py` + `app/security/api_keys.py` — hashed key + per-IP bind logic (`85fb398`).
- Task 9: `app/deps.py` `require_api_key` — Bearer auth dependency (`8ddaa34`).
- Task 10: `app/models/credential.py` — TOTP/WebAuthn storage with sealed secret_blob (`a60b690`).
- Task 11: `app/bootstrap.py` — master gets a full Permission row at first run (`b450257`).
- All tests green: **67/67** (`test_*.py` covers everything from both plans).

**Routes that exist today:**
- `GET /health` — liveness.
- `POST /auth/login` — log in (lockout, audit).
- `POST /auth/logout` — log out (CSRF + audit).
- `GET /account/me` — current user info (gated by `require_active_user`).
- `POST /account/change-credentials` — first-run forced change (CSRF, audit).

**Routes that DON'T exist yet (next up):** upload, list, delete, mint-link, download page, raw download, user mgmt, audit view. See roadmap.

---

## 4. What's left to ship Phase 1 as a functional webapp

**The roadmap file** (`docs/superpowers/plans/2026-06-18-phase1-functional-webapp-roadmap.md`) is the single source of truth. Top-level items:

- **A. Storage layer:** storage paths, atomic streaming writer, startup mkdir.
- **B. Upload pipeline:** `POST /files/upload` (multipart + quota + audit), `GET /files/` (list), `DELETE /files/<id>`, `POST /files/<id>/links` (mint).
- **C. Download pipeline:** `GET /file/<slug>` (HTML page), `GET /file/<slug>/raw` (atomic use + bytes).
- **D. Master user mgmt:** `POST /users/`, `DELETE /users/<id>`, `POST /users/<id>/permissions`, `GET /audit/`.
- **E. Static UI:** login, change-creds, upload/manage, download, admin panel — vanilla HTML/JS/CSS, dark.
- **F. Smoke test:** automated end-to-end script + README/RUN docs.
- **G. Polish:** security headers, quota accounting, audit reliability.

**Deferred (not part of functional v1):** Tus, HTTP Range, server-side encryption, client-side encryption, TOTP/WebAuthn, archival jobs, P2P, video streaming, polished UI.

**Done-when** (from roadmap): `python -m app` boots, browser can log in → upload → share URL → download from incognito, master can create users + see audit log, max_uses + quota enforced, smoke script passes, README/RUN.md written.

---

## 5. Environment (CRITICAL — Windows)

- Repo root / working dir: `C:/Users/fagol/Documents/fileupload/fileupload`.
- Current branch: **`phase1-data-model`** (this is where Plan 2 lives; not yet merged to `main`). Main branch = `main`.
- Merge-base with main: `604cdfc` (the Plan 1 merge commit).
- **Python 3.12.10** via `py -3.12`. venv at `.venv`; **always** run tests with `./.venv/Scripts/python.exe -m pytest <path> -q` (PowerShell). Never bare `python`/`py` (system 3.10, wrong).
- Git on Windows emits harmless `LF will be replaced by CRLF` warnings — ignore.

---

## 6. Process: subagent-driven-development (superpowers skill)

When picking up the roadmap:

1. **First**, write a ledger entry for Plan 2 (mirror the structure of `.git/sdd/progress.md` — 11 task summaries with commit hashes from `git log --oneline`).
2. Convert roadmap sections into bite-sized TDD plans via `superpowers:writing-plans` (e.g. `2026-06-19-phase1-upload-download.md` covering A+B+C; `2026-06-19-phase1-admin-ui.md` covering D+E+F+G).
3. Execute via `superpowers:subagent-driven-development` (recommended) — one subagent per task, review between tasks, fix wave for any Important findings.
4. After all routes + UI land: full-branch Opus review + `superpowers:finishing-a-development-branch` to merge `phase1-data-model` (or a follow-up branch) into `main`.

**Helper scripts:**
- Task brief: `bash <task-brief> <plan.md> <N>` → writes `.git/sdd/task-N-brief.md`.
- Review package: `bash <review-package> BASE HEAD` → writes `.git/sdd/review-*.diff`.
- Templates at `.../subagent-driven-development/scripts/` + `.../task-reviewer-prompt.md`.

---

## 7. Model selection (per skill + user pref "use Haiku more")

- **Implementers** (small focused tasks): Haiku. Multi-file integration: Sonnet.
- **Task reviewers:** Sonnet (mid-tier floor). Security-sensitive (download atomicity, quota enforcement, audit reliability) stays Sonnet.
- **Fix subagents:** Haiku for mechanical; Sonnet for correctness.
- **Final whole-branch review:** Opus (most capable).

---

## 8. Carry-forward decisions (don't relearn)

- **`app.db.UTCDateTime`** — every datetime column. SQLite strips tzinfo otherwise.
- **httpx2 in dev deps** — silences TestClient deprecation; `httpx2` and `httpx` coexist.
- **0600 perms** — posix-only via `os.open(O_EXCL, 0o600)`; Windows skips (deploy target is Ubuntu).
- **Audit atomicity:** `record()` flush-only; callers commit. Done in Plan 1 fix wave (`0197ed3`).
- **UTCDateTime for every datetime col** — applied consistently in Plan 2 (file.created_at, link.created_at/expires_at, api_key.created_at/last_used_at, credential.created_at, permission.created_at).

---

## 9. HOW TO RESUME

1. `cat "$(git rev-parse --git-path sdd)/progress.md"` and `git log --oneline -20`.
2. Confirm branch is `phase1-data-model` (run `git branch --show-current`).
3. Run tests: `./.venv/Scripts/python.exe -m pytest -q` — expect 67 passed.
4. **NEXT:** the roadmap (`docs/superpowers/plans/2026-06-18-phase1-functional-webapp-roadmap.md`). The user's last ask was to **stop after creating the checklist**, so work is paused. Resume by either:
   - Picking a roadmap section (e.g. "A. Storage layer") and writing it as a subagent-ready plan, or
   - Starting on storage primitives (the A section) directly via `superpowers:executing-plans`.
5. **Optional pre-work:** write a Plan 2 ledger entry (`.git/sdd/progress.md` continuation) so the durable record matches git reality.
