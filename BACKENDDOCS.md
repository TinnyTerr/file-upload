# BACKENDDOCS.md — Frontend Rebuild Reference

A page-by-page, feature-by-feature spec of everything the frontend must do, and exactly how the backend behaves behind it. This is a "here's how the backend works" guide so you can rebuild the UI from scratch with no design assumptions. **No styling, no layout — only what each page needs to *do* and which endpoints it talks to.**

The app is **Oxymoron**, a private file-upload/sharing tool. Backend is FastAPI + SQLAlchemy; the current frontend is a React SPA served from a built bundle. The backend serves the SPA shell HTML for a fixed set of routes and exposes a JSON/multipart API for everything else.

---

## 1. Global concepts (read this first)

### 1.1 Authentication model
- **Session cookie + CSRF token.** Login sets an HttpOnly session cookie (`fu_session`, name not needed client-side — it's automatic). The login response *also* returns a `csrf_token` string. The frontend must store that token and send it back on every mutating request.
- **CSRF header.** On every non-GET/HEAD request, send header `X-CSRF-Token: <token>`. The backend rejects mutating requests without a valid matching token (403).
- **Persistence.** Current app stores `csrf_token` and a cached user object in `localStorage` (keys `fu_csrf`, `fu_user`). "Logged in" is simply "a CSRF token exists." You may use cookies/memory instead, but the CSRF token must survive reloads since the cookie is HttpOnly and unreadable.
- **Credentials mode.** All API calls use `credentials: "same-origin"` so the session cookie rides along.
- **API keys (separate auth path).** For programmatic upload only. Sent as `Authorization: Bearer <key>`. Used by external integrations, not the SPA itself (the SPA uses the session). Only `/files/upload*` accept Bearer auth.

### 1.2 The "must change credentials" flow
- A freshly bootstrapped/created account may have `must_change_credentials = true`.
- `POST /auth/login` returns `must_change_credentials` in its body. If true, the user **must** be routed to the credential-change page and cannot use the rest of the app — protected endpoints return **403 "must change credentials"** until they change it.

### 1.3 Permissions
Every user has a granular permission set. The frontend should fetch it (`GET /account/me`) and show/hide features accordingly, but the backend always re-checks — hiding a button is convenience, not security. Permission keys (all boolean unless noted):

| Key | Gates |
|---|---|
| `can_upload` | uploading at all |
| `can_upload_client_encrypted` | end-to-end (client) encryption mode |
| `can_delete` | deleting own files |
| `can_regenerate_links` | minting/editing share links |
| `can_delete_links` | deleting share links |
| `can_create_directories` | creating shared folders |
| `can_manage_lifecycle` | per-file lifecycle options (temp/idle/archive) |
| `can_use_api_keys` | creating/using personal API keys |
| `can_use_p2p` | peer-to-peer (defined but not wired to a feature) |
| `can_view_admin` | viewing admin dashboard |
| `can_manage_users` | user management |
| `can_manage_storage` | storage cap / bulk storage ops |
| `can_manage_api_keys` | admin-level API key ops |
| `quota_bytes` (int) | per-user storage quota |
| `max_file_bytes` (int) | per-file size limit |

A **`master`** role user implicitly has every boolean permission true. Master is the admin role. There must always be at least one master (backend refuses to delete/demote the last one).

### 1.3a Roles
- `role` is `"master"` or `"user"`.
- `master` = admin: can access `/admin`, manage users, see all files, run lifecycle/bulk jobs, act on any user's resources.
- `user` = regular: only sees/acts on their own resources.

### 1.4 Encryption modes (critical — appears everywhere)
Three modes, chosen per file or once per folder:

| Mode | Where key lives | How frontend handles it |
|---|---|---|
| `none` | nowhere (link is the only secret) | nothing special |
| `server` | server holds the real key; downloader presents an **access credential** as `?ek=<access_key>` query param | server returns `access_key` on upload; frontend appends `?ek=` to share URLs. Recoverable later from file metadata. |
| `client` | end-to-end; key generated in browser, never sent to server, transported in the URL **fragment** `#ek=<base64url key>` | frontend encrypts before upload, gets back the key bytes, builds URL with `#ek=`. **Unrecoverable if lost** — must be surfaced to the user at creation time. |

Key transport rules (must be exact):
- **`#ek=` (fragment)** is for client mode. Fragments are never sent in HTTP requests → the server never sees the key. The browser reads it from `window.location.hash`.
- **`?ek=` (query)** is for server mode. It *is* sent to the server, which uses it as the gate.
- Key encoding: client keys are **32 raw bytes** encoded as **base64url (no padding)**. The frontend must validate length === 32 after decoding.

### 1.5 Client-side encryption format (FUPL v1) — needed for client mode
Client-encrypted files are encrypted **in the browser** (use a Web Worker to keep the main thread free) and uploaded as ciphertext. Download reverses it in the browser. The wire format must match the server byte-for-byte so server-zipped bundles and cross-tooling work. **FUPL v1** spec:

- Algorithm: **AES-256-GCM**, chunked.
- Plaintext chunk size: **2 MiB**.
- Header (21 bytes): `b"FUPL"` (4) + version `0x01` (1) + `base_nonce` (12 random bytes) + `total_chunk_count` as uint32 big-endian (4).
- Per chunk on the wire: `ciphertext || 16-byte GCM tag`.
- Per-chunk nonce: `base_nonce XOR (0x00×7 || uint32_be(idx) || flag_byte)`.
- Per-chunk AAD (21 bytes): `0x00×16 || uint32_be(idx) || flag_byte`.
- `flag_byte` = `0x01` for the last chunk, `0x00` otherwise.
- Empty input still produces exactly one (empty) chunk.
- Non-last encrypted chunks are exactly `2 MiB + 16` bytes; last chunk is the remainder.

A reference worker implementation exists at `client/src/workers/aead-worker.js` — reuse it verbatim. It speaks a simple `postMessage` protocol: `{type:"encrypt", plaintext:ArrayBuffer, key:Uint8Array|null}` → `{type:"encrypted", ciphertext, keyBytes}`; `{type:"decrypt", ciphertext, key}` → `{type:"decrypted", plaintext}`; both emit `{type:"progress", percent}`.

### 1.6 Client-side ZIP (needed for end-to-end folder download)
Client-encrypted **folders** can't be zipped server-side (server has no key). The frontend must decrypt each member in the browser and build a ZIP locally. Use a **store-only (no compression) ZIP writer** (reference: `client/src/lib/zip.ts`) — input is `[{name, data:Uint8Array}]`, output is a `Blob`.

### 1.7 Standard error shape
All errors are HTTP status + JSON body `{ "detail": "<message>" }` (occasionally `detail` is an object, e.g. chunked-upload "incomplete" returns `{detail: {error, missing:[...]}}`). The frontend should read `detail` for user-facing messages. Common codes:
- `400` malformed request / bad enum / missing field
- `401` not authenticated, bad credentials, missing/invalid `?ek=` on encrypted download, invalid API key
- `403` authenticated but not permitted (wrong owner, missing permission, bad CSRF, must-change-credentials)
- `404` unknown slug, or a link that expired / used-up / deactivated (deliberately indistinguishable from "never existed")
- `409` conflict (username taken, chunked upload incomplete)
- `410` gone (dropbox link used/expired, chunk session expired)
- `413` too large (over max file size or quota)
- `429` rate-limited (login lockout, API key creation cap)
- `507` insufficient disk space (unarchive)

### 1.8 Helper utilities the UI needs
- **Byte formatting**: human-readable (`B/KB/MB/GB`).
- **Size parsing**: parse user input like `"10GB"`, `"500 MB"`, `"2.5tb"` → bytes (used for quotas/caps).
- **Duration parsing**: parse `"30s"`, `"5m"`, `"24h"`, `"7d"`, `"2w"`, or plain integer seconds → seconds (used for link/folder expiry).
- **Date formatting**: ISO 8601 strings come back from the API; render with locale formatting.

---

## 2. Routing map

The backend serves the SPA shell HTML (so deep links work) for exactly these paths; the client router renders the matching page:

| Path | Page | Auth |
|---|---|---|
| `/` | redirect → `/files` if logged in, else `/login` | — |
| `/login` | Login | public |
| `/account/change` | Change credentials | logged in (used in must-change flow) |
| `/files` | Files (main app) | requires auth |
| `/admin` | Admin dashboard | requires master |
| `/api-docs` | API documentation | public (shown with app nav) |
| `/file/{slug}` | Public file download page | public |
| `/d/{slug}` | Public shared-folder page | public |

Notes:
- `/file/{slug}` and `/d/{slug}` are served by their own backend routes that inject **server-rendered Open Graph / Twitter meta tags** into the shell (for link unfurlers that don't run JS). The client still renders the real page.
- Any unknown path → redirect to `/`.
- Nav links (authed app): **Files** (`/files`), **API** (`/api-docs`), **Admin** (`/admin`, master only).

---

## 3. Page: Login (`/login`)

**Purpose:** authenticate; entry point of the app.

**Logic:**
1. On mount, if already logged in (CSRF token present), redirect to `/files`.
2. Form: `username`, `password`. On submit:
   - `POST /auth/login` with JSON `{username, password}` (no CSRF needed — this *establishes* the session). Uses `credentials: same-origin`.
   - Success → response `{ csrf_token, must_change_credentials }`. Store the CSRF token. Then fetch the user profile (`GET /account/me`) and cache it (unless must-change).
   - Route: if `must_change_credentials` → `/account/change`; else → `/files`.
3. Error handling by status:
   - `401` → "Invalid username or password."
   - `429` → "Too many attempts — try again later." (account/IP lockout — see below)
   - other → show `detail`, or a generic network error.

**Backend behavior:**
- `POST /auth/login` — body `{username, password}`.
  - Lockout: after **5 failed attempts** (per username *and* per IP) the account/IP is locked for **15 minutes** → returns `429`.
  - On success resets lockout counters, creates a session, sets the cookie, returns `{csrf_token, must_change_credentials}`.
- Bootstrap: on first run the backend auto-creates a master account (username `admin`) with a generated password printed to server logs, flagged `must_change_credentials`.

---

## 4. Page: Change Credentials (`/account/change`)

**Purpose:** set a new username + password. Required on first login of a bootstrapped/new account; also reachable voluntarily.

**Logic:**
1. Form fields: current password, new username, new password, confirm password.
2. Client validation: new password ≥ 12 chars, confirm matches.
3. Submit → `POST /account/change-credentials` (CSRF required) JSON `{current_password, new_username, new_password}`.
4. On success, route to `/files` (and refresh cached user — `must_change_credentials` is now false).
5. Error handling: `401` wrong current password; `409` username taken; `400` password too short.

**Backend behavior:**
- Requires a valid session + CSRF.
- Validates new password length (≥12), verifies current password, checks username uniqueness.
- Sets new credentials, clears `must_change_credentials`, and **revokes all the user's other sessions** (keeps the current one). So after this, other devices are logged out.

---

## 5. Page: Files (`/files`) — the main app page

This is the largest page. It combines: storage usage, an upload "dispatch" panel with 4 modes, the user's files & folders list, and (optionally) a personal API-keys section. Requires auth.

### 5.0 On load
- `GET /account/me` → permissions + identity (drives which controls render).
- `GET /files/usage` → `{used_bytes, quota_bytes, max_file_bytes}` for the storage meter.
- `GET /files/` → the user's loose (non-folder) files.
- `GET /directories/` → the user's folders (owned + ones they collaborate on).

### 5.1 Storage usage meter
- Shows `used_bytes / quota_bytes` from `/files/usage` (or `/account/me`).
- Visual fill %, with warning thresholds (e.g. ≥70% warn, ≥90% danger) — purely informational.

### 5.2 Upload "Dispatch" panel — 4 modes
A mode switcher: **Files**, **Folder**, **Remote**, **Receive**.

#### Shared upload options (Files & Folder modes)
- **Max downloads** (`max_uses`, int ≥1, blank = unlimited)
- **Expires in** (duration string → `expires_in_seconds`)
- **Encryption**: `none` / `server` / `client` (client option only if `can_upload_client_encrypted`)
- **Random name** toggle (`randomize_filename`) — server stores a random filename shown to downloaders. Ignored when uploading into a folder.
- **Compress** toggle (`compress`) — zstd compress before storing (server skips already-compressed types). Ignored for client mode (ciphertext won't shrink).
- **Advanced lifecycle** (only meaningful with `can_manage_lifecycle`, else backend 403s):
  - Delete after N days (`temp_days`) — makes the file temporary
  - Archive if idle N days (`archive_after_idle_days`)
  - Delete if idle N days (`delete_if_idle_days`)

#### Mode: Files
- Drag-drop or pick multiple files → a client-side queue (each item: id, file, status `queued|uploading|done|error`, progress %, result, error).
- "Upload" button uploads each queued item sequentially, updating per-item progress and an overall progress label.
- Each file: optionally client-encrypt first (browser worker), then upload (see upload mechanics §5.2.1).
- On success of a standalone file, pop a **share success modal** (see §5.5).
- After batch: toast counts, refresh files + usage.

#### Mode: Folder
- Pick a folder (uses `webkitdirectory`); each file's `webkitRelativePath` becomes its filename.
- Flow: **create a directory first**, then upload every file into it with `directory_id`.
  - `POST /directories` with `{title, encryption_mode, expires_in_seconds?}`. Title defaults to the top-level folder name from the relative path.
  - If `encryption_mode === "client"`, generate **one shared 32-byte key** in the browser and encrypt every member with it (so one `#ek=` unlocks the whole bundle).
- After all members upload, pop a **folder share success modal** with the folder URL (+ key).
- Note: when uploading into a folder the backend overrides per-file settings — folder's encryption wins, compression off, files are permanent, no per-file randomize.

#### Mode: Remote
- Inputs: remote URL, optional filename.
- `POST /files/remote-upload` (CSRF) JSON `{url, original_filename?}` → server fetches the URL and stores it.
- Show a busy/"Fetching from server…" state; on success pop the share modal (always `none` encryption).
- Backend: validates the URL is **public http/https** (blocks private/loopback/link-local/reserved IPs — SSRF protection), follows up to 6 redirects (re-validating each hop), enforces `max_file_bytes` and quota. Returns the same shape as a normal upload plus `{job_id, status, file_id}`.

#### Mode: Receive ("dropbox" link)
- Lets the user create a **one-time inbound upload link** to receive a file from someone else.
- Input: expiry duration (default `"1h"`, backend min 60s, max 30 days).
- `POST /dropbox-links` (CSRF) JSON `{expires_in_seconds, target_directory_id?}` → returns `{url, upload_url, token, expires_at, ...}`. Show the URL with a copy button.
- The link disables after the first successful upload.

##### Backend dropbox endpoints (the receiver's page — note: the current SPA does **not** render a dedicated public uploader page; you may want to build one)
- `GET /dropbox/{token}` → `{status:"active", target_directory_id, expires_at}` or 404/410.
- `POST /dropbox/{token}/upload` → multipart `file` + `original_filename`. No auth (the token is the credential). Stores the file under the link owner's account/quota. 410 if used/expired.

#### 5.2.1 Upload mechanics (single vs chunked)
The frontend picks the path by file size:
- **Single-shot** (< ~80 MiB): `POST /files/upload` as **multipart form** with fields:
  - `file` (the bytes — the ciphertext blob if client-encrypted), `original_filename` (required), plus any of: `max_uses`, `expires_in_seconds`, `encryption_mode`, `compress`, `is_permanent`, `temp_days`, `delete_if_idle_days`, `archive_after_idle_days`, `auto_unarchive_on_download`, `randomize_filename`, `directory_id`.
  - Use `XMLHttpRequest` (not fetch) to get real upload progress events. Send `X-CSRF-Token` header.
- **Chunked/resumable** (≥ ~80 MiB; exists to dodge Cloudflare's ~100 MB edge body cap): 3-step flow, all JSON except the chunk body:
  1. `POST /files/upload/init` JSON `{original_filename, total_size, content_type, ...same option fields...}` → `{upload_id, chunk_size, num_chunks, received:[]}`. `upload_id` is an opaque sealed token (carries all session state — no DB row).
  2. `POST /files/upload/chunk?upload_id=...&index=N` with body = raw chunk bytes (`Content-Type: application/octet-stream`). Upload missing chunks, ideally **2 in parallel**, with retries (4×, backoff) and a per-chunk timeout. Each returns `{index, num_chunks}`.
  3. `POST /files/upload/finalize` JSON `{upload_id}` → assembles + returns the normal upload result. `409` with `{detail:{missing:[...]}}` if chunks are still missing.
  - **Resume**: persist `{upload_id, total, chunk_size}` keyed by file identity (name+size+lastModified+enc+dir) in localStorage. On retry, `GET /files/upload/status?upload_id=...` → `{received:[...]}` to skip already-uploaded chunks. Drop the saved session on success. Resume is disabled for client mode (ciphertext is re-randomized each attempt).
  - **Abort**: `DELETE /files/upload?upload_id=...` discards a partial.
  - Compute overall % from bytes done / total.

#### 5.2.2 Upload result shape (all upload paths return this)
```
{
  file_id, slug,
  url,            // e.g. https://host/file/<slug>
  raw_url,        // url + "/raw"
  access_key,     // server mode only: the ?ek= value; null otherwise
  encryption_mode,
  max_uses, expires_at, compressed,
  source_type,    // "upload" | "saved" | "remote" | "dropbox"
  saved_from_file_id
}
```
The frontend builds the **full shareable URL**:
- client mode: `url + "#ek=" + base64url(keyBytes)`
- server mode: `url + "?ek=" + encodeURIComponent(access_key)`
- none: `url`

### 5.3 Files & folders list
Renders folders first, then loose files.

**Each loose file** (from `GET /files/`) shows: filename, size, created date, encryption badge (server/e2e), compressed ("zst") badge, link count, and per-file actions:
- **+ Link** (if `can_regenerate_links`) → opens "Create a new link" modal (max downloads + expires in) → `POST /files/{file_id}/links` JSON `{max_uses?, expires_in_seconds?}`. Returns `{slug, url, raw_url, encryption_mode, access_key}`. Build the full URL (append `?ek=` for server mode; for client mode tell the user to append their `#ek=` since the key isn't recoverable), copy to clipboard.
- **Delete** (if `can_delete`) → confirm dialog → `DELETE /files/{id}`.
- **Expandable link list** per file. Each link row shows: the full URL (with `?ek=` for server mode; "needs #ek=" badge for client mode), use count (`use_count/max_uses`), expiry date, and status (active / inactive / expired / used up). Actions per link:
  - Copy URL, Copy as Markdown `[name](url)`, Open in new tab.
  - **Deactivate / Reactivate** (if `can_regenerate_links`) → `PATCH /links/{id}` JSON `{active}`.
  - **Delete** (if `can_delete_links`) → confirm → `DELETE /links/{id}`.
  - Link "dead" states are derived client-side: inactive if `!active`, or `expires_at` past, or `use_count >= max_uses`.

**Each folder** (from `GET /directories/`) shows: title, file count, total bytes, encryption badge, and a **lazily loaded member list** via `GET /directories/{id}/files` → `[{id, slug, filename, size_bytes, content_type, encryption_mode, created_at}]`. Folder actions:
- **Add files** (if `can_create_directories`): pick files and upload them into the folder (`directory_id`). For client-mode folders, prompt for the folder's `#ek=` key and reuse it to encrypt each added file. → `DELETE /directories/{dirId}/files/{fileId}` removes a member.
- **Open** the public folder URL / **Copy** it (build from `url`/`slug`, `?ek=` for server mode).
- **Delete all** (if `can_delete`) → confirm → `DELETE /directories/{id}` (removes folder + all members).
- **Remove** a single member (if `can_delete`) → `DELETE /directories/{dirId}/files/{fileId}`.

There's also a **"New folder"** button (if `can_create_directories`) → modal (title, encryption, expires in) → `POST /directories` → pop the folder share success modal.

**Directory list item shape** (`GET /directories/`):
```
{ id, owner_id, slug, title, url, encryption_mode, access_key,
  file_count, total_bytes, expires_at, created_at, role }
```
`role` is `"owner"` | `"editor"` | `null` (collaborator role for the current user).

### 5.4 API keys section (only if `can_use_api_keys`)
- `GET /keys/` → `[{id, user_key_number, bound_ip, active, created_at, last_used_at}]`.
- **+ New key** → `POST /keys/` → `{id, user_key_number, key}`. **The raw `key` is shown exactly once** — display it in a modal with a strong "copy now, won't be shown again" warning + copy button.
- Per key: **Reset IP** → modal asking for the user's password → `POST /keys/{id}/reset-ip` JSON `{password}` (clears the IP binding). **Revoke** → `DELETE /keys/{id}` (deactivates; keys are never hard-deleted).
- Backend cap: **max 20 active keys per user** → `POST /keys/` returns `429` when exceeded.
- API keys **bind to the first IP** that uses them; later use from another IP is rejected (403) until reset. (Shown as a "📍 IP" or "unbound" badge.)

### 5.5 Share success modal (reused for files and folders)
After a successful upload/folder share, show a modal with:
- One or more URL rows. For an encrypted file, show: **Full** URL (with key), **No key** URL (base, no key), and the **Key** alone.
- Each row: Copy, Copy-as-Markdown, Copy-as-HTML, Open buttons.
- A QR code of the full share URL.
- A **warning hint** depending on mode:
  - client: "⚠ End-to-end encrypted. The key (#ek=) is in this URL only — save it. It cannot be recovered from the server."
  - server: "🔐 Server-side encrypted. The access key (?ek=) is required to download — share the full URL."

---

## 6. Page: Public File Download (`/file/{slug}`)

**Purpose:** anonymous (or logged-in) download of a single shared file. Public — no auth. The link *is* the credential.

**On load:**
1. Read `#ek=` from `window.location.hash` (client key) and `?ek=` from query (server key).
2. `GET /file/{slug}/info` → metadata (no download consumed):
   ```
   { filename, size_bytes, content_type, encryption_mode, compressed,
     archived, lifecycle_state, max_uses, use_count, expires_at, hashes }
   ```
   `hashes` is a map like `{sha256: "...", ...}`. On 404 → "Link not found / expired" state.

**UI/logic:**
- Hero: file icon (by content type), filename, size, type, and "N downloads remaining" if `max_uses` set.
- **Encryption banner** when not `none`:
  - client + have key → "decrypts locally, server never sees it"; client + no key → "missing #ek=, need full link."
  - server + have key → "the ?ek= unlocks it"; server + no key → "missing ?ek=, blocked."
- **Download button** behavior by mode:
  - `none` → navigate to `/file/{slug}/raw` (browser downloads).
  - `server` + have `?ek=` → navigate to `/file/{slug}/raw?ek=<key>`. If no key, prompt the user to paste the access key, then navigate.
  - `client` + have `#ek=` → fetch ciphertext (`GET /file/{slug}/raw`), decrypt in the browser worker with the 32-byte key (show "Decrypting… N%"), then save the resulting blob with the original filename. If no key, prompt for it first.
  - If the link is exhausted (`max_uses` reached) → disable, "Link exhausted."
- **Inline preview** (only for `encryption_mode === "none"` AND not a limited-use link): images, video, audio, PDF (in a sandboxed iframe), and text (fetched + truncated at 64 KB). **Never render HTML or SVG inline (XSS).** Preview source is `/file/{slug}/preview` (a separate endpoint that doesn't consume a use; only works for plain unencrypted files and non-limited links). Limited-use links show "preview unavailable — download to view."
- **Share & copy** section: Share URL (rebuilt with the key the page has), Raw URL, a ready `curl -L -O "..."` command, copy-Markdown / copy-HTML / open-in-new-tab buttons, and a hash display with a selector to switch between hash algorithms.
- **Save to my files** button (only if logged in): `POST /files/{slug}/save` (CSRF) — copies the shared file into the current user's storage (dedup via shared blob; subject to quota). Returns a new file_id/slug.

**Backend download semantics (`GET /file/{slug}/raw`):**
- Resolves the active link; 404 if missing/expired/used-up/inactive.
- Server mode: requires valid `?ek=` **before** consuming a use (a wrong key never burns a limited-use download) → 401 if missing/wrong.
- Consumes one use (increments `use_count`), records the download, sets security headers + RFC-6266 `Content-Disposition`.
- Decrypts (server mode) and/or decompresses (compressed/archived) transparently and streams the result.
- **Range requests** (HTTP `Range`, 206 responses) are supported **only** for plain, uncompressed, unencrypted files (enables video seeking). Archived files where `auto_unarchive_on_download` is false return 503 "contact admin to unarchive."

---

## 7. Page: Public Shared Folder (`/d/{slug}`)

**Purpose:** anonymous browse + download of a shared folder bundle. Public.

**On load:**
1. Read `#ek=`/`?ek=` like the file page.
2. `GET /d/{slug}/info` → `{title, encryption_mode, file_count, total_bytes, files:[{slug, filename, size_bytes, content_type}]}`. 404 if missing/expired.
3. `GET /d/{slug}/preview-manifest` (best-effort) → files grouped into `{images, videos, audio, text, pdfs, archives, other}`, each entry with `{id, slug, filename, size_bytes, content_type, encryption_mode, preview_url, download_url}` and, for ZIP archives, a `preview` summary (`{status, entries[], entry_count}`).

**UI/logic:**
- Header: title, file count, total size, encryption label.
- **Download all (.zip)** button:
  - For `none`/`server` mode → navigate to `/d/{slug}/zip` (append `?ek=` for server mode). Server streams a ZIP.
  - For `client` mode → **must be done in the browser**: prompt for the folder `#ek=` key if absent, fetch each member's ciphertext (`GET /file/{memberSlug}/raw`), decrypt with the shared key, build a ZIP client-side (store-only), and save. Show progress ("Decrypting i / N — filename", then "Packaging .zip…").
- **Per-file download**: same per-mode logic as the single-file page (navigate for none/server; fetch+decrypt+save for client).
- **Encryption banner** (same wording pattern as the file page; "unlocks the whole folder").
- **Previews toggle**: when a manifest exists, show grouped tiles (image/video thumbnails only for `none` mode; archive entry counts; icons otherwise) with Download/Open per file. Toggle to a plain numbered list.
- **Save to my files** (if logged in): `POST /d/{slug}/save` (CSRF) → copies the whole folder into the user's storage (dedup; quota-checked).
- A per-member "Open" goes to that member's own `/file/{memberSlug}` page.

**Backend zip semantics (`GET /d/{slug}/zip`):** rejects client-mode folders (400 — no key server-side); requires `?ek=` for server mode; streams a store-only ZIP, decrypting/decompressing members as needed; de-duplicates colliding filenames.

---

## 8. Page: API Docs (`/api-docs`)

**Purpose:** static reference documentation for the public/programmatic API. Shown within the app nav; public.

**Logic (mostly static content):**
- Sidebar sections with scroll-spy: Overview, Authentication, Upload a file, Download, File metadata, Folders, Encryption, Errors.
- All examples are wired to the current origin (`location.origin`) so users can copy-paste runnable `curl`. Copy buttons on code blocks.
- Documents: Bearer-key auth (created in-app, IP-bound), `POST /files/upload` (multipart fields table), `GET /file/{slug}/raw` (incl. `?ek=` and Range), `GET /file/{slug}/info`, folder create/list/zip/delete, the three encryption modes, and the error code table.
- No data fetching required — it's a content page. (Content can be lifted from the existing `ApiDocsPage`.)

---

## 9. Page: Admin Dashboard (`/admin`)

**Purpose:** master-only administration. Requires `role === "master"` (route guard); all endpoints re-check master server-side.

**On load:** `GET /files/disk-stats` → top counters `{total_files, total_bytes, total_users, total_links}` for the header stat cards.

Tabbed interface: **Users**, **Overview**, **Files**, **Audit log**, **Backend**, **API keys**, **Danger zone**. A shared "refresh version" bus re-fetches tabs after mutations. A cross-tab **selection** state (sets of file IDs, directory IDs, key IDs) is shared between the Files tab (where you check rows) and the Danger zone (where bulk actions consume the selection).

### 9.1 Users tab
- `GET /users/` → `[{id, username, role, must_change_credentials, created_at, permissions:{...all perm keys + quota_bytes + max_file_bytes}}]`.
- Also loads `GET /admin/files` + `GET /admin/directories` to compute per-user file counts and storage used (display only).
- Filter box (client-side over username/role/id).
- **+ New user** modal: username, password (≥12), role (user/master), "can upload" toggle → `POST /users/` JSON `{username, password, role, can_upload, ...optional perm fields...}`. `409` = username taken.
- Per user row: permission badges, file count, storage used/quota bar, created date, and actions:
  - **Edit** modal: username, optional new password (≥12), role → `PATCH /users/{id}` JSON `{username?, password?, role?}`. (Setting a password revokes that user's sessions. Can't demote the last master.)
  - **Permissions** modal: toggles for every boolean permission + quota + max-file-size (size strings parsed to bytes) → `POST /users/{id}/permissions` JSON `{...flags..., quota_bytes?, max_file_bytes?}`. Backend rejects a quota below the user's current usage, or that would push total allocated quota over the global cap.
  - **Delete** → confirm → `DELETE /users/{id}` (removes the user + all their files/folders/keys/links/sessions and unlinks their bytes). Can't delete yourself or the last master.

### 9.2 Overview tab (storage + analytics)
- `GET /admin/storage` → a big object:
  - `global_storage_quota_bytes`, `used_bytes`, `allocated_quota_bytes`, `storage_summary{used_percent, allocated_percent, free_under_cap_bytes, unallocated_quota_bytes}`, `disk{total_bytes, used_bytes, free_bytes}`.
  - Counters: `total_files`, `total_links`, `active_links`, `total_api_keys`, `archive_saved_bytes`, `dedup_saved_bytes`.
  - `users[]` (per-user: used/quota/percent/file_count/link_count/api_key_count).
  - Distributions: `lifecycle_counts`, `content_type_counts[]`, `link_status_counts`, `api_key_status_counts`, `recent_audit_counts[]`.
  - `fun_stats`: `top_downloaded_files[]`, `top_storage_users[]`, `biggest_files[]`, `file_type_counts{}`, `source_type_counts{}`, `remote_upload_counts{}`, `busiest_directories[]`, `collaborator_count`, etc.
- **Global storage cap** editor: input a size string → `PATCH /admin/storage` JSON `{global_storage_quota_bytes}` (parse the string to bytes first).
- Render charts/metrics from the above (storage ring, per-user bars, file-type bars, status pills, "most downloaded / biggest files / top users / busy folders / upload sources / remote jobs" lists). All display-only.
- **Lifecycle controls** (run jobs now, each returns `{processed}`):
  - `POST /admin/lifecycle/archive-idle`
  - `POST /admin/lifecycle/temp-expiry`
  - `POST /admin/lifecycle/link-expiry`
  - `POST /admin/lifecycle/reconcile`
  (All require CSRF + master.)

### 9.3 Files tab (all users' files & folders)
- Loads `GET /users/`, `GET /admin/files`, `GET /admin/directories`. Groups files/folders **by owner**.
- `GET /admin/files` returns full file objects incl. `links[]`, `access_key` (server mode), `archived`, `lifecycle_state`, `last_downloaded_at`, `stored_size_bytes`, `hashes`.
- Filter box (filename/type/owner/id). Per-owner section header with counts + total bytes.
- **Checkboxes** on files and folders feed the shared selection (consumed by Danger zone bulk ops). "Clear selection" button.
- Per **folder** row: open/copy public URL (with `?ek=` for server), **Delete all** → `DELETE /directories/{id}`.
- Per **file** row: encryption + zst + link-count badges; expandable **link panel**; actions:
  - **Archive / Unarchive** → `POST /admin/files/{id}/archive` or `/unarchive` → returns `{archive_saved_bytes, ...}`. (Client-encrypted files can't be archived.)
  - **Delete** → `DELETE /files/{id}`.
  - Link panel: **+ New link** (`POST /files/{fileId}/links`), copy/MD/open, **Edit** (opens link-edit modal), **Deactivate/Reactivate** (`PATCH /links/{id} {active}`), **Delete** (`DELETE /links/{id}`).
- **Link-edit modal** (shared, at page level): max downloads (`max_uses`, blank = unlimited → sends `null`), extend expiry (duration → `expires_in_seconds`), active toggle → `PATCH /links/{id}` JSON `{max_uses, expires_in_seconds?, active}`.

### 9.4 Audit log tab
- `GET /audit/?limit=&offset=&q=&action=` → `{entries:[{id, actor, action, target, ip, created_at}], actions:[...distinct], chain_ok, total_count, filtered_count, limit, offset}`.
- **Integrity banner**: `chain_ok` (audit log is a hash-chain; `false` = possibly tampered, show a strong warning).
- Search box (debounced, searches actor/action/target/ip/id), action dropdown (from `actions`), clear/refresh.
- Paginated table (page size ~50) with prev/next using `offset`. Color action badges by type (created/deleted/updated/etc.).

### 9.5 Backend logs tab
- `GET /admin/backend/logs?limit=&q=&level=` → `{entries:[{level, logger, module, function, line, message, created_at}], filtered_count, total_count}`.
- Filter box (debounced) + level dropdown (DEBUG/INFO/WARNING/ERROR/CRITICAL). Optional **auto-refresh** (poll every ~3s). Color rows by level.
- **Restart workers** button (danger, confirm) → `POST /admin/backend/restart-workers` → `{status, jobs}`. Restarts background scheduler jobs (lifecycle/cleanup); does not affect active requests.

### 9.6 API keys tab (all users' keys)
- `GET /admin/keys` → `[{id, owner_id, owner_username, user_key_number, bound_ip, active, created_at, last_used_at}]`.
- Filter box + status dropdown (all/active/revoked/bound/unbound). Checkboxes feed the selection (for bulk revoke / reset-IP in Danger zone).
- **+ New key** → `POST /keys/` (creates a key **for the current admin**) → show-once modal.
- Per key: **Reset IP** (password confirm) → `POST /keys/{id}/reset-ip`; **Revoke** → `DELETE /keys/{id}`.

### 9.7 Danger zone tab (bulk operations)
A grid of bulk actions. Each runs a **two-step preview→confirm** flow:
1. `POST /admin/bulk/preview` JSON `{action, ids}` → `{action, affected_count, confirmation_phrase, items[]}`. The phrase is literally `"CONFIRM <count>"`.
2. Prompt the admin to type the exact phrase, then `POST /admin/bulk/run` JSON `{action, ids, confirm:"CONFIRM <count>"}` → `{action, processed_count, affected_count}`.

Actions (and where `ids` come from):
- `delete_inactive_links` — all inactive/expired/used-up links (no selection needed).
- `revoke_api_keys` — selected keys if any checked, else all active keys.
- `reset_api_key_ips` — selected bound keys, else all bound.
- `archive_files` / `unarchive_files` / `delete_files` — require checked **files** in the Files tab.
- `delete_directories` — require checked **folders**.
- `run_cleanup_jobs` — runs temp-expiry + idle-delete + link-expiry + reconcile.

After a run, clear the relevant selection and bump the refresh version. Show a result summary ("processed X of Y").

---

## 10. Lifecycle & background behavior (context, not a page)

The backend runs scheduled jobs (hourly/10-min) that the UI surfaces but doesn't drive:
- **temp-expiry**: deletes files past their `expires_at` (temp files).
- **delete-idle**: deletes files not downloaded within `delete_if_idle_days`.
- **archive-idle**: zstd-compresses files idle past `archive_after_idle_days` (saves storage).
- **link-expiry**: deactivates expired links.
- **reconcile**: fixes stale lifecycle states.
- **stale-part sweep**: cleans abandoned chunked-upload temp data.

`lifecycle_state` values seen on files: `active`, `archiving`, `archived`, `unarchiving`. `archived` files are stored compressed; downloading transparently unarchives if `auto_unarchive_on_download` is true (else 503).

**Dedup**: identical content is stored once (content blobs are reference-counted). "Saving" a shared file/folder to your account shares the blob — cheap, but counts against your logical quota.

---

## 11. Complete endpoint index (quick reference)

Auth/account:
- `POST /auth/login` `{username,password}` → `{csrf_token, must_change_credentials}`
- `POST /auth/logout` (CSRF)
- `POST /account/change-credentials` (CSRF) `{current_password,new_username,new_password}`
- `GET /account/me` → identity + all permission flags + quota/usage

Files & links:
- `GET /files/` → own loose files
- `GET /files/usage` → `{used_bytes,quota_bytes,max_file_bytes}`
- `POST /files/upload` (multipart) → upload result
- `POST /files/upload/init` · `POST /files/upload/chunk?upload_id&index` · `GET /files/upload/status?upload_id` · `POST /files/upload/finalize` · `DELETE /files/upload?upload_id` (chunked)
- `POST /files/remote-upload` (CSRF) `{url,original_filename?}` ; `GET /files/remote-upload/{job_id}`
- `POST /files/{slug}/save` (CSRF) — save shared file to my files
- `DELETE /files/{id}` (CSRF, `can_delete`)
- `POST /files/{file_id}/links` (CSRF, `can_regenerate_links`) `{max_uses?,expires_in_seconds?}`
- `PATCH /links/{id}` (CSRF) `{max_uses?,expires_in_seconds?,active?}`
- `DELETE /links/{id}` (CSRF, `can_delete_links`)

Public download:
- `GET /file/{slug}/info` · `GET /file/{slug}/raw[?ek=]` · `GET /file/{slug}/preview` · `GET /file/{slug}` (page shell)

Directories:
- `GET /directories/` · `POST /directories` (CSRF) `{title,encryption_mode,expires_in_seconds?}`
- `GET /directories/{id}/files` · `DELETE /directories/{dirId}/files/{fileId}` (CSRF)
- `DELETE /directories/{id}` (CSRF)
- `POST /directories/{id}/collaborators` (CSRF) `{username}` · `DELETE /directories/{id}/collaborators/{user_id}` (CSRF) — collaborator management (owner only; not surfaced in current UI but available)
- Public folder: `GET /d/{slug}/info` · `GET /d/{slug}/preview-manifest` · `GET /d/{slug}/zip[?ek=]` · `POST /d/{slug}/save` (CSRF) · `GET /d/{slug}` (page shell)

Dropbox (receive) links:
- `POST /dropbox-links` (CSRF) `{expires_in_seconds,target_directory_id?}`
- `GET /dropbox/{token}` · `POST /dropbox/{token}/upload` (multipart, no auth)

API keys:
- `GET /keys/` · `POST /keys/` (CSRF, `can_use_api_keys`) → `{key}` once · `DELETE /keys/{id}` (CSRF) · `POST /keys/{id}/reset-ip` (CSRF) `{password}`

Admin (master only, mutations need CSRF):
- `GET /files/disk-stats`
- `GET /admin/storage` · `PATCH /admin/storage` `{global_storage_quota_bytes}`
- `GET /admin/files` · `GET /admin/directories`
- `POST /admin/files/{id}/archive` · `POST /admin/files/{id}/unarchive`
- `POST /admin/lifecycle/{archive-idle|temp-expiry|link-expiry|reconcile}`
- `GET /admin/backend/logs` · `POST /admin/backend/restart-workers`
- `POST /admin/bulk/preview` · `POST /admin/bulk/run`
- `GET /users/` · `POST /users/` · `PATCH /users/{id}` · `DELETE /users/{id}` · `POST /users/{id}/permissions`
- `GET /admin/keys`
- `GET /audit/`

Misc:
- `GET /health` → `{status:"ok"}`

---

## 12. Rebuild checklist (minimum to be functional)

1. **API client** with: CSRF header injection on mutations, `credentials: same-origin`, `{detail}` error parsing into a status-carrying error type, CSRF/user persistence.
2. **Auth gating**: `RequireAuth` (token present) and `RequireMaster` (role master) route wrappers; must-change-credentials redirect.
3. **Crypto**: reuse the FUPL AEAD worker + base64url key codec + the `#ek=`/`?ek=` URL builders/extractors + the store-only ZIP writer. These are interop-critical — copy them verbatim.
4. **Upload engine**: single vs chunked switch, parallel chunks + retries + resume, progress reporting, optional client-encrypt step.
5. The **8 pages** above (Login, Change, Files, File download, Folder, API docs, Admin, plus optionally a public Dropbox uploader page which the current SPA lacks).
6. Helpers: byte format, size parse, duration parse, date format, file-icon-by-content-type.
