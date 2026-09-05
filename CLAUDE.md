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

**Test both workspaces:**
```bash
bun run test
```

`client/tests/` are pure unit tests plus a few source-text design contracts;
`server/tests/` drive the **real** Express app over an in-memory SQLite database
via `server/tests/harness.ts` (`makeHarness` / `makeUser` / `makeDirectory` /
`makeFile`), so a failure means the route is wrong rather than a stub being
wrong. Both scripts pass `./tests` explicitly — a bare `bun test` from either
workspace globs the whole monorepo and runs the *other* workspace's tests with
the wrong cwd.

Config lives in `./data/app.env`, auto-generated on first run (mode `0600`).

**`app.env` and the process environment are one namespace** (`config.ts`).
Every key below can be given either way, and a variable set on the command
line, in a unit file or via a container's `-e` **wins** over the file — which
is what lets a value only known at launch be supplied at launch. `configValue()`
is the single resolver: environment → file → default. Two rules keep it safe:

- **The environment is never written back.** `generateFile` records an
  environment-supplied key as a `# KEY is set in this node's environment`
  comment rather than a value, and no backfill mints one. A persisted copy of
  an overlay is a second answer that silently takes over the day the variable
  is dropped — for `SECRET_KEY` that is every session invalidated, where the
  *absent* key is a loud startup error instead.
- **`setEnvValue` refuses an environment-supplied key** (`ConfigLockedError`, a
  409), so the admin panel can't persist a value the running process is
  ignoring. Every caller therefore persists *before* mutating `settings` in
  place, or a refusal would leave memory ahead of the file.

Keys outside `CONFIG_KEYS` are read from the environment only when `app.env`
already carries them — anything you can put in the file you can also set in the
environment, but a stray variable can't invent a value the app never had.
`FILEUPLOAD_CONFIG` is the one environment-only key: it names the file.
`index.ts` logs the overridden key *names* at startup (never values — several
are secrets).

Environment variables:

