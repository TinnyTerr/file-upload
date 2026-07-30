# CLAUDE.md — fileupload project guide

## Overview

A self-hosted file sharing platform with end-to-end encryption, folder management, share links, API keys, dropboxes, torrenting, multi-node clustering, and an admin panel. Bun + Express on the backend, React + TypeScript on the frontend.

This project began as a Python/FastAPI app (`app/`). That backend is **retired and has been deleted from the repo** — `server/` (Bun + Express) is the only backend. Every route was ported and every flag in `client/src/config/featureFlags.ts` is `true`.

Many source comments still say "Mirrors `app/routes/x.py`" or similar. Those refer to the deleted Python original and are historical lineage notes only — **do not go looking for `app/`, it isn't there.** Treat such a comment as describing intent, not as a pointer to readable code.

### Cluster subsystem

Multi-node replication lives in `server/src/cluster/*.ts`:
- `membership.ts` — join/heartbeat/enroll handshake, full-mesh peer topology
- `election.ts` — elected, epoch-versioned leadership (vote-request / master-assumed), layered *under* the replication protocol
- `replication.ts` — announce-id row replication (reserve/replicate/export) + rebase-from-master conflict fallback
- `blobs.ts` — content-addressed blob fetch-on-miss from peers (read-time failover for `routes/public.ts`'s raw/preview handlers)
- `cacheEviction.ts` — LRU eviction for `REPLICATION_MODE=cache` nodes; verifies durability on a full-replica peer before deleting anything
- `halt.ts` — in-memory TTL'd upload halt registry (user-scope + global), gossiped over the event firehose
- `digest.ts` — cluster state digest, drift detection, and the split-brain cross-check (`syncCheckJob`)
- `eventBus.ts` / `eventStore.ts` / `firehoseClient.ts` — in-memory live event bus, durable `cluster_events` mirror, peer-polling consumer
- `http.ts` — node-to-node fetch helpers (cluster-token auth, timeouts)

`routes/cluster.ts` exports `clusterRouter` (mounted at `/api/cluster`: session-authenticated management endpoints **plus** cluster-token-authenticated node-to-node endpoints) and `adminClusterRouter` (mounted at `/api/admin/cluster`: node-logs + HTTP long-poll event fallback). `server/src/ws.ts` attaches the websocket firehose directly to the `http.Server` returned by `app.listen()` in `index.ts`, since Express has no native websocket support.

**Invariant:** the in-memory event sequence counter in `eventBus.ts` assumes **one process per node** (this server makes a single `app.listen()` call and never forks workers). Colliding `origin_seq` values across workers is the exact bug class that broke logins under `uvicorn --workers=4` in the old deployment — see `cluster_events`' `UNIQUE(origin_node_id, origin_seq)`. Don't introduce multi-process scaling without redesigning event sequencing.

---

## Tech stack

| Layer | Technology |
|---|---|
| Backend | Bun + **Express 4**, `bun:sqlite` (SQLite, no migrations) |
| Frontend | React 19, TypeScript, TanStack Query, Tailwind CSS v4, Radix UI primitives |
| Auth | Cookie sessions (`fu_session`) + CSRF (`fu_csrf_token` in localStorage); optional TOTP / WebAuthn second factor |
| Crypto | AES-256-GCM server-side (`crypto/aead.ts`), browser WebCrypto for client-side E2E (`client/src/workers/`) |
| Compression | zstd via **`node:zlib`** (`zlib.createZstdCompress`) — not the Python `zstandard` package |
| Scheduling | `jobs/scheduler.ts` — plain `setInterval` jobs; no `node-cron`/`croner` dependency |
| Torrenting | Real-Debrid REST 1.0 (preferred), qBittorrent WebUI API v2 on the host (fallback) — `server/src/torrents/*` |
| Images | `sharp` for thumbnails, `ffmpeg` (external binary, optional) for video frame extraction |

---

## Running the project

**One command (build client + run server):**
```bash
bun install             # installs both workspaces (client/, server/)
bun run start           # builds client → public/, then runs server on :8000
```

**Dev (hot reload, both processes in parallel):**
```bash
bun run dev             # Vite on :5173 (proxies API calls) + Express on :8000
```

**Typecheck both workspaces:**
```bash
bun run typecheck
```

Config lives in `./data/app.env`, auto-generated on first run (mode `0600`). Environment variables:

| Variable | Purpose |
|---|---|
| `APP_ENV` | `dev` (plain cookies, no HTTPS redirect) or `prod` (Secure cookies + HTTPS redirect). **Defaults to `prod`.** |
| `SECRET_KEY` | Session cookie signing key |
| `MASTER_KEY_B64` | base64 AES-256 key for server-side encryption and sealed tokens |
| `DATABASE_URL` | Default `sqlite:///./data/app.db` |
| `ALLOWED_HOSTS` | Comma-separated hostnames. Gates the WebAuthn relying-party ID and the HTTPS-redirect proxy-header trust. **Empty = unconfigured**, which logs a startup warning — set it in production. |
| `TRUST_PROXY` | `true` (generic reverse proxy) or `cloudflare` (prefer `CF-Connecting-IP`). Required behind a TLS-terminating proxy, or every request 308-redirects to https forever. |
| `NODE_ID` / `NODE_NAME` / `NODE_URL` | This node's cluster identity and the base URL it advertises to peers |
| `NODE_ROLE` | Bootstrap role on *first ever* boot only; afterwards the persisted elected role in `cluster_self_state` always wins |
| `MASTER_URL` / `MASTER_TOKEN` | Coordinates a non-master node auto-joins at startup |
| `CLUSTER_TOKEN` | Shared bearer token for node-to-node endpoints |
| `REPLICATION_MODE` | `full` (default) or `cache` (bounded LRU over the cluster blob store) |
| `CACHE_MAX_BYTES` | Cache-mode eviction cap. `0`/unset = never evict. |
| `ARCHIVE_ENABLED` | Advertised to peers; gates archive participation |
| `REALDEBRID_API_KEY` | Real-Debrid API token. Set from the admin panel (Torrents tab), which validates it against `GET /user` before persisting. Empty = every torrent goes to qBittorrent. |
| `REALDEBRID_ENABLED` | Admin kill switch (default `true`). `false` routes torrents to qBittorrent without discarding the saved token. |
| `QBITTORRENT_URL` / `_USERNAME` / `_PASSWORD` | Host qBittorrent WebUI (e.g. `http://127.0.0.1:8080`). The fallback backend; empty *and* no Real-Debrid token = torrenting disabled everywhere. |
| `QBITTORRENT_SAVE_PATH` | Download location, as **qBittorrent** sees it |
| `TORRENT_CONTENT_PATH` | The same directory as **this server** sees it; only needed when qBittorrent is containerized separately (defaults to `QBITTORRENT_SAVE_PATH`) |
| `LOG_LEVEL` | Python-style level name (`DEBUG`/`INFO`/`WARNING`/…), default `INFO` |
| `FILEUPLOAD_CONFIG` | Override the config file path (default `./data/app.env`) |
| `FILEUPLOAD_STORAGE` | Override the blob storage root (default `./data/storage`) |
| `FILEUPLOAD_THUMBNAILS` | Override the thumbnail cache root (default `./data/thumbnails`) |
| `FILEUPLOAD_DEBRID` | Override the Real-Debrid staging root (default `./data/debrid`) |

---

## Project structure

```
server/src/
  index.ts                 # entrypoint: load config, init db, seed master, start workers, listen
  app.ts                   # Express app factory: middleware order, route mounting, SPA serving, error handler
  appState.ts              # AppState (settings, db, sessionManager, lockout, clusterToken, eventBus,
                           #           eventWriter, haltRegistry, loginChallenges, secondFactorTickets)
  config.ts                # Settings loader / generator for data/app.env
  bootstrap.ts             # First-run master user seed (only when `users` is empty)
  spa.ts                   # Reads the built SPA shell, injects per-page og: meta tags
  links.ts                 # Slug minting + atomic single-UPDATE link use consumption
  audit.ts                 # Hash-chained audit log (recordAudit / verifyAuditChain)
  logging.ts               # pino + in-memory ring buffer backing GET /api/admin/backend/logs
  httpError.ts             # HttpError — thrown anywhere, rendered as {detail} by app.ts
  ws.ts                    # Websocket firehose, attached to the raw http.Server
  db/
    schema.sql             # Whole schema, CREATE TABLE/INDEX IF NOT EXISTS, run every boot
    sqlite.ts              # bun:sqlite adapter + ensureColumn backfills for added columns
    backfill.ts            # ensureColumn helper (ALTER TABLE ADD COLUMN if absent)
    types.ts / rows.ts     # Db interface; row shapes for every table
  security/
    sessions.ts            # SessionManager: signed-cookie sid, server-side row, throttled last_seen_at
    csrf.ts                # requireCsrf (needs an already-resolved req.sessionRow)
    passwords.ts           # Argon2id via Bun.password + a constant-time dummy verify
    lockout.ts             # Rolling-window failed-login lockout, per username AND per IP
    apiKeys.ts             # Key generation, hashing, first-use IP binding
    credentials.ts         # TOTP / WebAuthn credential rows
    webauthn.ts            # @simplewebauthn wrappers + rpID/origin resolution
    loginChallenges.ts     # Pre-login websocket correlation ids + ws-token rate limiter
    secondFactorTickets.ts # Single-use password→second-factor bridge tickets
  middleware/
    asyncHandler.ts        # REQUIRED wrapper for every async route (see Gotchas)
    auth.ts                # requireSession, clientIp (proxy-header aware)
    deps.ts                # requireActiveUser / requireMaster / requirePermission / getUploadUser / requireApiKey
    securityHeaders.ts     # nosniff, DENY framing, no-referrer, HSTS in prod
    requestLogging.ts      # Method/path/status/duration at noise-proportional levels
    httpsRedirect.ts       # 308 http→https outside dev, honoring proxy headers
  crypto/
    aead.ts                # Streaming chunked AES-256-GCM file container ("FUPL" magic)
    secretbox.ts           # Single-shot AES-256-GCM for key/access blobs + sealed upload tokens
    secretEncrypt.ts       # Versioned single-shot AEAD for tiny secrets (TOTP seeds)
  storage/
    paths.ts               # storageRoot/thumbnailRoot, safeJoin traversal guard, fan-out rel paths
    blobs.ts               # Content-addressed dedup + ref counting (attachBlob / releaseBlob)
    accounting.ts          # Quota + global cap + free-disk enforcement
    compress.ts            # zstd compress/decompress with zip-bomb guards
    zip.ts                 # safeArcname + memberSource (plaintext bytes for zip streaming)
    thumbnail.ts           # Cached JPEG thumbnails (sharp; ffmpeg for video frames)
    streaming.ts           # Shared read path: peer fetch-on-miss + plaintext stream
    mediaProbe.ts          # ffprobe backfill of content_blobs media_* columns
  cluster/                 # see "Cluster subsystem" above
  jobs/
    lifecycle.ts           # archive/unarchive cores + idle-archive/idle-delete/expiry/reconcile sweeps
    scheduler.ts           # setInterval registration for every background job
  media/
    playKeys.ts            # Sealed play-key tokens + DB revocation list + prune
  torrents/
    realdebrid.ts          # Real-Debrid REST 1.0 client (user, addMagnet/addTorrent, selectFiles,
                           #   info, delete, unrestrict) + RealDebridError with authFailed
    debrid.ts              # Debrid-first dispatch + qBittorrent fallback, RD status polling,
                           #   streaming transfer of finished torrents into the staging root
    qbittorrent.ts         # WebUI API v2 client (cached SID, allTorrents, byTag, add/delete)
    poller.ts              # torrent_poll scheduler job: progress mirroring + completion import
    importer.ts            # Copies finished torrent content through the normal finalize pipeline
  routes/                  # one file per surface; see "Route mounts" below

client/src/
  App.tsx, main.tsx
  features/
    auth/                  # Login page, second-factor step, auth context, login websocket
    account/               # Profile, avatar, password, security (MFA) tab
    files/                 # File list, upload dropzone + core, link management, remote upload
    directories/           # Folder list, folder links modal, folder upload
    download/              # Public download page (/file/:slug)
    folder-view/           # Public folder view (/d/:slug)
    dropbox/               # Dropbox link management + public token-gated upload page
    apikeys/               # API key management UI
    torrents/              # Torrents page (add magnet/.torrent, live progress)
    cluster/               # Cluster dashboard (nodes, token, halts)
    admin/                 # Admin panel (users, files, keys, audit, storage, logs, torrents)
    media/                 # Media library: poster grid, player, publish + play-key UI
    api-docs/              # API reference page — renders docs/api.md fetched from /api/docs.md
  components/
    layout/                # Sidebar, settings modal (sessions tab), top bar
    ui/                    # Shared Radix-based design system components
  workers/                 # aead.worker.ts + fuplCore.ts — client-side E2E encryption off the main thread
  lib/                     # base64url, bytes, cn, copy, download, time, zip helpers
  config/
    api.ts                 # Typed API client (CSRF header, ApiError normalization)
    featureFlags.ts        # All true; kept as a kill switch
    navigation.ts          # Sidebar nav items
    permissions.ts         # Permission flags + UI metadata
  providers/               # QueryClient, DialogProvider, ThemeProvider, UploadProvider

docs/
  api.md                   # THE public API reference — single source; served raw at
                           #   GET /api/docs.md and rendered by the /api-docs page
public/                    # Built client output, served by Express
data/                      # Runtime state: app.env, app.db, storage/, thumbnails/ (gitignored)
```

### Route mounts

Every data endpoint lives under `/api/*` so it can never collide with an SPA client-side route (`/files`, `/admin`, `/cluster` are both page routes and API prefixes).

| Mount | Router |
|---|---|
| `/api/auth` | `auth.ts` — login, MFA verify, logout, session list/revoke |
| `/api/account`, `/api/account/mfa` | `account.ts`, `mfa.ts` |
| `/api/files`, `/api/links`, `/api/admin/files` | `files.ts` (+ `remoteUpload.ts` on `/api/files`) |
| `/api/keys`, `/api/admin/keys` | `keys.ts` |
| `/api/users`, `/api/audit`, `/api/admin` | `users.ts`, `audit.ts`, `admin.ts` |
| `/api/torrents`, `/api/admin/torrents` | `torrents.ts` |
| `/api/media` | `media.ts` — library browse, publish, stream, play keys |
| `/api/cluster`, `/api/admin/cluster` | `cluster.ts` |
| `/api` (self-prefixed paths) | `directories.ts`, `dropbox.ts`, `docs.ts` (`/docs.md`), `public.ts` (`/file/:slug*`), public folder routes (`/d/:slug*`) |

---

## Key patterns

### Authentication

- Session id in an HMAC-signed `fu_session` HTTP-only cookie (`SameSite=strict`); the session row (including its CSRF token) lives server-side.
- CSRF token returned at login, stored in `localStorage` as `fu_csrf_token`, sent as `X-CSRF-Token` on every mutating request. `requireCsrf` validates it against the resolved session row — it requires `requireSession` to have run first.
- API key auth via `Authorization: Bearer <key>` bypasses CSRF (no cookie, no cross-site risk). Keys bind to their first-seen IP on first use.
- Roles: `master` (admin) and `user`. `master` bypasses all permission checks.
- `must_change_credentials` accounts are rejected by `requireActiveUser` (403) but can still reach `/api/account/change-credentials`.

### Login + second factor

The login flow is a multi-step ceremony, not a single POST:

1. `POST /api/auth/login` verifies the password. If the user has enrolled credentials **and** MFA is enforced (`mfa_required`, or role `master`), it returns `{status: "mfa_required", mfa_ticket, methods}` instead of a session.
2. The ticket (`security/secondFactorTickets.ts`) is single-use, 2-minute TTL, 5-attempt cap. It is *not* proof of authentication on its own.
3. `POST /api/auth/totp/verify-login` or the WebAuthn login pair completes the ceremony and issues the session.
4. Usernameless WebAuthn login (`/api/auth/webauthn/login/start|finish`) skips step 1 entirely — the passkey identifies the user.
5. `GET /api/auth/ws-token` mints a short-lived `conn_id` for the pre-login websocket (`/api/auth`), which pushes live state transitions during the ceremony. `conn_id` is a transport correlation id **only**, never an authorization credential.

Failed logins feed `security/lockout.ts`, which counts per-username *and* per-IP within a rolling 15-minute window; only the username counter resets on success.

### Database

- SQLite via `bun:sqlite` (no ORM, no Alembic). `db/schema.sql` runs on every boot as `CREATE TABLE/INDEX IF NOT EXISTS`.
- **Never use migrations.** Add nullable columns or columns with a `DEFAULT`, then add an `ensureColumn()` call in `db/sqlite.ts` — `CREATE TABLE IF NOT EXISTS` does nothing to an already-existing table, so new columns *only* land via `ensureColumn`.
- New indexes need no backfill: `CREATE INDEX IF NOT EXISTS` in `schema.sql` applies to existing databases on the next boot.
- Timestamps are ISO8601 UTC strings (`nowIso()`), not a dedicated column type. Comparisons are lexicographic string comparisons, which is why the format must stay fixed-width UTC.
- `PRAGMA foreign_keys = ON` and WAL journaling are both enabled in `db/sqlite.ts`.
- Columns dropped from a `db/rows.ts` interface are silently ignored — they remain in the DB.

### File storage

- Blobs live under `data/storage/` (override: `FILEUPLOAD_STORAGE`) at a random two-level fan-out path (`ab/cd/<rest>`), **not** a name derived from the upload.
- Storage is content-addressed and deduplicated: `attachBlob()` keys on `(stored_sha256, transform_key)` and bumps `ref_count` on a hit; `releaseBlob()` decrements and returns the physical path to unlink only when the last reference goes.
- Two different "used bytes" numbers exist and are not interchangeable:
  - `usedStorageBytes()` — `SUM(stored_size_bytes)` over `content_blobs`. Real disk consumption, post-dedup. Used for the global cap.
  - `usedStorageBytesForUser()` / `usedBytes()` — `SUM(size_bytes)` over that user's `files`. Logical, pre-dedup. Used for per-user quota, so dedup savings aren't silently handed to whoever uploaded second.
- Archived blobs are excluded from dedup matching — their on-disk bytes are zstd-wrapped and don't match the identity they were minted for.

### Encryption modes

| Mode | Description |
|---|---|
| `none` | No encryption. The link slug is the only credential. |
| `server` | AES-GCM encrypted at rest. `?ek=` query param gates download; the server decrypts before streaming. |
| `client` | E2E encrypted in the browser. Ciphertext stored server-side. The `#ek=` fragment never reaches the server. |

**Transform order matters and differs by producer** (see Gotchas): upload-time compression produces `ENC(ZSTD(x))` with `compressed = 1`; the archive job produces `ZSTD(ENC(x))` with `compressed = 0, archived = 1`.

### Share links

- `links` (files) and `directory_links` (folders) have identical shapes: `slug`, `max_uses`, `use_count`, `expires_at`, `active`, `hide_uploader`.
- `hide_uploader` suppresses the uploader's name/avatar on the public page **and** in the API response.
- Multiple links per file, each with its own limits. Folder public URLs resolve via `directory_links.slug`, never `directories.slug`; a default folder link is auto-created at folder creation.
- Use consumption is a single atomic `UPDATE … WHERE … RETURNING id` (`links.ts::consumeUse`) so concurrent downloads can't overshoot `max_uses`.

### Permissions

Defined in `server/src/permissions.ts` (`BOOL_FLAGS`) and mirrored in `client/src/config/permissions.ts`:

`can_upload` · `can_upload_client_encrypted` · `can_delete` · `can_regenerate_links` · `can_delete_links` · `can_create_directories` · `can_manage_lifecycle` · `can_use_api_keys` · `can_view_admin` · `can_manage_users` · `can_manage_storage` · `can_manage_api_keys` · `can_manage_cluster` · `can_use_torrents` · `can_watch_media`

Plus the non-boolean `quota_bytes`, `max_file_bytes`, `archive_after_idle_days`. `master` bypasses every check.

Adding a flag means touching **all** of: `db/schema.sql`, an `ensureColumn` backfill in `db/sqlite.ts`, `db/rows.ts`, `permissions.ts` (`BOOL_FLAGS` + the master seed insert), `bootstrap.ts`, `MASTER_ALL_TRUE` in `routes/users.ts`, the `/account/me` payload in `routes/account.ts`, `TABLE_COLUMNS.permissions` in `cluster/replication.ts` (or it silently resets to the default on every peer), and `client/src/config/permissions.ts`.

### Admin panel

- Gated by `requireMaster`, except bulk actions, which also accept a non-master holding `can_view_admin` plus the specific flag for that action (`BULK_ACTION_PERMISSIONS`).
- Files and keys tabs group by owner username, alphabetically.
- Bulk actions require an exact `CONFIRM <n>` phrase matching the previewed candidate count. **A bulk action with no ids and no `owner_id` targets every matching row in the system** — that's intentional, and the confirmation phrase is the only guard.
- API keys are hard-deleted, never soft-deleted, so they leave the panel immediately.
- `GET /api/audit` only verifies the hash chain when asked (`?verify=1`); it's an O(all rows) rehash, so it isn't run on every page load.

### Torrenting

Two backends, chosen per job. **Real-Debrid is preferred and qBittorrent is the fallback** — never the other way round. `torrent_jobs.provider` records which one owns a given job (`'debrid'` | `'qbittorrent'`), and every job of either kind ends at the same place: `finalizeStoredFile`, so quota, blob dedup, link minting and cluster replication behave exactly like a normal upload. Multi-file torrents land in a new folder named after the torrent; single-file torrents become a plain file. `source_type` is `torrent`.

`POST /api/torrents` (needs `can_use_torrents`) accepts a magnet or an uploaded `.torrent` and calls `debrid.ts::dispatchTorrent`, which decides the backend. Each job gets a unique tag (`fu-<hex>`) — for qBittorrent the tag (not the info hash) is how the poller finds the torrent again; for both providers it names the per-job download directory.

**Real-Debrid path** (`torrents/realdebrid.ts` + `torrents/debrid.ts`):

1. `POST /torrents/addMagnet` or `PUT /torrents/addTorrent` (raw metainfo body), then `POST /torrents/selectFiles/{id}` with `files=all` — a freshly added torrent parks in `waiting_files_selection` and will never start without it. A magnet rejects the call until `magnet_conversion` finishes, so the poller retries it.
2. The `torrent_poll` job polls `GET /torrents/info/{id}` (throttled to 10s per job — the token is rate limited) and mirrors Real-Debrid's status onto `debrid_status`, progress onto `progress`/`size_bytes`/`dl_speed`.
3. On `downloaded`, the job flips to status `fetching` and a **detached** task streams every link (`POST /unrestrict/link` immediately before each transfer, since those URLs are short-lived) into `data/debrid/<tag>/`, laid out to match the torrent's own directory structure. The transfer runs outside the poll loop so a multi-GB pull doesn't stall every other job's progress updates.
4. The staged directory is then handed to the same importer qBittorrent jobs use, and the torrent is deleted from the Real-Debrid account.

**Fallback to qBittorrent** happens when Real-Debrid can't deliver: no token, a rejected token, a non-premium account, exhausted traffic, an API outage, a `magnet_error`/`error`/`virus`/`dead` status, or a transfer that fails twice. The job's row is rewritten in place (`provider`, `save_path`, `created_at` reset, `fallback_reason` set) and restarted on qBittorrent, so the user sees one job throughout.

Notes:
- **No cache pre-check, ever.** Real-Debrid downloads a torrent it has never seen just as happily as a cached one, so `dispatchTorrent` deliberately does *not* call `instantAvailability`. Everything goes through debrid when it's configured; only failure demotes a job.
- **Polling shape (qBittorrent):** one `GET /api/v2/torrents/info` per tick for the whole cluster of jobs, grouped by tag locally (`qbittorrent.ts::allTorrents` + `byTag`), and **zero** qBittorrent requests when nothing is in flight. Don't reintroduce a per-job request — older qBittorrent builds ignore the `?tag=` filter and return the full list every time, so per-job polling is O(jobs) full list fetches every tick.
- Client poll intervals are deliberately matched to the server's 5s cadence, with `refetchIntervalInBackground: false`. Polling faster than the server refreshes just multiplies identical responses.
- Only magnets and uploaded `.torrent` files are accepted. Handing qBittorrent an arbitrary `http(s)` URL would turn it into an SSRF proxy into the host's network — a surface `routes/remoteUpload.ts` guards by pinning validated public IPs, which is impossible to enforce through qBittorrent. The same URL through Real-Debrid is just remote-upload with extra steps.
- The Real-Debrid token is admin-managed (`PUT /api/admin/torrents/debrid`), validated against `GET /user` **before** it is persisted — an unchecked key would look installed while quietly demoting every job — and written to `data/app.env` (mode 0600). It is node-local config, not replicated cluster state.
- `TORRENT_CONTENT_PATH` exists because the import reads files directly off disk, and qBittorrent's view of the download directory differs from this server's as soon as either side is containerized. Debrid jobs never need it: `importer.ts::localJobDir` branches on `provider` and returns our own staging root.
- Everything (routes, poller, nav item) is inert unless a Real-Debrid token **or** `QBITTORRENT_URL` + `QBITTORRENT_SAVE_PATH` are set; the API answers 503 and the admin Torrents tab says so.

### Media library

Folders published with `directories.is_library` become browsable collections on
`/watch`; their video/audio children are the playable titles. `library_visibility`
is `public` (anyone, no account, like a share link) or `restricted` (an account
holding `can_watch_media`; the owner and masters always qualify). `library_kind`
picks the presentation — `movie` (one title) vs `series` (episode list).

External players carry no session cookie, so restricted titles are also reachable
with a **play key** (`media/playKeys.ts`): an AES-GCM sealed token appended to the
stream URL as `?k=`, scoped to one file or one collection. Verification is a
decrypt rather than a join (mpv issues a Range request per seek), with
`media_play_keys` as the revocation list behind it.

- **An unknown `jti` is rejected, not trusted.** That strictness is what makes the
  `media_playkey_prune` job safe: it only deletes rows already past `expires_at`,
  by which point the token is refused on expiry anyway, so a pruned revocation can
  never revive a working key.
- **Play keys are node-local**, like sessions. The token pins the minting node's
  `NODE_ID`; presented to a peer it fails with a "wrong node" error rather than a
  bare 401. `media_play_keys` is deliberately absent from `REPLICATED_TABLES`.
- **Entitlement is re-checked per stream request**, not just at mint time, so
  revoking `can_watch_media` kills outstanding keys immediately.
- **Seeking depends on storage form.** An untransformed file is served with
  `Accept-Ranges: bytes`; encrypted/compressed/archived titles are reproduced from
  byte zero (`storage/streaming.ts`) and stream 200-only. `entries[].seekable`
  tells the client which is which.
- `content_blobs.media_width/height/duration_seconds` were never written by
  anything until now — `storage/mediaProbe.ts` fills them via ffprobe at publish
  time, keyed on the blob so dedup shares the result.

### Session management

- The `sessions` row holds: `id` (the signed cookie's sid), `user_id`, `csrf_token`, `created_at`, `last_seen_at`, `expires_at`, `ip_address`, `user_agent`. 24-hour TTL.
- `last_seen_at` updates at most once a minute per session, so an active client doesn't cause a write per request.
- Settings → Sessions tab: list active sessions, revoke one (password required), sign out everywhere.
- `GET /api/auth/sessions`, `DELETE /api/auth/sessions/:id`, `DELETE /api/auth/sessions`.

### Duplicate save prevention

- `files.saved_from_file_id` / `directories.saved_from_directory_id` record the origin when something is saved from a share link.
- The backend rejects (409) an owner saving their own item, or the same user saving the same item twice.
- The frontend disables the Save button and shows "Already saved" when the public info endpoint returns `already_saved: true`.

### Frontend API client

`client/src/config/api.ts` — typed `fetch` wrapper that prefixes `/api`, sends `credentials: "same-origin"`, attaches `X-CSRF-Token` to POST/PUT/PATCH/DELETE, and throws `ApiError` carrying the backend's `detail`. Upload progress needs `XMLHttpRequest`, so `filesService.ts` has its own XHR path that mirrors the same CSRF rules.

---

## Gotchas / invariants

Non-obvious rules that are easy to re-break. Each one has bitten this codebase already.

- **Wrap every `async` route handler in `asyncHandler`** (`middleware/asyncHandler.ts`). This is Express **4**, which does not await handlers — a rejected promise becomes an unhandled rejection and the request hangs forever with no response ever sent, rather than producing a 500.
- **`express.json()` runs with an explicit 8 MB limit**, not the 100 KB default, because `POST /api/torrents` accepts base64 `.torrent` payloads up to 2 MiB (base64 inflates 4/3). Keep the limit above `MAX_TORRENT_FILE_BYTES * 4/3`.
- **Deleting a user requires clearing every table that FKs to `users`** — `PRAGMA foreign_keys = ON` means a missed one throws instead of cascading. Currently: `permissions`, `sessions`, `credentials`, `files`, `directories`, `directory_collaborators` (both `user_id` and `invited_by_id`), `api_keys`, `dropbox_upload_links`, `remote_upload_jobs`, `torrent_jobs`, `media_play_keys`, and `cluster_nodes.created_by_id`.
- **`/account/reset` must not delete the user's `permissions` row** — that would silently reset an admin-assigned quota to the default. Reset purges *content*; only true account deletion purges identity.
- **Decrypt/decompress order depends on the producer.** `archived && !compressed` is `ZSTD(ENC(x))` (decompress, then decrypt); every other compressed+encrypted combination is `ENC(ZSTD(x))` (decrypt, then decompress). `routes/public.ts` and `storage/zip.ts` both branch on this — keep them in sync.
- **`TRUST_PROXY` must be set behind a TLS-terminating proxy.** Otherwise `req.protocol` stays `http` in prod and `httpsRedirect` 308s in an infinite loop.
- **Anything added to `permissions` or `users` must also be added to `cluster/replication.ts`'s `TABLE_COLUMNS`**, or the column silently resets to its default on every peer during replication.
- **A play key must never be trusted on a jti that isn't in `media_play_keys`.** Treating a missing row as valid would make the prune job a revocation-bypass.
- **Deleting a file must also call `deleteThumbnail(fileId)`** — the thumbnail cache is keyed by file id and is not reference-counted.
- **A debrid retry decides re-import vs. re-download by the `data/debrid/_sources/<tag>.complete` marker**, not by "the staging directory has files in it". A transfer aborted halfway also leaves files there, and importing those would silently store truncated content. The marker is written only after the last byte of the last link lands (`debrid.ts::markTransferComplete`), and lives outside the job directory so the importer never sees it as content.
- **Real-Debrid file paths are attacker-controlled** (they come out of the torrent): `debrid.ts` runs every one through `sanitizeSegment` + `safeJoin` before creating anything.
- **Don't add unbounded in-memory maps without a sweep.** Several registries (halt, login challenges, second-factor tickets, ws-token rate limiter) are process-local Maps that must prune expired entries or they grow forever.
- **`safeJoin()` every path built from user or DB input** before touching the filesystem.

---

## What NOT to do

- Don't run migrations — add nullable columns (or columns with a SQLite `DEFAULT`) plus an `ensureColumn` backfill
- Don't write an `async` Express handler without `asyncHandler`
- Don't scale this server to multiple processes without redesigning `cluster/eventBus.ts` sequencing
- Don't poll qBittorrent once per job — one list fetch per tick, grouped by tag
- Don't gate Real-Debrid on `instantAvailability` — uncached torrents are supposed to go through it too
- Don't `await` a Real-Debrid transfer inside the `torrent_poll` tick — it runs detached (`startDebridFetch`)
- Don't write API reference content into `ApiDocsPage.tsx` — it renders `docs/api.md`; edit the markdown
- Don't soft-delete API keys — hard delete them so they leave the admin panel immediately
- Don't wrap `DropdownMenuTrigger`'s `asChild` button in a `Tooltip` — it breaks click events
- Don't use `bg-brand-gradient/90` — opacity modifiers don't apply to CSS variable gradients
- Don't use `text-primary-foreground` on brand gradient backgrounds — use `text-white`

---

## File-specific notes

- `routes/public.ts` — public file info returns `uploader: {username, has_avatar, user_id} | null` (null when the link sets `hide_uploader`) and `already_saved: bool`. `/preview` and `/thumbnail` both refuse limited-use links so link budget can't be spent by a preview fetch.
- `routes/files.ts` — `serializeFiles()` batch-loads owner usernames *and* links to avoid N+1; `recoverAccessKey()` reconstructs the server-mode `?ek=` for the owner. Chunked uploads seal their session metadata into an AEAD token (no server-side session table); `uploadLocks` serializes finalize against abort.
- `routes/remoteUpload.ts` — resolves DNS, rejects private/local addresses, and connects to the *pinned* validated IP to close the rebinding window; re-validates every redirect hop; caps bytes mid-stream and decodes chunked transfer-encoding.
- `storage/zip.ts` — `safeArcname()` flattens paths and de-duplicates collisions; `memberSource()` resolves a row to plaintext bytes and is the file that has to know the transform-order rule.
- `torrents/debrid.ts` — `planFiles()` pairs `info.links[]` with the *selected* entries of `info.files[]` positionally; when the counts disagree (Real-Debrid splits very large torrents into RAR volumes, which are links with no matching file entry) it gives up on the mapping and names each download from its own unrestrict response instead. The transfer's only timeout is a **stall** timer — a legitimate multi-GB pull runs for hours, so idleness is what gets policed, not duration.
- `torrents/poller.ts` — `pollDebrid` uses the row's own `updated_at` as its last-polled clock rather than a side map, so there is no in-memory registry to prune. `startDebridFetch` guards against overlapping transfers with a module-level `Set` of job ids.
- `security/sessions.ts` — the cookie carries only a signed opaque sid; `resolve()` refreshes `last_seen_at` at most once a minute.
- `client/src/components/layout/UserMenu.tsx` — the collapsed sidebar trigger is a plain `Button`; wrapping it in a `Tooltip` breaks Radix DropdownMenu clicks.
- `client/src/features/files/components/Dropzone.tsx` — uses `bg-brand-gradient` and `text-white` for the reasons in "What NOT to do".
