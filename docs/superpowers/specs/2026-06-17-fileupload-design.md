# File Upload Webapp — Design Spec

**Date:** 2026-06-17
**Status:** Approved design — pending implementation planning
**Build strategy:** One vision spec (this doc), phased build — **Phase 1 Core → Phase 2 Progressive Video Streaming → Phase 3 P2P**. Each phase gets its own implementation plan and is built + verified before the next.

---

## 1. Overview

A self-hosted ("private club") file-upload webapp. **Only users the master explicitly adds can upload.** **Anyone can download** a file given its link and — if encrypted — the key. Built to run locally now and deploy later behind **Nginx + Let's Encrypt** on an Ubuntu VM.

Design priorities: fast transfers, strict memory/disk discipline, real client-side encryption, and a dark, minimal, function-first UI.

### Core mental model
- Upload = privileged (master-added users only).
- Download = open to whoever holds the **link** (+ **key** if encrypted).
- The **key is the credential**. Unencrypted files need only the link.

---

## 2. Tech Stack & Architecture

- **Backend:** Python **FastAPI** + **uvicorn** (async; ideal for streaming/chunked transfers).
- **Frontend:** Vanilla JS modules, no heavy framework. **Uppy** for the upload UX (drag-drop, progress, resumable **Tus** uploads) with a **custom Web Worker pre-processor** for encryption/compression/zipping. **WebCrypto** for all browser crypto.
- **Metadata DB:** **SQLite** via SQLAlchemy.
- **Blob storage:** local filesystem under `storage/`; each object has a **random internal ID**, decoupled from the public link ID and the original filename.
- **Background worker:** **APScheduler** for lifecycle jobs.
- **Service Worker:** powers progressive video streaming (Phase 2).
- **WebRTC + WebSocket signaling:** P2P tab (Phase 3).

### Deployment model (reverse-proxy-first)
- App speaks plain **HTTP**, binds to a configurable host/port (default `127.0.0.1:8000`).
- Honors `X-Forwarded-Proto` / `X-Forwarded-Host` so **Nginx** terminates TLS in front.
- **WebAuthn RP ID + expected origin are config/env values** (`localhost` now → `files.itsaxo.lol` later) — no code change to move environments.
- Secrets (session signing key, server-side encryption master key) live in a config/env file generated on first run.

---

## 3. Data Model (SQLite)

- **users** — id, username, argon2 password hash, role (`master` | `user`), `must_change_credentials` flag, created_at.
- **credentials** — WebAuthn passkeys + TOTP secrets per user (2FA).
- **permissions** — per-user flags (see §6). Notably `can_upload_client_encrypted` (default **off**), quotas, max file size, allowed retention ranges, can-delete, can-regenerate-links, `can_use_api_keys`, `can_use_p2p`.
- **api_keys** — id, owner_id, hashed key, **bound_ip** (NULL until first use), created_at, last_used_at, active?.
- **files** — id, owner_id, internal storage path, original filename, size (plaintext logical size), stored_size (actual bytes on disk), content-type, encryption mode (`none`|`server`|`client`), compressed?, archived?, archive_codec, retention settings (permanent/temp + expiry, archive-after-N-idle-days, auto-unarchive-on-download, delete-if-not-downloaded-in-X-days), created_at, last_downloaded_at.
- **links** — id, file_id, **public random slug** (the `<id>` in `/file/<id>`; **`secrets.token_urlsafe(16)` → 128 bits of entropy**, non-enumerable), max_uses, use_count, expires_at, active?. A file may have multiple links so old ones can expire while new ones with different options are minted **without re-uploading**.
- **audit_log** — actor (user/api-key/anonymous), action, file/link ref, timestamp, IP, plus `prev_hash` + `entry_hash`. **Append-only and tamper-evident:** the app only ever INSERTs; SQLite triggers reject UPDATE/DELETE on the table; each row stores `entry_hash = SHA-256(prev_hash || row_fields)` forming a hash chain, so any retroactive edit/removal breaks the chain and is detectable. The panel exposes a "verify chain" check.

**Separation of concerns:** a **file** = stored bytes + options; a **link** = a public, randomized, independently-revocable access path to a file.

---

## 4. Encryption Model

All AES-256-GCM. Three per-file modes. **The only difference between server-side and client-side is how the key is transported and where decryption happens** — not who is "allowed" to read.

