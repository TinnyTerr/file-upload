# CLAUDE.md — fileupload project guide

## Overview

A self-hosted file sharing platform with end-to-end encryption, folder management, share links, API keys, dropboxes, and an admin panel. Built with Bun + Express on the backend and React + TypeScript on the frontend.

The backend was previously a Python/FastAPI app (`app/`). That implementation is **retired** — treat it as read-only reference material for porting routes, not as something that runs in production. `server/` (Bun + Express) is the only backend going forward, and the route port is now complete: every route in `app/routes/` has been reimplemented in `server/src/routes/` and mounted in `server/src/app.ts`, including cluster/realtime (`ws.py` → `server/src/ws.ts`, `cluster.py` → `server/src/routes/cluster.ts` + `server/src/cluster/*`). Correspondingly, every flag in `client/src/config/featureFlags.ts` is `true` (see `TODO_ROUTES.md` for the full per-route breakdown).

### Cluster subsystem

Multi-node replication, ported to `server/src/cluster/*.ts`:
- `membership.ts` — join/heartbeat/enroll handshake, full-mesh peer topology
- `replication.ts` — announce-id row replication (reserve/replicate/export) + rebase-from-master conflict fallback
- `blobs.ts` — content-addressed blob fetch-on-miss from peers (used by `routes/public.ts`'s raw/preview handlers as read-time failover)
- `halt.ts` — in-memory TTL'd upload halt registry (user-scope + global), gossiped over the event firehose
- `digest.ts` — cluster state digest + drift-detection job (`syncCheckJob`, registered in `jobs/scheduler.ts`)
- `eventBus.ts` / `eventStore.ts` / `firehoseClient.ts` — in-memory live event bus, durable `cluster_events` mirror, and the peer-polling consumer

`server/src/routes/cluster.ts` exports `clusterRouter` (mounted at `/api/cluster`: session-authenticated management endpoints plus cluster-token-authenticated node-to-node endpoints) and `adminClusterRouter` (mounted at `/api/admin/cluster`: node-logs + HTTP long-poll event fallback). `server/src/ws.ts` attaches the websocket firehose (`/api/ws/events` per-user, `/api/admin/cluster/firehose` cluster-token full firehose) directly to the `http.Server` returned by `app.listen()` in `index.ts`, since Express has no native websocket support.

The in-memory event sequence counter in `eventBus.ts` assumes **one process per node** (matches this server's single `app.listen()` call, no worker forking) — this was the exact bug class (`uvicorn --workers=4` colliding `origin_seq`) that broke logins in the old Python deployment. Don't reintroduce multi-process scaling for this server without revisiting cluster event sequencing.

---

## Tech stack

| Layer | Technology |
|---|---|
| Backend | Bun + Express, `bun:sqlite` (SQLite, no migrations) |
| Frontend | React 18/19, TypeScript, TanStack Query, Tailwind CSS, Radix UI primitives |
| Auth | Cookie-based sessions (`fu_session`) + CSRF tokens (`fu_csrf_token` in localStorage) |
| Crypto | AES-GCM (server-side, `server/src/crypto/aead.ts`), browser WebCrypto (client-side E2E) |
| Scheduling | `server/src/jobs/scheduler.ts` — plain `setInterval` jobs (archive/delete-idle, temp/link expiry, stale-part sweep, `torrent_poll`); no `node-cron`/`croner` dependency |
| Torrenting | qBittorrent WebUI API v2 on the host (`server/src/torrents/*`) |

---

## Running the project

**One command (build client + run server):**
```bash
bun install            # installs both workspaces (client/, server/)
bun run start           # builds client → public/, then runs server on :8000
```

**Dev (hot reload, both processes in parallel):**
```bash
bun run dev             # Vite on :5173 (proxies API calls) + Express on :8000
```

Config lives in `./data/app.env` and is auto-generated on first run. Environment variables:
- `APP_ENV` — `dev` (HTTP cookies) or `prod` (Secure cookies)
- `SECRET_KEY` — session signing key
- `MASTER_KEY_B64` — base64 AES-256 key used for server-side encryption
- `DATABASE_URL` — default `sqlite:///./data/app.db`
- `TRUST_PROXY` — set `true` behind a reverse proxy for real IP detection
- `QBITTORRENT_URL` / `QBITTORRENT_USERNAME` / `QBITTORRENT_PASSWORD` — host qBittorrent WebUI (e.g. `http://127.0.0.1:8080`). Empty = torrenting disabled everywhere
- `QBITTORRENT_SAVE_PATH` — the download location, as **qBittorrent** sees it
- `TORRENT_CONTENT_PATH` — the same directory as **this server** sees it; only needed when qBittorrent runs in a container with a different mount point (defaults to `QBITTORRENT_SAVE_PATH`)

**Legacy Python backend (`app/`, reference only — do not run in production):**
```bash
pip install -e ".[dev]"
python -m app          # dev server on :8000 — kept only as a porting reference
pytest
```

---

## Project structure

```
server/
  src/
    index.ts            # entrypoint (boot config/db, listen on :8000)
    app.ts               # Express app factory, middleware, static SPA serving, route mounting
    config.ts            # Settings loader (./data/app.env)
    db/                   # bun:sqlite adapter + schema.sql (Db interface, types.ts)
    bootstrap.ts          # DB init, master user seed
    appState.ts           # AppState (settings, db, sessionManager, lockout, clusterToken, eventBus, eventWriter, haltRegistry)
    ws.ts                  # Websocket firehose (/api/ws/events, /api/admin/cluster/firehose), attached to the raw http.Server
    security/             # sessions, csrf, lockout, passwords, apiKeys
    middleware/            # securityHeaders, requestLogging, httpsRedirect, auth (deps.ts)
    crypto/                # aead.ts (server-side AES-GCM), secretbox.ts (sealed tokens)
    storage/               # paths, blobs, compress, accounting (quota), zip
    cluster/                # membership, replication, blobs, halt, digest, eventBus/eventStore/firehoseClient
    jobs/                  # lifecycle.ts (archive/unarchive), scheduler.ts (setInterval workers, incl. cluster_heartbeat/cluster_sync_check)
    routes/
      auth.ts             # Login, logout, CSRF, sessions management
      account.ts          # /account/me, avatar, password change, reset/delete account
      files.ts            # Upload (single-shot + chunked), list, delete, link CRUD, admin list
      public.ts            # Public file info/raw/preview (no auth)
      directories.ts       # Folder CRUD, collaborators, per-folder links, admin + public /d/:slug surface
      dropbox.ts            # Dropbox link CRUD + public token-gated uploads
      keys.ts               # API key CRUD, admin key list
      users.ts              # Admin: user CRUD + permissions
      audit.ts              # Admin: audit log viewer
      admin.ts               # Admin: storage, backend logs, lifecycle triggers, bulk actions
      cluster.ts              # Cluster node linking + node-to-node membership/replication/blob handshake
      remoteUpload.ts        # Remote URL fetch-and-upload
      torrents.ts             # Torrent jobs (magnet/.torrent) + admin qBittorrent status
    torrents/                # qbittorrent.ts (WebUI API v2 client), poller.ts (scheduler job), importer.ts

app/  (retired — Python/FastAPI reference only, do not run in production)
  main.py               # FastAPI app factory, route mounting
  config.py             # Settings (pydantic-settings, env file)
  db.py                 # SQLAlchemy engine + session
  deps.py               # FastAPI dependency helpers
  bootstrap.py          # DB table creation, master user seed
  models/               # SQLAlchemy ORM models
    user.py             # User, Permission
    file_object.py      # FileObject
    link.py             # Link (file share links)
    directory.py        # Directory (folders)
    directory_link.py   # DirectoryLink (folder share links)
    session.py          # SessionRow (login sessions)
    api_key.py          # ApiKey
    audit.py            # AuditLog
    dropbox.py          # DropboxLink
  routes/
    auth.py             # Login, logout, CSRF, sessions management
    account.py          # /account/me, avatar, password change
    files.py            # File upload, list, delete, link CRUD
    directories.py      # Folder CRUD, member management, link CRUD
    public.py           # Public file/folder info endpoints (no auth)
    keys.py             # API key management
    dropbox.py          # Dropbox upload endpoint
    admin.py            # Admin: users, files, keys, audit log
    users.py            # Admin: create/edit/delete users
    audit_view.py       # Admin: audit log viewer
    remote_upload.py    # Remote URL fetch-and-upload
  security/
    sessions.py         # SessionManager: create, validate, revoke
  crypto/               # Encryption/decryption helpers
  storage/              # File storage, accounting (quota)
  jobs/                 # Scheduled jobs (cleanup, expiry)

client/src/
  features/
    auth/               # Login page, auth context, hooks
    files/              # File list, upload dropzone, link management
    directories/        # Folder list, folder links modal
    download/           # Public download page (/file/:slug)
    folder-view/        # Public folder view (/d/:slug)
    admin/              # Admin panel (users, files, keys, audit)
    api-docs/           # Interactive API reference page
    apikeys/            # API key management UI
    torrents/           # Torrents page (add magnet/.torrent, live progress)
    account/            # Profile, avatar, password
  components/
    layout/             # Sidebar, settings modal (sessions tab), top bar
    ui/                 # Shared Radix-based design system components
  config/
    api.ts              # Typed API client (handles CSRF, auth errors)
    navigation.ts       # Sidebar nav items
    permissions.ts      # Permission flags and metadata
  providers/            # QueryClient, DialogProvider, ThemeProvider
```

---

## Key patterns

### Authentication

- Sessions stored as `fu_session` HTTP-only cookie
- CSRF token stored in `localStorage` as `fu_csrf_token`, sent as `X-CSRF-Token` header on all mutating requests
- Backend `require_csrf` dependency validates session + CSRF together
- API key auth via `Authorization: Bearer <key>` header — bypasses CSRF requirement
- Roles: `master` (admin), `user` (default)

### Database

- SQLite via SQLAlchemy 2.0 (no Alembic). Schema is created by `bootstrap.py` on startup using `Base.metadata.create_all()`.
- **Never use Alembic migrations** — just add columns with `server_default` or nullable.
- `UTCDateTime` custom type stores timestamps in UTC.
- Old columns removed from ORM models are silently ignored by SQLAlchemy (they remain in the DB schema).

### File storage

- Files stored under `data/files/` with a UUID-based path.
- Quota tracked via `storage.accounting.used_storage_bytes()` — sum of `size_bytes` on `FileObject` records.
- Compression uses zstandard (`zstandard` library).

### Encryption modes

| Mode | Description |
|---|---|
| `none` | No encryption. Link slug is the only credential. |
| `server` | AES-GCM encrypted at rest. `?ek=` query param gates download. Server decrypts before streaming. |
| `client` | E2E encrypted in browser. Ciphertext stored on server. `#ek=` fragment never sent to server. |

### Share links (files)

- `Link` model: `file_id`, `slug`, `max_uses`, `use_count`, `expires_at`, `active`, `hide_uploader`
- `hide_uploader=True` suppresses uploader name/avatar on the public download page AND in the server response
- Multiple links per file — each with its own limits

### Share links (folders)

- `DirectoryLink` model mirrors `Link`; same fields
- Folder public URLs resolve via `DirectoryLink.slug` (not `Directory.slug`)
- On folder creation, a default `DirectoryLink` is auto-created

### Permissions

Defined in `app/models/permission.py` and `client/src/config/permissions.ts`:
- `can_upload`, `can_delete`, `can_delete_links`, `can_regenerate_links`
- `can_use_api_keys`, `can_use_dropbox`, `can_use_torrents`
- `master` role bypasses all permission checks

Adding a flag means touching all of: `server/src/db/schema.sql` (+ an `ensureColumn` backfill in `server/src/db/sqlite.ts`, since schema.sql only runs `CREATE TABLE IF NOT EXISTS`), `server/src/db/rows.ts`, `server/src/permissions.ts` (`BOOL_FLAGS` + the master seed insert), `server/src/bootstrap.ts`, `MASTER_ALL_TRUE` in `server/src/routes/users.ts`, the `/account/me` payload in `server/src/routes/account.ts`, and `client/src/config/permissions.ts`.

### Admin panel

- Requires `master` role (`require_master` dependency)
- Files tab: grouped by owner username, alphabetically sorted
- Keys tab: grouped by owner username, alphabetically sorted  
- Hard-deletes API keys when users delete them (not soft-delete)

### Torrenting

Downloads run on a **qBittorrent instance on the host**, not in this process — the server only drives its WebUI API v2 (`server/src/torrents/qbittorrent.ts`) and imports the result:

1. `POST /api/torrents` (permission `can_use_torrents`) hands qBittorrent a magnet or an uploaded `.torrent`, with `savepath = <QBITTORRENT_SAVE_PATH>/<tag>` and `autoTMM=false`, and inserts a `torrent_jobs` row. Each job gets a unique tag (`fu-<hex>`) — that tag, not the info hash, is how the poller finds the torrent again (a magnet's hash is known up front, an uploaded `.torrent`'s is not).
2. The `torrent_poll` scheduler job (every 15s, `torrents/poller.ts`) mirrors progress/speed/ETA onto the row, and on completion imports the content through `finalizeStoredFile` — so quota, blob dedup, share-link minting and cluster replication all behave exactly like a normal upload. Multi-file torrents land in a new folder titled after the torrent; single-file torrents become a plain file. `source_type` is `torrent`.
3. After a successful import the torrent + its data are deleted from qBittorrent. A **failed** import (usually quota) deliberately leaves the downloaded data in place so `POST /api/torrents/:id/retry` can re-import without re-downloading.

Notes:
- Only magnets and uploaded `.torrent` files are accepted. Handing qBittorrent an arbitrary `http(s)` URL to fetch would turn it into an SSRF proxy into the host's network — the remote-upload route guards that surface by pinning validated public IPs (`routes/remoteUpload.ts`), which is impossible to enforce through qBittorrent.
- `TORRENT_CONTENT_PATH` exists because the import reads the files directly off disk: qBittorrent's view of the download directory and this server's view differ as soon as either side is containerized.
- Everything (routes, poller, nav item) is inert unless `QBITTORRENT_URL` **and** `QBITTORRENT_SAVE_PATH` are set; the API answers 503 and the admin panel's Torrents tab says so.

### Session management

- `SessionRow` tracks: `token_hash`, `user_id`, `ip_address`, `user_agent`, `last_seen_at`, `expires_at`
- Settings → Sessions tab: list active sessions, revoke individual (with password), sign out all
- `GET /auth/sessions`, `DELETE /auth/sessions/{id}`, `DELETE /auth/sessions`

### Duplicate save prevention

- `FileObject.saved_from_file_id` — tracks the origin file ID when saved from a share link
- `Directory.saved_from_directory_id` — same for folders
- Backend rejects: owner saving their own file/folder; user saving the same file/folder twice (409 Conflict)
- Frontend: "Save" button disabled + shows "Already saved" when `already_saved=true` from public info endpoint

### Frontend API client

`client/src/config/api.ts` — typed wrapper around `fetch`:
- Automatically reads CSRF token from `localStorage`
- Adds `X-CSRF-Token` header to POST/PATCH/DELETE/PUT
- Throws `ApiError` on non-2xx responses with `detail` from JSON body

---

## File-specific notes

- `app/routes/public.py` — public file/folder info returns `uploader: {username, has_avatar, user_id} | null` (null if `hide_uploader=True` on the link) and `already_saved: bool`
- `app/routes/files.py` — `_serialize_files()` includes `owner_username` via batch lookup; `_recover_access_key()` reconstructs server-mode key for the owner
- `app/routes/directories.py` — `_safe_arcname()` strips leading dots from filenames to prevent dotfile archives; `directory_zip` audit row is now properly committed
- `app/routes/dropbox.py` — single-shot uploads call `_precheck_declared_size` before receiving the body
- `app/security/sessions.py` — `SessionManager.create()` accepts `ip` and `user_agent` kwargs
- `client/src/components/layout/UserMenu.tsx` — collapsed sidebar trigger is a plain `Button` (no Tooltip wrapper — that breaks Radix DropdownMenu click events)
- `client/src/features/files/components/Dropzone.tsx` — uses `bg-brand-gradient` (not `bg-brand-gradient/90` — opacity modifiers don't work on CSS gradient custom properties) and `text-white` (not `text-primary-foreground`)

---

## What NOT to do

- Don't run migrations — just add nullable columns or columns with `server_default`
- Don't wrap `DropdownMenuTrigger`'s `asChild` button in a `Tooltip` — it breaks click events
- Don't use `bg-brand-gradient/90` — opacity modifiers don't apply to CSS variable gradients
- Don't use `text-primary-foreground` on brand gradient backgrounds — use `text-white`
- Don't soft-delete API keys in admin — hard delete them so they disappear from the admin panel immediately