| Variable | Purpose |
|---|---|
| `APP_ENV` | `dev` (plain cookies, no HTTPS redirect) or `prod` (Secure cookies + HTTPS redirect). **Defaults to `prod`.** |
| `SECRET_KEY` | Session cookie signing key |
| `MASTER_KEY_B64` | base64 AES-256 key for server-side encryption and sealed tokens |
| `DATABASE_URL` | Default `sqlite:///./data/app.db` |
| `ALLOWED_HOSTS` | Comma-separated hostnames. Gates the WebAuthn relying-party ID and the HTTPS-redirect proxy-header trust. **Empty = unconfigured**, which logs a startup warning — set it in production. |
| `TRUST_PROXY` | `true` (generic reverse proxy) or `cloudflare` (prefer `CF-Connecting-IP`, and derive each session's region from `CF-IPCountry`). Required behind a TLS-terminating proxy, or every request 308-redirects to https forever. |
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
| `QBITTORRENT_SEEDING` | Keep finished torrents seeding after import (default `true`). Admin-managed from the Torrents tab. qBittorrent only — a Real-Debrid job has no local torrent to seed. |
| `QBITTORRENT_SEED_RATIO` | Share ratio at which a seeding torrent is removed and its downloaded copy deleted. Default `1.0`; `0` = no ratio limit. |
| `QBITTORRENT_SEED_MINUTES` | Same, by seeding time. Default `10080` (7 days); `0` = no time limit. Whichever limit hits first wins. |
| `TORRENT_CONTENT_PATH` | The same directory as **this server** sees it; only needed when qBittorrent is containerized separately (defaults to `QBITTORRENT_SAVE_PATH`) |
| `PORT` | Listen port, default `8000` |
| `LOG_LEVEL` | Python-style level name (`DEBUG`/`INFO`/`WARNING`/…), default `INFO` |
| `FILEUPLOAD_CONFIG` | Override the config file path (default `./data/app.env`). **Environment-only** — it names the file, so it can't come from it |
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
  config.ts                # Settings loader / generator for data/app.env, and the one
                           #   resolver (configValue) merging it with the environment
  bootstrap.ts             # First-run master user seed (only when `users` is empty)
  spa.ts                   # SPA serving: mtime-cached shell + og: meta injection,
                           #   static asset mounting, and the standalone HTML error page
  links.ts                 # Slug minting + atomic single-UPDATE link use consumption
  audit.ts                 # Hash-chained audit log (recordAudit / verifyAuditChain)
  logging.ts               # pino + in-memory ring buffer backing GET /api/admin/backend/logs
  outbound.ts              # fetchLogged/beginOutbound — one log line per request leaving
                           #   this process, with the URL redacted first
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
  directoryTree.ts         # Folder tree: MAX_DEPTH, ancestor/subtree walks, editor checks
  crypto/
    aead.ts                # Streaming chunked AES-256-GCM file container ("FUPL" magic)
    secretbox.ts           # Single-shot AES-256-GCM for key/access blobs + sealed upload tokens
    secretEncrypt.ts       # Versioned single-shot AEAD for tiny secrets (TOTP seeds)
    effectiveEncryption.ts # THE resolver: what key actually protects a row's bytes
    passwordKey.ts         # PBKDF2-HMAC-SHA256 (600k) for password-derived seal keys
  storage/
    paths.ts               # storageRoot/thumbnailRoot, safeJoin traversal guard, fan-out rel paths
    blobs.ts               # Content-addressed dedup + ref counting (attachBlob / releaseBlob)
    accounting.ts          # Quota + global cap + free-disk enforcement
    compress.ts            # zstd compress/decompress with zip-bomb guards
    zip.ts                 # safeArcname + memberSource (plaintext bytes for zip streaming)
    thumbnail.ts           # Cached JPEG thumbnails (sharp; ffmpeg for video frames)
    rekey.ts               # Byte rewrite behind the encryption-change endpoints
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
    drive/                 # The unified explorer: tree browsing, upload, move/rename,
                           #   multi-select, drag & drop, the encryption side panel
    files/                 # Upload core + options, link management, remote upload,
                           #   share modal (the old Files *page* lives in drive/ now)
    directories/           # Folder list, folder links modal, folder upload
    download/              # Public download page (/file/:slug)
    folder-view/           # Public folder view (/d/:slug)
    dropbox/               # Dropbox link management + public token-gated upload page
    apikeys/               # API key management UI
    torrents/              # Torrents page (add magnet/.torrent, live progress)
    cluster/               # Cluster dashboard (nodes, token, halts)
    admin/                 # Admin panel (users, files, keys, audit, storage, logs, torrents)
    media/                 # Media library: poster grid, player, publish + play-key UI
    api-docs/              # API reference page — renders docs/api.md, imported into the
                           #   bundle at build time (`@docs/api.md?raw`), not fetched
  components/
    layout/                # Sidebar, settings modal (sessions tab), top bar,
                           #   ErrorPage / NotFoundPage / RootErrorBoundary
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
                           #   GET /api/docs.md (for LLMs/tooling) and compiled into the
                           #   /api-docs page bundle. Editing it needs a client rebuild
                           #   for the page; the endpoint re-reads it on mtime change.
public/                    # Built client output, served by Express
data/                      # Runtime state: app.env, app.db, storage/, thumbnails/ (gitignored)
```

### Route mounts

Every data endpoint lives under `/api/*` so it can never collide with an SPA client-side route (`/files`, `/admin`, `/cluster` are both page routes and API prefixes).

| Mount | Router |
|---|---|
| `/api/auth` | `auth.ts` — login, MFA verify, logout, session list/revoke |
| `/api/account`, `/api/account/mfa` | `account.ts`, `mfa.ts` |
| `/api/oauth` | `oauth.ts` — `oauthRouter` (session-authenticated app management + consent) **and** `oauthPublicRouter` (`/token`, `/revoke`, `/userinfo`, `/metadata`), mounted at the same prefix |
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
6. **Enrolling a factor takes the current password, like removing one** (`POST /api/account/mfa/totp/setup` and `/webauthn/register/start` both require `current_password`; `mfa.ts::reauthenticated`). A stolen session cookie must not be able to add a passkey that outlives the victim's password change. Wrong answers feed the account lockout counter.

Failed logins feed `security/lockout.ts`, which counts per-username *and* per-IP within a rolling 15-minute window. **The TOTP step feeds the same counters** — a 6-digit code is guessable in a way a password is not, and the ticket's own 5-attempt cap is no defence when a fresh ticket costs one correct password. The username counter resets only in `issueSession`, i.e. once the *whole* ceremony succeeds; resetting it at the password step let a leaked password buy unlimited code guesses. Accepted TOTP codes are single-use: `credentials.totp_last_step` records the 30 s step of the last accepted code and anything at or before it is refused (`credentials.ts::markTotpUsed`).

### Database

- SQLite via `bun:sqlite` (no ORM, no Alembic). `db/schema.sql` runs on every boot as `CREATE TABLE/INDEX IF NOT EXISTS`.
- **Never use migrations.** Add nullable columns or columns with a `DEFAULT`, then add an `ensureColumn()` call in `db/sqlite.ts` — `CREATE TABLE IF NOT EXISTS` does nothing to an already-existing table, so new columns *only* land via `ensureColumn`.
- New indexes need no backfill: `CREATE INDEX IF NOT EXISTS` in `schema.sql` applies to existing databases on the next boot.
- Timestamps are ISO8601 UTC strings (`nowIso()`), not a dedicated column type. Comparisons are lexicographic string comparisons, which is why the format must stay fixed-width UTC.
- `PRAGMA foreign_keys = ON` and WAL journaling are both enabled in `db/sqlite.ts`.
- Columns dropped from a `db/rows.ts` interface are silently ignored — they remain in the DB.
- `db.get()` returns `undefined` on a miss. `bun:sqlite` itself returns `null`; the adapter normalizes it, so `=== undefined` is safe — but prefer `if (!row)` anyway.

### OAuth 2.0 authorization server

Third-party apps act *as* a fileupload user. `security/oauth.ts` holds the
primitives, `routes/oauth.ts` the endpoints, `middleware/deps.ts` the guards
(`requireOauthScope`, `requireScopeOrSession`, `optionalOauthViewer`).
Authorization-code flow with PKCE (S256 only); the consent page is the SPA route
`/oauth/authorize`.

- **A scope is never the last word on what a token may do.** Each scope in
  `SCOPES` names a permission flag, re-checked against the user's *live*
  permissions on every request — so revoking `can_upload` immediately neuters
  every outstanding token carrying `files:write`, with no token hunt.
- **Bearer values are routed by prefix**: `fuo_` = OAuth access token, `fur_` =
  refresh token, no prefix = API key. That is what lets one `Authorization`
  header serve two credential tables without probing both.
- **Codes and tokens are stored hashed.** A database read must not yield usable
  credentials.
- **A replayed authorization code or a reused refresh token revokes the whole
  grant**, not just the request — the safe reading of a replay is that the
  credential leaked.
- **`redirect_uri` is matched by exact string**, never by prefix or origin.
- **`pruneOauth` only deletes rows already past `expires_at`.** A revoked but
  unexpired row *is* the reuse-detection record; dropping it early would
  downgrade a replayed refresh token to a bare unknown-token error.
- **OAuth state is node-local**, like sessions and play keys: `oauth_clients`,
  `oauth_auth_codes` and `oauth_tokens` are deliberately absent from
  `REPLICATED_TABLES`. Registering an app on one node does not make it usable
  against a peer.
- Adding a scope means wiring it into the routes it is supposed to unlock, or an
  app gets granted something that silently does nothing.

### File storage

- Blobs live under `data/storage/` (override: `FILEUPLOAD_STORAGE`) at a random two-level fan-out path (`ab/cd/<rest>`), **not** a name derived from the upload.
- Storage is content-addressed and deduplicated: `attachBlob()` keys on `(stored_sha256, transform_key)` and bumps `ref_count` on a hit; `releaseBlob()` decrements and returns the physical path to unlink only when the last reference goes.
- Two different "used bytes" numbers exist and are not interchangeable:
  - `usedStorageBytes()` — `SUM(stored_size_bytes)` over `content_blobs`. Real disk consumption, post-dedup. Used for the global cap.
  - `usedStorageBytesForUser()` / `usedBytes()` — `SUM(size_bytes)` over that user's `files`. Logical, pre-dedup. Used for per-user quota, so dedup savings aren't silently handed to whoever uploaded second.
- Archived blobs are excluded from dedup matching — their on-disk bytes are zstd-wrapped and don't match the identity they were minted for.

### Folder tree

`directories.parent_directory_id` makes folders a tree, at most `MAX_DEPTH = 10`
levels deep (`server/src/directoryTree.ts`, which also owns `ancestorChain`,
`subtree`, `subtreeHeight`, `isSelfOrDescendant`, `nearestOverride`,
`directoryRole`/`isEditor` and `buildPathIndex`). A collaborator grant on a
folder applies to everything beneath it, because the permission check walks the
ancestor chain rather than looking at one row.

**One endpoint reads the tree: `GET /directories`.** Which read you get is
chosen by search parameters, never by path — browsing a level, walking a
subtree, listing everything reachable and searching are the same request with
different arguments:

| Param | Values | Meaning |
|---|---|---|
| `parent` | `root` (default) or an id | Where to look. Ignored when `scope=all`. |
| `scope` | `level` (default) · `subtree` · `all` | One level · everything beneath `parent` · every folder the caller can reach. |
| `q` | string | Case-insensitive substring over folder titles and file names, within `scope`. |
| `type` | `all` (default) · `directories` · `files` | Restrict the kind returned. |
| `limit` / `offset` | ints, limit caps at 500 | Paging, applied after filtering. |

The default (`scope=level`, no `q`) is the Drive explorer's per-level fetch and
is still **not** a recursive dump. Notes that are easy to re-break:

- `subtree()` in `directoryTree.ts` is *"at or below"* — it includes the folder
  you passed. The endpoint drops it, or a folder turns up among its own
  descendants and its files get counted twice.
- `type` is applied **while collecting, not after**. `scope=all&type=directories`
  is the folder picker's call; collecting every file first and discarding them
  would read the whole `files` table on every picker open.
- Folders can only be dropped *after* collection, because a subtree's file set
  is derived from them.
- Search results carry a `path` (the folder chain they were found at) built with
  `buildPathIndex` — one table read, never an ancestor walk per row.
- `serializeDirectories` runs a `COUNT(*)` per row, so it is only ever called on
  the **paged** slice.

### Encryption modes

| Mode | Description |
|---|---|
| `none` | No encryption. The link slug is the only credential. |
| `server` | AES-GCM encrypted at rest. `?ek=` query param gates download; the server decrypts before streaming. |
| `client` | E2E encrypted in the browser. Ciphertext stored server-side. The `#ek=` fragment never reaches the server. |
| `sealed` | Seal & Forget (files only). The server encrypted it, returned the key once, and kept no copy. Every read path treats it exactly like `client`. |

**Transform order matters and differs by producer** (see Gotchas): upload-time compression produces `ENC(ZSTD(x))` with `compressed = 1`; the archive job produces `ZSTD(ENC(x))` with `compressed = 0, archived = 1`.

### Encryption inheritance

`encryption_overridden` (on both `directories` and `files`) says whether a row
holds a key of its own. `0` means it inherits from the nearest ancestor with
`1` — a "break point" — and its own `enc_key_blob`/`enc_access_blob` columns are
NULL. A root-level folder is always a break point.

**Never read `enc_key_blob`/`enc_access_blob`/`encryption_mode` off a row for a
read path.** `crypto/effectiveEncryption.ts` (`resolveDirectoryEncryption`,
`resolveFileEncryption`) is the authority; `encryption_mode` survives on
inheriting rows only as a denormalized mirror, because plain SQL filters in
`jobs/lifecycle.ts`, `routes/admin.ts` and `storage/mediaProbe.ts` must not walk
a tree per row — so anything that changes an effective mode has to rewrite its
descendants' mirrors.

Changing a node's encryption (`PATCH /{directories,files}/:id/encryption`)
physically rewrites every affected descendant's bytes via
`storage/rekey.ts`, synchronously. `client`/`sealed` are refused there: the
server has no key, so that conversion is a browser-side
download-decrypt-reupload committed by `POST /files/:id/e2e-conversion`.

Public payloads carry a `key_scope` (`dir:7`, `file:34`) naming *which* secret
opens each node, because one shared subtree can contain several break points.

### Password locks

`access_is_password` records that a `server`-mode node's `?ek=` secret is an
owner-chosen password rather than a random 144-bit token. The secret is stored
identically either way; the flag exists because a human password is guessable,
so `security/accessLock.ts::checkLinkAccess` throttles public verification
**per link slug** (a distributed guesser would sail past an IP-keyed limit)
using `security/lockout.ts`'s `link_access` identifier type. Random-token links
are deliberately unthrottled — throttling them would let anyone lock a public
link out of service.

### Share links

- `links` (files) and `directory_links` (folders) have identical shapes: `slug`, `max_uses`, `use_count`, `expires_at`, `active`, `hide_uploader`.
- `hide_uploader` suppresses the uploader's name/avatar on the public page **and** in the API response.
- Multiple links per file, each with its own limits. Folder public URLs resolve via `directory_links.slug`, never `directories.slug`; a default folder link is auto-created at folder creation.
- A folder link covers a **subtree**. `/d/:slug/info`, `/preview-manifest` and `/zip` take `?dir=<id>`, bounded by `isSelfOrDescendant` — a node outside the link's own subtree answers 404, not 403, because a link must not confirm what exists elsewhere. `POST /d/:slug/unlock` proves a key for one node without starting a download.
- The zip and `POST /d/:slug/save` both recurse **only as far as the presented key reaches**: plaintext descendants are included, a descendant holding its own key is skipped. Including it would hand away the entire point of a break point.
- `directories.gallery_view` switches the public folder page from a file list to a gallery of poster tiles with inline players. Cosmetic only; read off the folder the *link* points at, so it doesn't change under a visitor mid-navigation. Unrelated to `is_library`, which is the global `/watch` catalog.
- Use consumption is a single atomic `UPDATE … WHERE … RETURNING id` (`links.ts::consumeUse`) so concurrent downloads can't overshoot `max_uses`.
- **One download is one use, however many requests it took.** `/file/:slug/raw` serves `Range` for untransformed blobs, so a chunked or resumed download is many requests; only the one covering byte zero consumes a use, stamps `last_downloaded_at` and writes the audit row (`isRangeStart` in `routes/public.ts`).
- **A limited-use link serves no ranges at all** (`rangesAllowed`): no `Accept-Ranges`, `Range` ignored, `200` with the whole body. Its budget is enforced per request, so honouring ranges would either spend it N ways or — with continuations free — hand out the whole file for `bytes=1-`. Same reasoning as `/preview` refusing limited-use links.

### Permissions

Defined in `server/src/permissions.ts` (`BOOL_FLAGS`) and mirrored in `client/src/config/permissions.ts`:

`can_upload` · `can_upload_client_encrypted` · `can_delete` · `can_regenerate_links` · `can_delete_links` · `can_create_directories` · `can_manage_lifecycle` · `can_use_api_keys` · `can_view_admin` · `can_manage_users` · `can_manage_storage` · `can_manage_api_keys` · `can_manage_cluster` · `can_use_torrents` · `can_watch_media` · `require_mfa` · `require_passkey`

The last two are *restrictions*, not capabilities: they force an account to
enrol a second factor (any, or a passkey specifically) and block it from every
route except the MFA enrolment endpoints until it does. They are deliberately
absent from `MASTER_ALL_TRUE` and the master seed — turning them on for every
admin by default would lock the panel out.

Plus the non-boolean `quota_bytes`, `max_file_bytes`, `archive_after_idle_days`. `master` bypasses every check.

Adding a flag means touching **all** of: `db/schema.sql`, an `ensureColumn` backfill in `db/sqlite.ts`, `db/rows.ts`, `permissions.ts` (`BOOL_FLAGS` + the master seed insert), `bootstrap.ts`, `MASTER_ALL_TRUE` in `routes/users.ts`, the `/account/me` payload in `routes/account.ts`, `TABLE_COLUMNS.permissions` in `cluster/replication.ts` (or it silently resets to the default on every peer), and `client/src/config/permissions.ts`.

### Admin panel

- Gated by `requireMaster`, except bulk actions, which also accept a non-master holding `can_view_admin` plus the specific flag for that action (`BULK_ACTION_PERMISSIONS`).
- Files and keys tabs group by owner username, alphabetically.
- Bulk actions require an exact `CONFIRM <n>` phrase matching the previewed candidate count. **A bulk action with no ids and no `owner_id` targets every matching row in the system** — that's intentional, and the confirmation phrase is the only guard — **for masters and holders of `can_manage_storage`.** Any other caller is pinned to their own rows (`admin.ts::requireBulkPermission` returns the `owner_id` the query must use): `archive_files`, `unarchive_files` and `delete_inactive_links` are gated by `can_manage_lifecycle` / `can_delete_links`, which are default-on user capabilities, so without the pin `can_view_admin` alone could archive every file on the server. `run_cleanup_jobs` has no per-owner form and is refused outright.
- API keys are hard-deleted, never soft-deleted, so they leave the panel immediately.
- `GET /api/audit` only verifies the hash chain when asked (`?verify=1`); it's an O(all rows) rehash, so it isn't run on every page load.

### Torrenting

Two backends, chosen per job. **Real-Debrid is preferred and qBittorrent is the fallback** — never the other way round. `torrent_jobs.provider` records which one owns a given job (`'debrid'` | `'qbittorrent'`), and every job of either kind ends at the same place: `finalizeStoredFile`, so quota, blob dedup, link minting and cluster replication behave exactly like a normal upload. Multi-file torrents land in a new folder named after the torrent; single-file torrents become a plain file. `source_type` is `torrent`.

`POST /api/torrents` (needs `can_use_torrents`) accepts a magnet or an uploaded `.torrent` and calls `debrid.ts::dispatchTorrent`, which decides the backend. Each job gets a unique tag (`fu-<hex>`) — for qBittorrent the tag (not the info hash) is how the poller finds the torrent again; for both providers it names the per-job download directory.

**Concurrency is a queue, not a refusal.** `MAX_ACTIVE_PER_USER = 5` (in
`torrents/poller.ts`) caps how many of one user's torrents run at once; a sixth
is accepted and parked in status `pending` with **nothing dispatched to any
backend**, and `promotePendingJobs` starts it from the `torrent_poll` tick as
soon as one of that user's slots frees. Per user, not global — one account
filling its own queue must not stall everyone else's. The only hard refusal is
`MAX_QUEUED_PER_USER = 50` (429), which bounds the backlog itself.

- **A pending job has no provider.** Which backend it lands on is decided at
  dispatch, minutes or hours later, so `provider` still holds its schema default
  and the route serializes it as `null` rather than reporting a guess.
- **Re-dispatch needs the source to survive the request.** A magnet is stored
  whole in `torrent_jobs.source` (**not truncated** — a clipped magnet is a dead
  one, and the Real-Debrid→qBittorrent fallback re-dispatches from this column
  too); an uploaded `.torrent`'s bytes go to the on-disk stash
  (`debrid.ts::stashSource`) at accept time, because the request body is the only
  copy and it is long gone by the time the queue gets there.
- **`started_at`, not `created_at`, is the poller's clock.** `MISSING_GRACE_MS`
  ("qBittorrent has never heard of this tag") runs from dispatch — measured from
  submission, an hour in the queue would blow the 3-minute grace the instant the
  job started. NULL on rows predating the queue, which fall back to `created_at`.

**Seeding (qBittorrent only).** With `QBITTORRENT_SEEDING` on, a finished
qBittorrent job moves to status `seeding` instead of `completed`: the import
already **copied** the files into blob storage, so the download is still on disk
and the torrent keeps uploading from it. `completed_at`, `imported_file_count`
and `progress` are all set at import time — the owner's wait is over either way.

- **A seeding job holds no concurrency slot.** It is absent from
  `IN_FLIGHT_STATUSES` on purpose: its files are imported, and a popular torrent
  must not block that user's next download for days.
- **The poller enforces the limits, qBittorrent only stops uploading.**
  `setShareLimits` is applied per torrent so it stops on its own if the poller
  never runs again, but qBittorrent's *share-limit action* is a global setting we
  don't control — so `pollSeedingJob` compares ratio/seeding-time itself and
  `finishSeeding` is what deletes the torrent, deletes the downloaded copy and
  settles the row to `completed`.
- **A missing torrent settles a seeding job, it does not fail it.** Removed by
  the operator or retired by qBittorrent's own action, the outcome is the same:
  the files were imported before seeding ever began.
- Seeding costs **no extra requests**: downloading and seeding jobs are both
  resolved out of the one `allTorrents` list already fetched per tick.
- Turning seeding off, or unconfiguring qBittorrent, retires every seeding job on
  the next tick rather than stranding it there with its download on disk.

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

- The `sessions` row holds: `id` (the signed cookie's sid), `user_id`, `csrf_token`, `created_at`, `last_seen_at`, `expires_at`, `ip_address`, `user_agent`, `country_code`. 24-hour TTL.
- `last_seen_at` updates at most once a minute per session, so an active client doesn't cause a write per request.
- `country_code` is Cloudflare's `CF-IPCountry`, read by `middleware/auth.ts::clientCountry`: ISO 3166-1 alpha-2, plus Cloudflare's two specials — `XX` (no country data for this client) and `T1` (client came out of the Tor network). It is recorded **once, at login**, so it describes where the session was started rather than drifting as the user moves.
  - **Trusted on exactly the same terms as `clientIp`**: `TRUST_PROXY=cloudflare`, or `TRUST_PROXY=true` *plus* a `CF-Ray` header proving the request really passed through Cloudflare. Any client can send `CF-IPCountry`, so reading it ungated would let a visitor pick their own country.
  - Nothing trustworthy to report ⇒ the column stays NULL. It is never filled with a guess.
  - `T1` is **not** an ISO code — never render it as a flag or look it up in a country table. The client's `regionLabel` spells both specials out in words.
- Expired rows are refused by `resolve()` and swept hourly by the `session_prune` job (`sessions.ts::pruneExpired`), which also drops inert `login_attempts` counters (`lockout.ts::pruneStale`). Neither changes anything a client can observe — it just stops the tables growing by a row per login forever.
- Settings → Sessions tab: list active sessions, revoke one (password required), sign out everywhere.
- `GET /api/auth/sessions`, `DELETE /api/auth/sessions/:id`, `DELETE /api/auth/sessions`.

### Duplicate save prevention

- `files.saved_from_file_id` / `directories.saved_from_directory_id` record the origin when something is saved from a share link.
- The backend rejects (409) an owner saving their own item, or the same user saving the same item twice.
- The frontend disables the Save button and shows "Already saved" when the public info endpoint returns `already_saved: true`.

### Frontend API client

`client/src/config/api.ts` — typed `fetch` wrapper that prefixes `/api`, sends `credentials: "same-origin"`, attaches `X-CSRF-Token` to POST/PUT/PATCH/DELETE, and throws `ApiError` carrying the backend's `detail`. Upload progress needs `XMLHttpRequest`, so `filesService.ts` has its own XHR path that mirrors the same CSRF rules.

### Serving the SPA, and what happens when it can't be served

`server/src/spa.ts` owns everything between a browser request and the built
client. `app.ts` calls `mountSpa(app)` once, after every `/api/*` router, and
the three HTML entry points (`/`, `/file/:slug`, `/d/:slug`) all go out through
`sendSpa`.

- **The shell is cached against its mtime+size**, not re-read per request. A
  `bun run build` is still picked up without a restart — the point of the
  original uncached read — but a hot public page no longer costs a synchronous
  `readFileSync`.
- **A request that looks like a file is a 404, not the shell.** `/assets/index-a1b2.js`
  after a deploy is a *missing chunk*; answering it with `index.html` and a 200
  hands the browser a page of HTML under a script content type, which surfaces
  as an unreadable syntax error instead of a 404 in the network tab.
- **An unknown `/api/*` path is `{detail: "not found"}` with a 404.** It never
  reaches the SPA fallback, so a typo'd endpoint can't come back 200 HTML.
- **HTML vs JSON is decided by `Accept`.** `sendErrorPage` renders the HTML
  error page for a browser navigation and the usual `{detail}` JSON for
  everything else, so `fetch()` and curl never get a page they can't parse.
- **The error page is standalone** — inline CSS, no script, no asset requests.
  It stands in for the bundle exactly when the bundle can't be trusted (no
  build → 503 with the `bun run build` hint, unknown URL → 404, thrown error on
  a page request → 500), so it must not depend on the thing it is replacing. Its
  palette duplicates `client/src/index.css`'s tokens on purpose.
- **Cache headers**: `assets/*` is content-hashed by Vite and goes out
  `immutable` for a year; the shell and everything else is `no-cache` (must
  revalidate, may 304). Getting this backwards makes a deploy invisible to an
  open tab.

Client-side, three components cover the same ground:
`components/layout/ErrorPage.tsx` (the presentational surface),
`NotFoundPage.tsx` (the router's `*` route — it shows the address that failed
rather than bouncing to `/`), and `RootErrorBoundary.tsx`, mounted above every
provider in `main.tsx`. The boundary special-cases a failed dynamic `import()`
as "a new version is available, reload" — that is a tab holding chunk names the
server no longer has, not a bug.

---

## Gotchas / invariants

Non-obvious rules that are easy to re-break. Each one has bitten this codebase already.

- **Wrap every `async` route handler in `asyncHandler`** (`middleware/asyncHandler.ts`). This is Express **4**, which does not await handlers — a rejected promise becomes an unhandled rejection and the request hangs forever with no response ever sent, rather than producing a 500.
- **`POST /upload/finalize` answers `202 {status: "finalizing"}` and does the work detached; the client polls the same endpoint.** Hashing a multi-GB upload is a minute or more, and no proxy holds a request open that long (nginx's `proxy_read_timeout` defaults to 60s, Cloudflare caps at 100s), so running it inline meant the connection reliably died *while the work went on to succeed* — the uploader saw a failure for a file that had been stored. Keep the split: every cheap, actionable check (token, missing chunks, assembled size, destination folder, permissions) stays **synchronous**, and only the unconditional per-byte work goes into `startFinalize`. A detached job has no request to throw into, so it must record its failures in the registry — otherwise a poller waits forever — and it must not read anything off `req` that dies with the socket (`clientIp` falls back to `req.socket.remoteAddress`; that's what `FinalizeOpts.requestOrigin` exists for).
- **Finalize is idempotent, and two orderings are what make it so.** The replay check runs **before** the `.parts` existence check (a successful finalize deleted that directory), and on the dropbox route **before the receive link is resolved** (a successful finalize marks the link used, so `resolveDropbox` 410s from then on — exactly how a stored 8 GB file came back to its uploader as a failure). The "upload incomplete" 409 must also stay distinguishable from a 202: one means send the missing chunks, the other means keep polling.
- **Digests run in workers; never fold them back onto the event loop.** A `for await` over `createReadStream` *looks* like it yields, but the read-ahead keeps the iterator's buffer full, so the digest loop runs as one uninterrupted block: 512 MB stalled the event loop for 4097 ms of a 4112 ms run, and nothing else in this process — login, download, cluster heartbeat, torrent poll — was served for the duration. Running it detached does not help, because a detached async function is still on this event loop; that is why `hashFile` dispatches to `storage/hashPool.ts` instead. The worker takes a *path*, so only a string and a hex digest cross the boundary and the offload is free. This does **not** conflict with the one-process invariant above: `worker_threads` share the process, so there is still one `app.listen()` and one `eventBus.ts` sequence counter — that rule is about forking, not threading. The one remaining inline hasher is `assembleChunks`, which folds digests into a copy it already has to make, and only runs for the legacy `.parts` layout.
- **Only sha256 and md5 are computed.** `content_blobs` still has `sha1` and `blake2b` columns and still replicates them, but nothing produces them any more — dedup keys on `stored_sha256`, and the other two only ever reached the API's `hashes` field. All four ran at 125 MB/s; the two kept run one-per-worker in parallel at 281 MB/s, md5 hiding behind sha256 for ~4%. `attachBlob` omits the two dead columns from its INSERT rather than writing `''`, and `fileHashes` reports only non-empty columns, so blobs minted before the change keep publishing the digests they actually hold.
- **Chunks are written straight to their offset in `<rel>.part`; `.parts/<i>` is a zero-byte marker.** That is what makes finalize a stat rather than a copy — concatenating the parts was a second full write *and* read of the whole upload. The marker is written only after the last byte lands, so a chunk that dies mid-transfer leaves unreferenced garbage that its retry overwrites. `isLegacyPartsLayout` catches sessions staged the old way (in flight across the deploy) and concatenates those.
- **Don't let the client abort an upload whose finalize is merely still running.** Those bytes are stored, or seconds from being stored. `lib/finalizePoll.ts` polls instead, and abort refuses an already-finalized upload rather than reporting success for a session it can't undo.
- **`express.json()` runs with an explicit 8 MB limit**, not the 100 KB default, because `POST /api/torrents` accepts base64 `.torrent` payloads up to 2 MiB (base64 inflates 4/3). Keep the limit above `MAX_TORRENT_FILE_BYTES * 4/3`.
- **Two header policies, never mixed.** `middleware/securityHeaders.ts` puts the page CSP (`default-src 'self'`, `frame-ancestors 'none'`, …) plus `Permissions-Policy` and COOP on *every* response. A route whose body is **uploaded bytes** — `/file/:slug/raw`, `/preview`, `/thumbnail`, the folder zip, media streams — overrides with `BYTES_HEADERS` (`default-src 'none'; sandbox; frame-ancestors 'self'`, `X-Frame-Options: SAMEORIGIN`). Serving uploaded bytes under the page policy is `script-src 'self'` on an attacker-supplied body: one missed entry in `UNSAFE_CT` becomes same-origin script. `SAMEORIGIN` is what lets the download page's PDF iframe render; the page default `DENY` blocked it. `UNSAFE_CT` (`routes/files.ts`) is the first wall — html/svg/xml/javascript types are stored as octet-stream — and the sandbox CSP the second.
- **The SPA fallback must never answer a path with a file extension.** It is a missing asset, and serving the shell for it turns a 404 into a 200 of HTML delivered as JavaScript. `mountSpa` in `spa.ts` is the only place this rule lives — see "Serving the SPA".
- **`mountSpa` goes after every API router, and the `/api` JSON 404 after it.** The fallback passes `/api/*` through untouched precisely so that 404 can answer in JSON; reordering the two makes unknown endpoints return HTML.
- **The server error handler branches on `res.headersSent`.** A streamed download that dies mid-body has no status left to set, so it destroys the socket instead of appending an error page to a half-written file.
- **Deleting a user requires clearing every table that FKs to `users`** — `PRAGMA foreign_keys = ON` means a missed one throws instead of cascading. Currently: `permissions`, `sessions`, `credentials`, `files`, `directories`, `directory_collaborators` (both `user_id` and `invited_by_id`), `api_keys`, `dropbox_upload_links`, `remote_upload_jobs`, `torrent_jobs`, `media_play_keys`, the three `oauth_*` tables (via
`routes/oauth.ts::purgeOauthForUser`, which clears both the apps they *own* and
the grants they were *issued*), and `cluster_nodes.created_by_id`.
- **`/account/reset` must not delete the user's `permissions` row** — that would silently reset an admin-assigned quota to the default. Reset purges *content*; only true account deletion purges identity.
- **Decrypt/decompress order depends on the producer.** `archived && !compressed` is `ZSTD(ENC(x))` (decompress, then decrypt); every other compressed+encrypted combination is `ENC(ZSTD(x))` (decrypt, then decompress). `routes/public.ts` and `storage/zip.ts` both branch on this — keep them in sync.
- **Compression is only kept when it actually saved something.** `shouldCompress` goes on the declared content type, which lies constantly (`application/octet-stream`, office documents, a `.tar` of already-compressed content), so `compressIfWorthwhile` samples the first 256 KiB and then re-checks the finished size against a 5% threshold; short of that it deletes its output and the caller stores the original bytes. Storing a barely-smaller copy is not neutral — `compressed = 1` costs the blob `Accept-Ranges` forever (`isDirectlyStreamable`), so every future read is reproduced from byte zero and loses seeking. Incompressible input measured at **1.00006×** through zstd: bigger on disk *and* slower to read.
- **Archiving a server-encrypted file compresses nothing, and no longer tries.** AES-GCM output is pseudorandom, so the idle-archive job's `ZSTD(ENC(x))` pass was a full read and write of every idle encrypted file to store it fractionally larger, non-streamable, reporting `archive_saved_bytes = 0` (the `Math.max(0, …)` was hiding a negative). Such files are now settled as `archived` untouched. The `ZSTD(ENC(x))` read path stays — files the old job already rewrote are still on disk.
- **The read path composes transforms as streams; it must not stage them to disk.** `decompressFromDecrypted` / `decryptFromDecompressed` chain `decryptStreamFrom` and `decompressGuarded` directly, so time-to-first-byte is constant. They used to write the whole intermediate into a temp directory first — an extra full-size write *and* read per download, on top of a TTFB that scaled with the file. `storage/zip.ts::memberSource` still needs one real file (zip seeks), but composes to reach it, so a compressed *and* encrypted member costs one temp copy rather than two.
- **`Readable.pipe()` does not forward errors.** `decompressGuarded` wires `input.on("error") → out.destroy(err)` and `out.on("close") → input.destroy()` by hand; without that, a source that fails mid-stream leaves the consumer awaiting a decompressor nothing will ever end, and an abandoned download leaks the source's file descriptor.
- **The blob dedup lookup is `(stored_sha256, transform_key)`, and needs `ix_content_blobs_stored`.** `ix_content_blobs_sha256` indexes the *plaintext* digest, which that query never filters on — without the compound index every upload full-scans `content_blobs`.
- **Server-side encryption defeats dedup entirely, by construction.** `encryptFile` draws a fresh random base nonce per call, so identical plaintext under the same folder key yields different ciphertext, a different `stored_sha256`, and a new blob every time. `server`-mode dedup ratio is 1.0 — known, not a bug to "fix" by making the nonce deterministic without thinking through what convergent encryption leaks.
- **Don't read `process.env` for a config key — go through `configValue()`.** A direct read skips `app.env`, which re-splits the one namespace `config.ts` exists to merge; a key resolved two ways is a key that answers differently depending on which module asks.
- **Persist config before applying it in memory.** `setEnvValue` throws `ConfigLockedError` when the environment supplies the key, so `settings.x = v; setEnvValue(...)` leaves the process holding a value the file refused.
- **`TRUST_PROXY` must be set behind a TLS-terminating proxy.** Otherwise `req.protocol` stays `http` in prod and `httpsRedirect` 308s in an infinite loop.
- **Anything added to `permissions` or `users` must also be added to `cluster/replication.ts`'s `TABLE_COLUMNS`**, or the column silently resets to its default on every peer during replication.
- **A play key must never be trusted on a jti that isn't in `media_play_keys`.** Treating a missing row as valid would make the prune job a revocation-bypass.
- **Deleting a file must also call `deleteThumbnail(fileId)`** — the thumbnail cache is keyed by file id and is not reference-counted.
- **A debrid retry decides re-import vs. re-download by the `data/debrid/_sources/<tag>.complete` marker**, not by "the staging directory has files in it". A transfer aborted halfway also leaves files there, and importing those would silently store truncated content. The marker is written only after the last byte of the last link lands (`debrid.ts::markTransferComplete`), and lives outside the job directory so the importer never sees it as content.
- **Real-Debrid file paths are attacker-controlled** (they come out of the torrent): `debrid.ts` runs every one through `sanitizeSegment` + `safeJoin` before creating anything.
- **Don't add unbounded in-memory maps without a sweep.** Several registries (halt, login challenges, second-factor tickets, ws-token rate limiter) are process-local Maps that must prune expired entries or they grow forever.
- **Outbound HTTP goes through `outbound.ts`, not a bare `fetch`.** `fetchLogged` (or `beginOutbound` where the transport isn't `fetch`, as in `remoteUpload.ts`) is what puts a request leaving this process in the same log buffer as inbound traffic. Healthy calls log at DEBUG so the 1s firehose poll and the 5s torrent poll don't flood the console, but the ring buffer keeps DEBUG regardless — so the admin log view sees them all. It also redacts the URL, which matters because unrestrict links, cluster blob URLs, `?ek=` and `?k=` all carry credentials and the buffer is admin-readable.
- **`safeJoin()` every path built from user or DB input** before touching the filesystem.
- **Never read a row's own `enc_key_blob`/`enc_access_blob`/`encryption_mode` on a read path** — an inheriting row's are NULL and its mode is only a mirror. Go through `crypto/effectiveEncryption.ts`. A missed path fails loudly ("encryption key not stored") rather than silently using a stale key, which is the point.
- **Only a caller that actually holds a folder's end-to-end key may upload into it.** `finalizeStoredFile` refuses a `client`/`sealed` destination unless the caller passes `clientCiphertext: true`, which only the two browser/API upload routes do. `encryptionMode: "client"` is *not* that claim — every server-side path copies its directory's mode into that field, so trusting it would let a dropbox link file an anonymous uploader's plaintext under a mode that promises ciphertext.
- **A play key, an `?ek=` and a `#ek=` are three different things.** `server` secrets travel as a query parameter and the server compares them; `client`/`sealed` keys travel in the fragment and must never reach the server.
- **An `ensureColumn` definition carries only the constraints it spells out.** A column added with `REFERENCES directories(id)` on an upgraded database has no `ON DELETE` action even if `schema.sql` says `ON DELETE SET NULL` — write the full clause in both places or deleting a referenced row throws.
- **Deleting a directory must clear every table that FKs to it** without a cascade: `files`, `directory_links`, `directory_collaborators`, `dropbox_upload_links`. `media_play_keys` cascades and `torrent_jobs` sets null, both by declaration.
- **A recursive walk over the folder tree needs a depth bound.** `MAX_DEPTH` is enforced on create and move, but corrupt or partially replicated data could still form a cycle; every walker in `directoryTree.ts` bails rather than spinning.
- **A promotion to break point must carry `access_is_password`, not just the key.** Moving an inheriting folder materializes the key it was resolving to; dropping the password flag silently turns a throttled human password into an unthrottled one.
- **The access-guess counter is keyed on the key scope, never on a link slug.** `/d/:slug/info` publishes every member file's slug, so a per-slug counter hands out one fresh guess budget per member against the same folder password.
- **Sealing takes the delete gate, not the edit gate.** `POST /files/:id/seal` is irreversible and leaves the file unreadable even to its owner, so it requires `can_delete` *and* ownership — an editor of the containing folder may move and rename, nothing more.
- **A folder created inside someone else's tree belongs to that tree's owner.** Otherwise an editor owns it, and `POST /directories/:id/collaborators` (owner-only by design) becomes re-delegatable.
- **Replicating a file must ship its whole ancestor chain**, root first. `parent_directory_id` is a real FK on a peer running `foreign_keys = ON`, and the containing folder's parent may never have been replicated.
- **Don't ancestor-walk per row in a listing.** `ancestorChain` costs a query per level; `buildPathIndex` reads the table once and resolves any number of rows in memory. The admin panel renders every file in the system.

---

## What NOT to do

- Don't run migrations — add nullable columns (or columns with a SQLite `DEFAULT`) plus an `ensureColumn` backfill
- Don't write an `async` Express handler without `asyncHandler`
- Don't send the SPA shell for a path with a file extension, and don't let the catch-all answer `/api/*`
- Don't commit a per-workspace `bun.lock` — `bun install` inside `client/`/`server/` resolves the root workspace lockfile, so a nested one is a stale second answer nothing reads
- Don't bounce an unknown client-side route to `/` — render `NotFoundPage`, or a dead share link looks like a normal visit
- Don't scale this server to multiple processes without redesigning `cluster/eventBus.ts` sequencing
- Don't poll qBittorrent once per job — one list fetch per tick, grouped by tag, covering downloading *and* seeding jobs
- Don't refuse a torrent for being over the concurrency limit — park it in `pending` and let `promotePendingJobs` start it
- Don't count `pending` toward `IN_FLIGHT_STATUSES` — that is the status a job sits in *because* it has no slot, so counting it deadlocks the queue
- Don't truncate a stored magnet — the queue and the qBittorrent fallback both re-dispatch from `torrent_jobs.source`
- Don't `cleanupJobDir` a seeding job — those bytes are what qBittorrent is uploading
- Don't gate Real-Debrid on `instantAvailability` — uncached torrents are supposed to go through it too
- Don't `await` a Real-Debrid transfer inside the `torrent_poll` tick — it runs detached (`startDebridFetch`)
- Don't write API reference content into `ApiDocsPage.tsx` — it renders `docs/api.md`; edit the markdown
- Don't put `CopyButton` (or any Radix-backed control) inside the `Markdown` renderer — `docs/api.md` has 100+ code blocks, and that many tooltip roots is what made the page jank
- Don't store a compressed copy without checking it shrank — an inflated blob also loses ranged reads permanently
- Don't serve uploaded bytes under the page CSP — set `BYTES_HEADERS` from `middleware/securityHeaders.ts` on any route whose body came from an upload
- Don't stage a transform to a temp file on the read path — compose `decryptStreamFrom` and `decompressGuarded` instead
- Don't soft-delete API keys — hard delete them so they leave the admin panel immediately
- Don't wrap `DropdownMenuTrigger`'s `asChild` button in a `Tooltip` — it breaks click events
- Don't use `bg-brand-gradient/90` — opacity modifiers don't apply to CSS variable gradients
- Don't use `text-primary-foreground` on brand gradient backgrounds — use `text-white`
- Don't offer `client` as a directory-level encryption choice for a *nested* folder — a child always inherits, and the backend rejects it
- Don't add a "convert this file to end-to-end" backend endpoint — going into or out of `client`/`sealed` is browser-side by construction
- Don't run `bunx biome` and assume you got the formatter: that resolves to an unrelated package. It is `bunx --bun @biomejs/biome`

---

## File-specific notes

- `crypto/effectiveEncryption.ts` — `sourceDirectoryId` is only set when the resolver actually *walked*; `ownerDirectoryId` is the one to compare when you need "which node holds this key", including when a file inherits straight from its own folder.
- `routes/public.ts` — public file info returns `uploader: {username, has_avatar, user_id} | null` (null when the link sets `hide_uploader`) and `already_saved: bool`. `/preview` and `/thumbnail` both refuse limited-use links so link budget can't be spent by a preview fetch.
- `routes/files.ts` — `serializeFiles()` batch-loads owner usernames *and* links to avoid N+1; `recoverAccessKey()` reconstructs the server-mode `?ek=` for the owner. Chunked uploads seal their session metadata into an AEAD token (no server-side session table); `uploadLocks` serializes finalize against abort. `receiveChunkAt()` writes each chunk at its final offset so finalize has nothing to assemble, and `finalizeStoredFile` skips the stored-side rehash when nothing transformed the bytes; what's left is one hash pass, run detached **and off the event loop** (`storage/hashPool.ts`). Measured on 6.4 GB: the finalize request returns in ~6 ms and the background work takes ~23 s, against ~310 s inside the request before.
- `routes/remoteUpload.ts` — resolves DNS, rejects private/local addresses, and connects to the *pinned* validated IP to close the rebinding window; re-validates every redirect hop; caps bytes mid-stream and decodes chunked transfer-encoding.
- `storage/zip.ts` — `safeArcname()` flattens paths and de-duplicates collisions; `memberSource()` resolves a row to plaintext bytes and is the file that has to know the transform-order rule.
- `torrents/debrid.ts` — `planFiles()` pairs `info.links[]` with the *selected* entries of `info.files[]` positionally; when the counts disagree (Real-Debrid splits very large torrents into RAR volumes, which are links with no matching file entry) it gives up on the mapping and names each download from its own unrestrict response instead. The transfer's only timeout is a **stall** timer — a legitimate multi-GB pull runs for hours, so idleness is what gets policed, not duration.
- `torrents/poller.ts` — `pollDebrid` uses the row's own `updated_at` as its last-polled clock rather than a side map, so there is no in-memory registry to prune. `startDebridFetch` guards against overlapping transfers with a module-level `Set` of job ids. `promotePendingJobs` reads every owner's slot usage in **one** grouped query, not a `COUNT` per candidate, and increments its in-memory tally *before* awaiting dispatch — the same owner's next pending job is decided in that same loop. `seedLimitReached` compares against a strictly positive limit because qBittorrent reports `ratio` as `-1` before anything has been uploaded.
- `security/sessions.ts` — the cookie carries only a signed opaque sid; `resolve()` refreshes `last_seen_at` at most once a minute.
- `client/src/features/download/lib/downloadCore.ts` — the read-side mirror of `files/lib/uploadCore.ts`: same worker-slot pool, same AIMD concurrency, same per-chunk retry, pulling byte ranges instead of pushing them. It asks for chunk 0 with a `Range` and lets the **answer** decide: a 206 gives it the total from `Content-Range` and it plans the rest; a 200 means the server declined and that response is already the whole file, so the fallback costs no extra request. Nothing client-side needs to know about `max_uses` or storage transforms. Every later chunk's `Content-Range` total is compared against the first, since stitching chunks from two different blobs would corrupt the file undetectably. Reached through `publicService.fetchRawChunked`, which stays on a single stream below 16 MiB.
- `client/src/components/layout/UserMenu.tsx` — the collapsed sidebar trigger is a plain `Button`; wrapping it in a `Tooltip` breaks Radix DropdownMenu clicks.
- `client/src/features/files/components/Dropzone.tsx` — uses `bg-brand-gradient` and `text-white` for the reasons in "What NOT to do".