| Mode | Key transport | Who decrypts | Server stores key? | Server can read |
|---|---|---|---|---|
| **none** | — | — | — | yes (no encryption) |
| **server-side** | `?ek=KEY` (query) | **server**, then streams plaintext | per-file key wrapped at rest by a server master key | yes (it's given the key) |
| **client-side** | `#ek=KEY` (fragment) | **browser** (WebCrypto) | **never** | **no, ever** |

- **Server-side:** file is **encrypted at rest** with a per-file key wrapped by a server master key (a stolen `storage/` dir is useless without the running app's master key). Because the server holds the (wrapped) key, the **master can always preview/manage server-side files** in the panel. The shared **`?ek=` value is the access credential** required to download via a link — the server validates it, then decrypts with its stored per-file key and streams. (Conceptually it's "the key you share"; mechanically the real crypto key stays server-side, which is what lets the master see these files.)
  - **Master key custody:** 32-byte key from `secrets.token_bytes(32)`, stored in the first-run-generated env file with `0600` perms, kept on a separate volume from `storage/`. Per-file key wrapping uses **AES-256-GCM with a random 12-byte IV** (not raw/ECB).
  - **At-rest threat model:** stolen `storage/` alone = useless (goal met). Stolen env file **+** `storage/` = server-side encryption broken — the env file must be protected independently. Client-side files remain safe in all cases (key never on the server).
  - **`?ek=` leakage mitigation (it rides in the query string):** all file-serving and download-page responses set `Referrer-Policy: no-referrer`; Nginx + uvicorn access-log formats for `/file/` must **exclude query strings** (documented deployment requirement). Contrast: the client-side `#ek=` **fragment is never sent to the server, logged, or sent in `Referer`** — which is exactly why it's used for the keys the server must never see.
- **Client-side:** the key is generated **in the browser**, lives only in the `#ek=` you share, and is **never sent to the server** in any header, query, or body. Gated by the `can_upload_client_encrypted` permission (**off by default**) — these files are ones the server/master genuinely cannot read.
- **Chunked AEAD (STREAM-style) framing:** files are encrypted as a sequence of independently-authenticated chunks. This enables O(chunk) memory, resumable uploads, range reads, and progressive video playback of partially-uploaded files. The exact wire format is specified in §4.1 — it is **mandatory**, not implementation-defined, because nonce/ordering/truncation handling is security-critical.

### 4.1 Chunked AEAD wire format (mandatory)

Based on the well-studied **STREAM** construction (Tink / Miscreant), to defeat nonce reuse, chunk reordering, and truncation attacks:

- **Key:** 32-byte AES-256 key. Client-side: generated in-browser via `crypto.getRandomValues`, encoded in `#ek=` as **unpadded base64url**. Server-side: per-file key from `secrets.token_bytes(32)`.
- **File header (stored with ciphertext):** `4-byte magic || 1-byte version || 12-byte base_nonce || 4-byte total_chunk_count (big-endian)`. The `base_nonce` is random per file (`crypto.getRandomValues` / `token_bytes(12)`) and **never reused across files**.
- **Chunk size:** fixed **2 MiB** plaintext per chunk.
- **Per-chunk nonce:** `base_nonce XOR (uint32_be(chunk_index) || last_flag_byte)` (counter occupies the low bytes; final byte = `0x01` for the last chunk, else `0x00`).
- **Per-chunk AAD (authenticated, not encrypted):** `file_uuid || uint32_be(chunk_index) || is_last_byte`. This binds each chunk to its file, position, and finality — so a truncated prefix, a reordered chunk, or a spliced chunk from another upload all **fail authentication**.
- **Per-chunk output:** `ciphertext || 16-byte GCM tag`.
- Decryption (server, browser, or Service Worker) must verify the tag of every chunk, that indices are contiguous from 0, and that exactly one final-flagged chunk closes the stream matching `total_chunk_count`.

---

## 5. Resource Management (memory / disk / cleanup)

### Memory
- **Nothing is ever fully buffered.** Browser-side compression/zip/encryption run in **Web Workers** as `ReadableStream → transform → WritableStream` pipelines; chunks flow through, no whole-file arrays.
- Server streams uploads to disk chunk-by-chunk; downloads stream with **HTTP Range** support; server-side encrypt/decrypt uses the chunked AEAD framing → O(chunk) RAM even for multi-GB files.
- Concurrency caps bound total memory under parallel transfers.

### Disk & quotas
- **Server-authoritative quotas** (client cannot lie — server rejects on both declared size and actual received bytes): defaults **10 GB/file**, **100 GB/user total**. Adjustable via permissions.
- Live **storage accounting** in the DB (`stored_size` per file, summed per user). Uploads that would exceed quota are rejected up front.
- Panel shows disk free + per-user usage.

### Archival (compressed-at-rest)
- Idle files (server-side or unencrypted only — ciphertext won't shrink) are **compressed in place** by the archival job. Codec chosen by content-type (e.g. **zstd** for general/text; **skipped** for already-compressed `jpg/png/mp4/zip/gz`).
- Archived files **must be unarchived (decompressed) before download.**
- Storage accounting credits only the **actual bytes saved** by compression (`stored_size` updated to the compressed size).
- **Unarchive safety:** decompressing *needs* room. Before unarchiving, **pre-check free space + quota** for the decompressed size. If it would overflow user quota or disk, **fail gracefully** with a clear error and leave the archived file intact — including the auto-unarchive-on-download path (returns a clean error, never corrupts state).
- **Decompression-bomb guard:** any server-side decompression (archival unpack, or any case where the server expands a user archive) enforces a **max decompression ratio (50:1)** and a hard decompressed-size cap; exceeding either aborts and flags the file. Note: the **folder-zip-on-upload** feature zips *client-side* and the server treats the result as an opaque blob (no server-side unzip, so no ZipSlip surface); if that ever changes, entries with paths escaping the target dir must be rejected.

### Reclamation jobs (APScheduler)
- **Archive** idle eligible files; **idle-delete** (delete if not downloaded in X days); **temp-storage expiry**; **link expiry**; **GC of abandoned chunked-upload sessions** (temp sessions past a TTL).

### Archive/unarchive job concurrency & memory safety
A single archive or unarchive can take many minutes (e.g. 10 min each on a large file). These must never block request handling, starve each other, or exhaust RAM:
- **Off the event loop:** compression/decompression runs in a **bounded worker pool** (`max_concurrent_archive_jobs`, default **2**, configurable). Codecs that release the GIL (zstd) run in a thread pool; otherwise a process pool. The FastAPI request path is **never** blocked by a job — it `await`s a future or returns "processing."
- **Bounded queue:** jobs beyond the concurrency cap are **queued**, not spawned, so 100 idle files don't launch 100 simultaneous compressions. The scheduler enqueues; the pool drains at a fixed width.
- **Streaming, O(chunk) memory:** both directions stream through fixed-size buffers (e.g. zstd streaming (de)compression) — a multi-GB file uses bounded RAM regardless of size. Total memory is bounded by `pool_width × buffer_size`, a known constant. No whole-file buffering.
- **Per-file locking / dedupe:** a file has a single lifecycle state (`active | archiving | archived | unarchiving`). A second request to unarchive an in-progress file **attaches to the existing job** rather than starting a duplicate; concurrent downloads during `unarchiving` wait on the same future (with a timeout → "processing, try again") instead of each kicking off their own decompress.
- **Early-abort bomb guard:** the decompression-bomb ratio/size cap (above) is checked **incrementally as bytes are produced**, so an archival bomb is aborted mid-stream — never fully expanded into memory or disk first.
- **Crash/restart safety:** in-progress states are persisted; on startup, files stuck mid-`archiving`/`unarchiving` are reconciled (temp output discarded, state reset) so a crash never leaves a half-written or double-counted file.

---

## 6. Authentication, Roles & Permissions

### First-run & auth
- Ships with a default admin (the **master**). **First login forces username + password change.** The default password is **randomly generated at first-run startup and printed to the console** (never hardcoded, never stored); the setup wizard must complete before any other endpoint is served, closing the "attacker reaches first-login before admin" window.
- The **`must_change_credentials` flag gates every authenticated endpoint** — a flagged account can do nothing but change its credentials, regardless of how it obtained a session.
- Optional **TOTP 2FA** (enroll via QR; ±1 step / 30s tolerance; **secret stored encrypted at rest** under the server master key) and **passkeys** (WebAuthn). RP ID/origin are config values; the **RP ID + `Origin` header are validated on every assertion** (not assumed from the library). WebAuthn requires a secure context (HTTPS or localhost) — true for both deployment targets.
- **Password hashing:** `argon2id`, `m=65536` (64 MiB), `t=3`, `p=4`, 16-byte salt, 32-byte hash.
- **Brute-force lockout:** 5 failed attempts → 15-minute lockout **per username**, plus per-IP tracking to blunt distributed attempts; every failed attempt logged to `audit_log` with IP.
- **Session cookies:** `HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=86400`, signed. (`Secure` is dropped only in local HTTP dev mode and required in prod.)
- **CSRF protection:** all state-changing requests (panel actions, user/permission management, link mint/expire, settings) require a **per-session CSRF token** submitted via a custom request header (`X-CSRF-Token`), validated server-side (double-submit pattern), layered on top of `SameSite=Strict`. Endpoints reject any cookie-authenticated mutating request lacking a valid token. API-key and Tus upload requests authenticate via the `Authorization` header (not the session cookie), so they are not cross-site-forgeable and are exempt. Safe methods (GET/HEAD) are never state-changing.

### Roles
- **master** — manages users, permissions, and **all** files; sees all files split into **per-user sections** plus its own section.
- **user** — can upload (if permitted) and manages **their own** files only.

### Permissions (tiered UI: Essentials vs Advanced)
- **Essentials:** `can_upload`, `can_upload_client_encrypted` (**off by default**), storage quota.
- **Advanced:** max file size, allowed retention ranges, can-delete, can-regenerate-links, `can_use_api_keys`, `can_use_p2p`, archive defaults.
- All quota/size defaults in §5 are per-user permission overrides.

### API keys (per-IP, for curl uploads)
- Gated by `can_use_api_keys`. Secure random key shown once.
- **Binds to the first IP that uses it**; requests from any other IP are rejected (can't be shared after first use). **Client IP is derived safely:** the app trusts exactly **one** proxy hop (`X-Forwarded-For` rightmost entry, via Starlette `ProxyHeadersMiddleware` with `trusted_proxy_count=1`) and **binds only to `127.0.0.1`** so Nginx is the only path in — otherwise a client could spoof `X-Forwarded-For` to bind/bypass the key.
- **Reset-IP action:** the key's owner (and the master) gets a **"Reset/regenerate IP" button** in the panel that clears `bound_ip` back to NULL, so the next request re-binds it. Covers **dynamic IPs** without forcing a full key reissue. Because it's security-sensitive, the reset **requires re-authentication** (password or 2FA confirmation) and is recorded in the audit log.
- Stored hashed. Used for `curl`-based uploads (and downloads where applicable).

---

## 7. Upload Flow (Phase 1)

Logged-in user → **upload page**: an Uppy drag-drop zone supporting **single files, batches, and folders**, each with a per-item options panel **plus an "apply to all"** batch-defaults panel.

### Per-file options
- **Encryption:** none / server-side (`?ek`) / client-side (`#ek`, only if permitted).
- **Compression:** on/off — shows a **warning** when combined with encryption ("ciphertext won't shrink; this wastes space").
- **Folder handling:** zip whole folder into one archive **or** upload each file individually.
- **Filename:** keep original / randomize what the download presents (internal stored name is always random regardless).
- **Storage:** permanent / temporary (delete after X).
- **Archive after** N idle days (default 5, configurable) + **auto-unarchive-on-download** toggle (else master unarchives manually).
- **Delete if not downloaded in X days** toggle.
- **Max link uses** (download count cap).

### Pipeline
- Client-side mode: **encrypt/compress/zip happen in Web Workers per-chunk** (streaming pipeline). The client-side key is **never** sent to the server.
- Server-side mode: chunks flagged for server encryption; server encrypts at rest.
- Chunks upload via **Tus, in parallel, with resume** (interrupted uploads continue, never restart).
- **Silent token refresh:** Uppy's Tus header-provider injects a fresh token per chunk request; on 401 mid-upload the session refreshes and the **active chunk queue continues uninterrupted**.
- On completion: user gets the **link(s)** + key (if any) + **QR code** + **copy-raw button** (with **PowerShell** and **openssl/bash** decrypt snippets for client-side files).

---

## 8. Download Flow (Phase 1)

- **`/file/<id>`** → **UI download page**: filename, size, type, in-browser **preview** (image/text/PDF/video — decrypting first where applicable), **Download** button, **Copy raw link** button.
  - Encrypted + key in URL → ready immediately.
  - Encrypted + **no key** → page **prompts for the key** (then decrypts client-side for `#ek`, or submits to server for `?ek`).
  - Unencrypted → straight to download (link alone suffices).
- **`/file/<id>/raw`** → raw bytes for curl (same ID, just a suffix).
  - Server-side: `?ek=` makes the server decrypt + stream plaintext.
  - Client-side: streams ciphertext; the copy button provides the cross-platform decrypt command.
- **HTTP Range** support for fast/resumable downloads. `max_uses` is enforced **atomically** (`UPDATE links SET use_count = use_count + 1 WHERE id = ? AND use_count < max_uses` checked by rowcount — no read-modify-write race); expired/used-up/inactive links return 404.
- Archived files are **unarchived first** (per §5 safety rules) before streaming.

### Preview hardening (download page is an XSS surface)
- All file-serving responses set **`X-Content-Type-Options: nosniff`**; the download page sets a **CSP** (`default-src 'self'; script-src 'self'; object-src 'none'`) and `Referrer-Policy: no-referrer`.
- **HTML/SVG are never rendered inline** — offered as download-only. **PDF/video** previews render in a **sandboxed `<iframe>`** (no `allow-scripts` where avoidable; ideally served from a separate origin/subdomain). **Text** previews render via escaped `<pre>` (never `innerHTML`). Image previews via `<img>` only.

---

## 9. Admin Panel (Phase 1)

- **Regular user:** sees **their own files** — table with edit, expire/regenerate links (with new options), preview, delete, usage stats.
- **Master:** sees **all files split into per-user sections** + own section; full management; **user management** (add/remove, reset creds); **tiered permissions editor** per user (§6).
- **Audit log** view (uploads/downloads/link access with timestamp + IP) and **disk usage** dashboard.

---

## 10. UI / Aesthetic

Dark, minimal, function-first. Hand-rolled CSS, one accent color, generous spacing, clear typography, no heavy framework. Surfaces: **Login / first-run setup**, **Upload**, **Manage/Admin panel**, public **Download page**, and (Phase 3) a separate **P2P** tab. Snappy, keyboard-friendly, responsive for phone downloads.

---

## 11. Phase 2 — Progressive Video Streaming (upload-while-streaming)

- On uploading a video, a **"Stream now" button appears immediately** with a link.
- A **Service Worker** intercepts `/file/<id>` (and `/file/<id>/raw`), pulls **completed chunks** as they arrive, **decrypts in-worker** (using the chunked AEAD framing — each finished chunk is independently decryptable), and feeds **MediaSource** for playback **while upload continues**.
- Both **UI wrapper** and **raw** stream variants are supported.
- When upload completes, the **same URL seamlessly becomes a normal file link with no URL change** — the Service Worker simply exits "live" mode.
- Encryption handled for all three modes in the streaming path (client-side decrypt in the SW for `#ek`; server decrypt for `?ek`; passthrough for none).
- **Security:** the Service Worker is registered with a **narrow scope (`/file/`)** so it never intercepts login/admin/auth flows. The `#ek=` key it holds to decrypt chunks stays **in memory only** — never persisted to Cache Storage or IndexedDB.

*(Interface-level here; detailed design happens in the Phase 2 plan.)*

---

## 12. Phase 3 — P2P Tab

- A **separate tab** for **WebRTC** peer-to-peer streaming/transfer. **No server-stored file, no size limit.**
- The server is the **signaling middleman** (WebSocket) and an **optional relay** (TURN) when a direct peer connection can't be established.
- Transit is **DTLS-encrypted by WebRTC** itself (no app-layer crypto needed on top).
- Gated by the `can_use_p2p` permission.
- **Security notes:** WebRTC ICE can reveal a peer's local/public IP to the other peer even with a relay — surface this in the P2P UI. A self-hosted **TURN relay (coturn) must use short-lived HMAC time-limited credentials**, never static username/password (which would be extractable from the browser's offer/answer).

*(Interface-level here; detailed design happens in the Phase 3 plan.)*

---

## 13. Non-Goals / Deferred

- Multi-tenant org structure beyond master + users.
- Mobile native apps.
- External object storage (S3, etc.) — local filesystem only for now.
- Detailed Phase 2/3 internals — captured at interface level, designed in their own plans.

---

## 14. Key Risks / Things to Get Right

1. **Client-side key isolation** — must be provably never sent to the server (test-asserted).
2. **Streaming memory discipline** — Web Workers + chunked pipelines on the client; chunked AEAD + Range on the server.
3. **Resumable uploads with mid-flight token refresh** — no queue restart on token expiry.
4. **Unarchive-out-of-space handling** — pre-check and fail gracefully, never corrupt.
5. **Quota enforcement is server-authoritative** — the client cannot lie about size.
6. **Per-IP API key binding** — first-use locks the IP.
7. **Progressive video seamless transition** — same URL, live → static, no reload.
