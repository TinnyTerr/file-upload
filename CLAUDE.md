# CLAUDE.md — fileupload project guide

## Overview

Self-hosted file sharing with E2E encryption, folders, share links, API keys, dropboxes, torrenting, multi-node clustering and an admin panel. Bun + Express backend (`server/`), React + TypeScript frontend (`client/`).

The old Python/FastAPI backend (`app/`) is **deleted**. Comments saying "Mirrors `app/routes/x.py`" are historical lineage — don't look for `app/`. Every route is ported; every flag in `client/src/config/featureFlags.ts` is `true`.

### Cluster subsystem (`server/src/cluster/*.ts`)

- `membership.ts` — join/heartbeat/enroll, full-mesh peers
- `election.ts` — elected, epoch-versioned leadership, layered *under* replication
- `replication.ts` — announce-id row replication (reserve/replicate/export) + rebase-from-master fallback
- `blobs.ts` — content-addressed blob fetch-on-miss from peers (read-time failover for `routes/public.ts`)
- `cacheEviction.ts` — LRU eviction for `REPLICATION_MODE=cache`; verifies durability on a full-replica peer first
- `halt.ts` — in-memory TTL'd upload halt registry (user + global), gossiped over the firehose
- `digest.ts` — state digest, drift detection, split-brain cross-check (`syncCheckJob`)
- `eventBus.ts` / `eventStore.ts` / `firehoseClient.ts` — live bus, durable `cluster_events` mirror, peer-polling consumer
- `http.ts` — node-to-node fetch helpers (cluster-token auth, timeouts)
- `activity.ts` — tracer behind Cluster → Activity (`WS /api/ws/cluster-activity`, `can_manage_cluster`). **Pay-per-watch:** with no subscriber `begin()` returns a shared no-op; only per-job stats are always kept. Jobs, outbound peer calls and authenticated inbound peer calls are spans. "Touches" are static per job/endpoint, not measured. A new scheduler job needs a `touches` list.

`routes/cluster.ts` exports `clusterRouter` (`/api/cluster`: session-auth management **plus** cluster-token node-to-node endpoints) and `adminClusterRouter` (`/api/admin/cluster`: node-logs + HTTP long-poll fallback). `ws.ts` attaches the websocket firehose to the `http.Server` from `app.listen()` in `index.ts`.

**Invariant:** `eventBus.ts`'s in-memory sequence counter assumes **one process per node** (single `app.listen()`, no forked workers). Colliding `origin_seq` broke logins under `uvicorn --workers=4` before — see `cluster_events` `UNIQUE(origin_node_id, origin_seq)`. Don't multi-process without redesigning event sequencing.

---

## Tech stack

| Layer | Technology |
|---|---|
| Backend | Bun + **Express 4**, `bun:sqlite` (no migrations) |
| Frontend | React 19, TS, TanStack Query, Tailwind v4, Radix UI |
| Auth | Cookie sessions (`fu_session`) + CSRF (`fu_csrf_token` in localStorage); optional TOTP / WebAuthn |
| Crypto | AES-256-GCM server-side (`crypto/aead.ts`), WebCrypto client-side E2E (`client/src/workers/`) |
| Compression | zstd via `node:zlib` (`createZstdCompress`) |
| Scheduling | `jobs/scheduler.ts` — plain `setInterval`, no cron lib |
| Torrenting | Real-Debrid REST 1.0 (preferred), qBittorrent WebUI v2 (fallback) — `server/src/torrents/*` |
| Images | `sharp` thumbnails, optional external `ffmpeg` for video frames |

---

## Running

```bash
bun install        # both workspaces
bun run start      # build client → public/, run server on :8000
bun run dev        # Vite :5173 (proxies API) + Express :8000
bun run typecheck  # both workspaces
bun run test       # both workspaces
bun run test:coverage  # table + {client,server}/coverage/lcov.info (gitignored)
```

`client/tests/` are pure unit tests plus a few source-text design contracts; `server/tests/` drive the **real** Express app over in-memory SQLite via `server/tests/harness.ts` (`makeHarness`/`makeUser`/`makeDirectory`/`makeFile`). Both scripts pass `./tests` explicitly — a bare `bun test` globs the whole monorepo and runs the other workspace's tests with the wrong cwd.

Formatter: `bunx --bun @biomejs/biome format --write .` (plain `bunx biome` resolves to an unrelated package).

**Releases are automatic.** `.github/workflows/release.yml` runs after CI passes on `main`: `scripts/release.ts` reads commit titles since the last `v*` tag (`feat` → minor, `!:`/`BREAKING` → major, else patch), bumps the three `package.json` versions, commits `release vX.Y.Z`, tags, and creates a GitHub release with the titles as notes. It then builds the client with `BUILD_SHA` = the release commit (uploads source maps, creates Sentry release `fileupload@X.Y.Z+<sha>`) and attaches `public.tar.gz`. Needs secrets `SENTRY_AUTH_TOKEN`, `SENTRY_DSN_WEB`, vars `SENTRY_ORG`, `SENTRY_PROJECT_WEB`. `bun scripts/release.ts` is a dry run. Desktop releases are separate (`desktop-v*` tags; secret `SENTRY_DSN_DESKTOP`).

### Config

Lives in `./data/app.env`, auto-generated on first run (mode `0600`). **`app.env` and the process environment are one namespace** (`config.ts`): environment → file → default, resolved only by `configValue()`.

- **The environment is never written back.** `generateFile` records an env-supplied key as a `# KEY is set in this node's environment` comment, and no backfill mints one. A persisted overlay silently takes over the day the variable is dropped (for `SECRET_KEY`: every session invalidated).
- **`setEnvValue` refuses an env-supplied key** (`ConfigLockedError`, 409). Persist *before* mutating `settings` in place.
- Keys outside `CONFIG_KEYS` are read from the environment only if `app.env` already carries them. `FILEUPLOAD_CONFIG` is the one environment-only key (it names the file).
- `index.ts` logs overridden key *names* at startup, never values.

| Variable | Purpose |
|---|---|
| `APP_ENV` | `dev` (plain cookies, no HTTPS redirect) or `prod` (Secure cookies + redirect). **Default `prod`.** |
| `SECRET_KEY` | Session cookie signing key |
| `MASTER_KEY_B64` | base64 AES-256 key for server-side encryption and sealed tokens |
| `DATABASE_URL` | Default `sqlite:///./data/app.db` |
| `ALLOWED_HOSTS` | Comma-separated hostnames; gates WebAuthn RP ID and HTTPS-redirect proxy trust. Empty logs a startup warning. |
| `TRUST_PROXY` | `true` or `cloudflare` (prefer `CF-Connecting-IP`, derive session region from `CF-IPCountry`). Required behind a TLS-terminating proxy or every request 308s forever. |
| `NODE_ID` / `NODE_NAME` / `NODE_URL` | Cluster identity and advertised base URL |
| `NODE_ROLE` | Bootstrap role on *first ever* boot only; afterwards the elected role in `cluster_self_state` wins |
| `MASTER_URL` / `MASTER_TOKEN` | Coordinates a non-master auto-joins at startup |
| `CLUSTER_TOKEN` | Shared bearer for node-to-node endpoints |
| `REPLICATION_MODE` | `full` (default) or `cache` |
| `CACHE_MAX_BYTES` | Cache-mode eviction cap; `0`/unset = never evict |
| `ARCHIVE_ENABLED` | Advertised to peers; gates archive participation |
| `REALDEBRID_API_KEY` | Set from admin Torrents tab (validated against `GET /user`). Empty = all torrents go to qBittorrent. |
| `REALDEBRID_ENABLED` | Kill switch (default `true`); `false` keeps the token but routes to qBittorrent |
| `QBITTORRENT_URL` / `_USERNAME` / `_PASSWORD` | Host WebUI. Empty *and* no RD token = torrenting disabled |
| `QBITTORRENT_SAVE_PATH` | Download location as **qBittorrent** sees it |
| `QBITTORRENT_SEEDING` | Keep finished torrents seeding after import (default `true`) |
| `QBITTORRENT_SEED_RATIO` | Ratio at which a seeding torrent is removed (default `1.0`; `0` = none) |
| `QBITTORRENT_SEED_MINUTES` | Same by time (default `10080`; `0` = none). First limit hit wins. |
| `TORRENT_CONTENT_PATH` | Same dir as **this server** sees it; only when qBittorrent is containerized separately |
| `PORT` | Default `8000` |
| `LOG_LEVEL` | `DEBUG`/`INFO`/`WARNING`/…, default `INFO` |
| `FILEUPLOAD_CONFIG` / `_STORAGE` / `_THUMBNAILS` / `_DEBRID` | Override config file / blob root (`./data/storage`) / thumbnail root (`./data/thumbnails`) / RD staging root (`./data/debrid`) |

### Sentry

One DSN per surface in repo-root `.env` (see `.env.example`): `SENTRY_DSN_WEB` (baked into client via `define` in `client/vite.config.ts`), `SENTRY_DSN_DESKTOP` (webview + Rust via `build.rs`), `SENTRY_DSN_SERVER` (`server/src/sentry.ts`, imported first in `index.ts`). Blank = off. Every server ERROR log record becomes an event (`logging.ts` sink). Don't add a path that ships request bodies or cookies.

- **Release = commit:** `fileupload@<version>+<short sha>` (`server/src/version.ts::SENTRY_RELEASE`; `vite.config.ts` computes the same; `BUILD_SHA` overrides with no checkout). With `SENTRY_AUTH_TOKEN`+`SENTRY_ORG`+`SENTRY_PROJECT_WEB` the build uploads source maps (emitted `hidden`, deleted after) and runs `setCommits`; without them the build is offline.
- **Traces:** server renames the root `http.server` span to the route pattern (`middleware/sentryTracing.ts`); `sqlite.ts` wraps `run/get/all` in `db.query` spans via `dbSpan` (statement text only, never params, only during a trace); `tracesSampler` drops firehose/health/ws/asset paths. Client propagates to this origin only.
- **Replay:** everything masked/blocked; nothing recorded on `/file/*`, `/d/*`, `?receive=` (URLs are credentials).
- **Feedback:** `autoInject: false`; opened from the user menu.
- **Logs/crons:** WARNING records forwarded as Sentry logs; scheduler jobs ≥ 1 min wrapped in `Sentry.withMonitor`.
- **User** is the numeric id only.
- **Every URL-shaped string is scrubbed** (`scrubPath` server, `lib/scrubUrl.ts` client): `/file/<slug>`, `/d/<slug>`, dropbox tokens, `?ek= ?k= ?receive=`, `#fragment` — spans, logs, breadcrumbs, transaction names. A new Sentry feature that records URLs needs the same.
- **CSP:** `connect-src` admits the `SENTRY_DSN_WEB` origin (`securityHeaders.ts::pageCsp`); a new transport (e.g. tunnel) means revisiting it.

---

## Project structure

```
server/src/
  index.ts          # entrypoint: config, db, seed master, workers, listen
  app.ts            # Express factory: middleware order, route mounting, SPA, error handler
  appState.ts       # AppState (settings, db, sessionManager, lockout, clusterToken, eventBus, eventWriter, haltRegistry, loginChallenges, secondFactorTickets)
  config.ts         # app.env loader/generator + configValue resolver
  bootstrap.ts      # first-run master seed (only when `users` is empty)
  spa.ts            # SPA serving, og: meta injection, standalone HTML error page
  links.ts          # slug minting + atomic link-use consumption
  audit.ts          # hash-chained audit log
  logging.ts        # pino + ring buffer behind GET /api/admin/backend/logs
  outbound.ts       # fetchLogged/beginOutbound — logged, URL-redacted outbound requests
  httpError.ts      # HttpError, rendered as {detail}
  ws.ts             # websocket firehose
  db/               # schema.sql (run every boot), sqlite.ts (adapter + ensureColumn), backfill.ts, types.ts, rows.ts
  security/         # sessions, csrf, passwords (Argon2id), lockout, apiKeys, credentials (TOTP/WebAuthn),
                    #   webauthn, loginChallenges, secondFactorTickets, oauth, accessLock
  middleware/       # asyncHandler (REQUIRED on async routes), auth, deps, securityHeaders,
                    #   requestLogging, httpsRedirect, deny, sentryTracing
  directoryTree.ts  # folder tree: MAX_DEPTH, ancestor/subtree walks, editor checks
  crypto/           # aead (chunked AES-GCM "FUPL"), secretbox, secretEncrypt, effectiveEncryption (THE key resolver), passwordKey
  storage/          # paths (safeJoin), blobs (dedup/refcount), accounting, compress, zip, thumbnail,
                    #   rekey, streaming, mediaProbe, hashPool
  cluster/          # see above
  jobs/             # lifecycle.ts (archive/idle/expiry sweeps), scheduler.ts
  media/playKeys.ts # sealed play-key tokens + revocation list
  torrents/         # realdebrid, debrid, qbittorrent, poller, importer
  routes/           # one file per surface

client/src/
  features/         # auth, account, drive (unified explorer), files, directories, download (/file/:slug),
                    #   folder-view (/d/:slug), dropbox, apikeys, torrents, cluster, admin, media, api-docs
  components/       # layout/ (Sidebar, settings modal, ErrorPage/NotFoundPage/RootErrorBoundary), ui/ (Radix design system)
  workers/          # aead.worker.ts + fuplCore.ts — client E2E off the main thread
  lib/  config/ (api.ts, featureFlags.ts, navigation.ts, permissions.ts)  providers/

docs/api.md         # THE public API reference; served raw at GET /api/docs.md and compiled into /api-docs
                    #   (client rebuild needed for the page; endpoint re-reads on mtime)
public/             # built client output
data/               # runtime state (gitignored)
```

### Route mounts

Every data endpoint is under `/api/*` so it never collides with SPA routes.

| Mount | Router |
|---|---|
| `/api/auth` | `auth.ts` — login, MFA verify, logout, sessions |
| `/api/account`, `/api/account/mfa` | `account.ts`, `mfa.ts` |
| `/api/oauth` | `oauth.ts` — `oauthRouter` (session-auth app mgmt + consent) and `oauthPublicRouter` (`/token`, `/revoke`, `/userinfo`, `/metadata`) |
| `/api/files`, `/api/links`, `/api/admin/files` | `files.ts` (+ `remoteUpload.ts` on `/api/files`) |
| `/api/keys`, `/api/admin/keys` | `keys.ts` |
| `/api/users`, `/api/audit`, `/api/admin` | `users.ts`, `audit.ts`, `admin.ts` |
| `/api/torrents`, `/api/admin/torrents` | `torrents.ts` |
| `/api/media` | `media.ts` |
| `/api/cluster`, `/api/admin/cluster` | `cluster.ts` |
| `/api` (self-prefixed) | `directories.ts`, `dropbox.ts`, `docs.ts`, `public.ts` (`/file/:slug*` data), public folder data (`/d/:slug*`) |
| *(unprefixed, before `mountSpa`)* | `public.ts::publicPageRouter` (`GET /file/:slug`), `directories.ts::publicDirectoryPageRouter` (`GET /d/:slug`) — browser-facing share URLs, so OG/twitter meta is reachable by link-preview crawlers |

---

## Key patterns

### Authentication

- HMAC-signed `fu_session` cookie (HTTP-only, `SameSite=strict`); session row incl. CSRF token lives server-side.
- CSRF token returned at login, kept in localStorage `fu_csrf_token`, sent as `X-CSRF-Token` on mutations. `requireCsrf` needs `requireSession` to have run first.
- `Authorization: Bearer` API keys bypass CSRF; keys bind to first-seen IP.
- Roles: `master` (bypasses all permission checks) and `user`.
- `must_change_credentials` accounts are rejected by `requireActiveUser` (403) but reach `/api/account/change-credentials`.

### Login + second factor

1. `POST /api/auth/login` verifies the password. If the user has credentials **and** MFA is enforced (`mfa_required`, or role `master`) it returns `{status: "mfa_required", mfa_ticket, methods}`.
2. The ticket (`secondFactorTickets.ts`) is single-use, 2-min TTL, 5-attempt cap, and *not* proof of auth.
3. `POST /api/auth/totp/verify-login` or the WebAuthn login pair issues the session.
4. Usernameless WebAuthn (`/api/auth/webauthn/login/start|finish`) skips step 1. **When the passkey is the whole login it must be user-verified** (`userVerification: "required"`); as a second factor (a `conn_id` in `awaiting_second_factor`) it stays `preferred` so PIN-less keys work (`auth.ts::isSecondFactor`, `security/webauthn.ts`).
5. `GET /api/auth/ws-token` mints a short-lived `conn_id` for the pre-login websocket. It is a transport correlation id **only**, never authorization.
6. **Enrolling a factor takes the current password** (`/api/account/mfa/totp/setup`, `/webauthn/register/start`; `mfa.ts::reauthenticated`), so a stolen cookie can't add a passkey that outlives a password change. Wrong answers feed lockout.

`lockout.ts` counts failures per-username *and* per-IP in a rolling 15-min window. **The TOTP step feeds the same counters.** The username counter resets only in `issueSession` (whole ceremony done) — resetting at the password step let a leaked password buy unlimited code guesses. Accepted TOTP codes are single-use (`credentials.totp_last_step`, `markTotpUsed`).

### Database

- `bun:sqlite`, no ORM. `db/schema.sql` runs every boot as `CREATE ... IF NOT EXISTS`.
- **Never use migrations.** Add nullable/`DEFAULT` columns, then an `ensureColumn()` call in `db/sqlite.ts` — `CREATE TABLE IF NOT EXISTS` does nothing to an existing table. New indexes need no backfill.
- **An `ensureColumn` definition carries only the constraints it spells out** — write the full `REFERENCES … ON DELETE …` clause in both places or deleting a referenced row throws.
- Timestamps are fixed-width ISO8601 UTC strings (`nowIso()`); comparisons are lexicographic.
- `foreign_keys = ON`, WAL on.
- Columns dropped from a `rows.ts` interface stay in the DB.
- `db.get()` returns `undefined` on a miss (adapter normalizes); prefer `if (!row)`.

### OAuth 2.0 authorization server

Third-party apps act *as* a user. Primitives in `security/oauth.ts`, endpoints `routes/oauth.ts`, guards in `middleware/deps.ts` (`requireOauthScope`, `requireScopeOrSession`, `optionalOauthViewer`). Auth-code flow, PKCE S256 only; consent page is SPA route `/oauth/authorize`.

- **A scope is never the last word.** Each scope names a permission flag re-checked against *live* permissions every request.
- **Bearer routed by prefix:** `fuo_` access token, `fur_` refresh token, none = API key.
- Codes and tokens are stored hashed.
- **A replayed code or reused refresh token revokes the whole grant.**
- `redirect_uri` matched by exact string.
- **`pruneOauth` only deletes rows past `expires_at`** — a revoked-but-unexpired row is the reuse-detection record.
- **Node-local:** `oauth_clients`, `oauth_auth_codes`, `oauth_tokens` are absent from `REPLICATED_TABLES`.
- A new scope must be wired into the routes it unlocks.

### File storage

- Blobs under `data/storage/` at a random two-level fan-out path (`ab/cd/<rest>`), not derived from the upload.
- Content-addressed and deduped: `attachBlob()` keys on `(stored_sha256, transform_key)`, bumping `ref_count`; `releaseBlob()` returns the path to unlink only on the last reference.
- Two "used bytes" numbers: `usedStorageBytes()` = `SUM(stored_size_bytes)` over `content_blobs` (real disk, global cap); `usedStorageBytesForUser()`/`usedBytes()` = `SUM(size_bytes)` over the user's `files` (logical, per-user quota, so dedup savings aren't handed to whoever uploaded second).
- Archived blobs are excluded from dedup matching.

### Folder tree

`directories.parent_directory_id`, max `MAX_DEPTH = 10` (`directoryTree.ts`, which owns `ancestorChain`, `subtree`, `subtreeHeight`, `isSelfOrDescendant`, `nearestOverride`, `directoryRole`/`isEditor`, `buildPathIndex`). A collaborator grant applies to everything beneath because permission checks walk the ancestor chain.

**One endpoint reads the tree: `GET /directories`**, selected by search params:

| Param | Values | Meaning |
|---|---|---|
| `parent` | `root` (default) or id | Where to look; ignored for `scope=all` |
| `scope` | `level` (default) · `subtree` · `all` | One level · beneath `parent` · every reachable folder |
| `q` | string | Case-insensitive substring over folder titles and file names, within `scope` |
| `type` | `all` (default) · `directories` · `files` | Restrict kind |
| `limit`/`offset` | ints, limit ≤ 500 | Paging after filtering |

Default (`level`, no `q`) is the explorer's per-level fetch, not a recursive dump. Easy to re-break:

- `subtree()` is "at or below" — the endpoint drops the passed folder or its files count twice.
- `type` is applied **while collecting**; `scope=all&type=directories` (folder picker) must not read the whole `files` table.
- Folders drop only *after* collection (a subtree's file set derives from them).
- Search results carry a `path` built with `buildPathIndex` (one table read).
- `serializeDirectories` does a `COUNT(*)` per row — call it only on the paged slice.

### Encryption modes

| Mode | Description |
|---|---|
| `none` | Slug is the only credential |
| `server` | AES-GCM at rest; `?ek=` gates download, server decrypts before streaming |
| `client` | E2E in browser; `#ek=` fragment never reaches the server |
| `sealed` | Seal & Forget (files only): server encrypted, returned the key once, kept no copy. Read paths treat it like `client`. |

Transform order differs by producer: upload-time compression gives `ENC(ZSTD(x))`, `compressed = 1`; the archive job gives `ZSTD(ENC(x))`, `compressed = 0, archived = 1`.

### Encryption inheritance

`encryption_overridden` (on `directories` and `files`) says whether a row holds its own key. `0` = inherits from the nearest ancestor with `1` (a "break point") and its `enc_key_blob`/`enc_access_blob` are NULL. A root-level folder is always a break point.

**Never read `enc_key_blob`/`enc_access_blob`/`encryption_mode` off a row on a read path** — use `crypto/effectiveEncryption.ts` (`resolveDirectoryEncryption`, `resolveFileEncryption`). `encryption_mode` on inheriting rows is only a denormalized mirror for plain-SQL filters (`jobs/lifecycle.ts`, `routes/admin.ts`, `storage/mediaProbe.ts`), so anything changing an effective mode must rewrite descendants' mirrors. A missed path fails loudly ("encryption key not stored").

`PATCH /{directories,files}/:id/encryption` physically rewrites affected descendants synchronously via `storage/rekey.ts`. `client`/`sealed` are refused there (server has no key): that's a browser-side download-decrypt-reupload committed by `POST /files/:id/e2e-conversion`.

Public payloads carry `key_scope` (`dir:7`, `file:34`) naming which secret opens each node.

### Password locks

`access_is_password` marks a `server`-mode `?ek=` as an owner-chosen password rather than a random token. Stored identically; the flag exists because passwords are guessable, so `security/accessLock.ts::checkLinkAccess` throttles verification **per key scope** via `lockout.ts`'s `link_access` type. Random-token links are deliberately unthrottled (throttling would let anyone lock a public link out). Counter is keyed on key scope, never link slug — `/d/:slug/info` publishes every member file's slug, which would give one fresh guess budget per member.

### Share links

- `links` (files) and `directory_links` (folders) share a shape: `slug`, `max_uses`, `use_count`, `expires_at`, `active`, `hide_uploader`.
- `hide_uploader` suppresses uploader name/avatar on the page **and** in the API.
- Multiple links per file. Folder URLs resolve via `directory_links.slug`, never `directories.slug`; a default link is auto-created with the folder.
- A folder link covers a **subtree**: `/d/:slug/info`, `/preview-manifest`, `/zip` take `?dir=<id>` bounded by `isSelfOrDescendant`; outside → 404, not 403. `POST /d/:slug/unlock` proves a key for one node.
- Zip and `POST /d/:slug/save` recurse **only as far as the presented key reaches**: plaintext descendants included, descendants with their own key skipped.
- `directories.gallery_view` switches the public folder page to poster tiles; cosmetic, read off the folder the *link* points at. Unrelated to `is_library`.
- Use consumption is one atomic `UPDATE … WHERE … RETURNING id` (`links.ts::consumeUse`).
- **One download is one use however many requests.** `/file/:slug/raw` serves `Range` for untransformed blobs; only the request covering byte zero consumes a use, stamps `last_downloaded_at` and writes audit (`isRangeStart`, `routes/public.ts`).
- **A limited-use link serves no ranges** (`rangesAllowed`): no `Accept-Ranges`, `Range` ignored, 200 whole body. Same reason `/preview` refuses limited-use links.

### Webhooks

`webhooks.ts` delivers `WEBHOOK_EVENTS` shaped by `format` (`json` signed envelope · `discord` · `ntfy`; `shapeDelivery`). A new event needs: entry in `WEBHOOK_EVENTS`, a `describeEvent` sentence, and `triggerWebhooks` from its producing route. `file.uploaded` fires for every source via `finalizeStoredFile`. Node-local; cleared on user deletion (`users.ts`, `account.ts`).

### Share-link analytics

`link_hits` (one row per view/download/save, `linkStats.ts`) is written on `/info` calls (folder `?dir=` descents aren't visits), the use-consuming download and zip, and both `save` routes. `GET /api/link-stats/:kind/:linkId` is owner-or-master. **Node-local**, **no IP stored** (only `clientCountry()`, NULL unless proxy header trusted), pruned at 90 days by `link_hits_prune`. `recordLinkHit` never throws.

### Permissions

`server/src/permissions.ts` (`BOOL_FLAGS`), mirrored in `client/src/config/permissions.ts`:

`can_upload` · `can_upload_client_encrypted` · `can_delete` · `can_regenerate_links` · `can_delete_links` · `can_create_directories` · `can_manage_lifecycle` · `can_use_api_keys` · `can_view_admin` · `can_manage_users` · `can_manage_storage` · `can_manage_api_keys` · `can_manage_cluster` · `can_use_torrents` · `can_watch_media` · `require_mfa` · `require_passkey`

`require_mfa`/`require_passkey` are *restrictions*: they force enrolment and block every route except MFA enrolment until done. Deliberately absent from `MASTER_ALL_TRUE` and the master seed (default-on would lock the panel out). Non-boolean: `quota_bytes`, `max_file_bytes`, `archive_after_idle_days`.

Adding a flag touches **all** of: `db/schema.sql`, `ensureColumn` in `db/sqlite.ts`, `db/rows.ts`, `permissions.ts` (`BOOL_FLAGS` + master seed insert), `bootstrap.ts`, `MASTER_ALL_TRUE` in `routes/users.ts`, `/account/me` in `routes/account.ts`, `TABLE_COLUMNS.permissions` in `cluster/replication.ts` (or it resets to default on every peer), and `client/src/config/permissions.ts`.

### Admin panel

- Gated by `requireMaster`, except bulk actions, which also accept a non-master with `can_view_admin` plus the action's flag (`BULK_ACTION_PERMISSIONS`).
- Files/keys tabs group by owner username, alphabetically.
- Bulk actions need an exact `CONFIRM <n>` matching the previewed count. **No ids and no `owner_id` targets every matching row** — intentional, for masters and `can_manage_storage` holders. Anyone else is pinned to their own rows (`admin.ts::requireBulkPermission` returns the `owner_id` to use), since `archive_files`/`unarchive_files`/`delete_inactive_links` hinge on default-on flags (`can_manage_lifecycle`/`can_delete_links`). `run_cleanup_jobs` has no per-owner form and is refused outright.
- API keys are hard-deleted.
- `GET /api/audit` verifies the hash chain only with `?verify=1` (O(all rows)).

### Torrenting

Real-Debrid is preferred, qBittorrent the fallback — never the reverse. `torrent_jobs.provider` (`'debrid'`|`'qbittorrent'`) records the owner; every job ends at `finalizeStoredFile` (quota, dedup, links, replication as a normal upload). Multi-file torrents land in a new folder named after the torrent; single-file become a plain file. `source_type` is `torrent`.

`POST /api/torrents` (needs `can_use_torrents`) takes a magnet or `.torrent` and calls `debrid.ts::dispatchTorrent`. Each job gets a unique tag `fu-<hex>` (how the qBittorrent poller finds it; names the per-job download dir for both).

**Concurrency is a queue, not a refusal.** `MAX_ACTIVE_PER_USER = 5` (`poller.ts`); extras park as `pending` with nothing dispatched, and `promotePendingJobs` starts them from the `torrent_poll` tick. Per user, not global. Only hard refusal: `MAX_QUEUED_PER_USER = 50` (429).

- **A pending job has no provider** (decided at dispatch, later); the route serializes `null`.
- **Re-dispatch needs the source to survive the request:** magnets are stored whole in `torrent_jobs.source` (**never truncated** — the queue and RD→qBit fallback re-dispatch from it); `.torrent` bytes go to the on-disk stash (`debrid.ts::stashSource`) at accept time.
- **`started_at`, not `created_at`, is the poller's clock** (`MISSING_GRACE_MS` runs from dispatch). NULL on old rows → falls back to `created_at`.

**Seeding (qBittorrent only).** With `QBITTORRENT_SEEDING`, a finished job moves to `seeding` instead of `completed`; import already *copied* the files, so the download stays on disk for upload. `completed_at`, `imported_file_count`, `progress` are set at import.

- A seeding job holds no concurrency slot (absent from `IN_FLIGHT_STATUSES`).
- **The poller enforces limits**: `setShareLimits` is applied per torrent, but qBittorrent's share-limit *action* is global, so `pollSeedingJob` compares ratio/time itself and `finishSeeding` deletes the torrent + downloaded copy and settles to `completed`. `seedLimitReached` needs a strictly positive limit (ratio is `-1` before any upload).
- A missing torrent settles a seeding job, never fails it.
- Seeding costs no extra requests (resolved from the one `allTorrents` list per tick).
- Turning seeding off / unconfiguring qBittorrent retires seeding jobs next tick.

**Real-Debrid path** (`realdebrid.ts` + `debrid.ts`):

1. `POST /torrents/addMagnet` or `PUT /torrents/addTorrent`, then `POST /torrents/selectFiles/{id}` with `files=all` (otherwise it parks in `waiting_files_selection` forever). A magnet rejects until `magnet_conversion` finishes, so the poller retries.
2. `torrent_poll` polls `GET /torrents/info/{id}` (throttled 10 s/job — rate limited), mirroring status → `debrid_status`, progress → `progress`/`size_bytes`/`dl_speed`.
3. On `downloaded`, status → `fetching` and a **detached** task streams every link (`POST /unrestrict/link` immediately before each transfer — URLs are short-lived) into `data/debrid/<tag>/`, mirroring the torrent's layout.
4. The staged dir goes to the shared importer; the torrent is then deleted from RD.

**Fallback to qBittorrent** when RD can't deliver: no/rejected token, non-premium, exhausted traffic, outage, `magnet_error`/`error`/`virus`/`dead`, or a transfer failing twice. The row is rewritten in place (`provider`, `save_path`, `created_at` reset, `fallback_reason`) so the user sees one job.

- **No cache pre-check, ever** — never call `instantAvailability`. Everything goes through debrid when configured; only failure demotes.
- **qBittorrent polling:** one `GET /api/v2/torrents/info` per tick, grouped by tag locally (`allTorrents` + `byTag`); **zero** requests when nothing is in flight. Older builds ignore `?tag=`, so per-job polling is O(jobs) full fetches.
- Client poll intervals match the server's 5 s cadence, `refetchIntervalInBackground: false`.
- Only magnets and `.torrent` uploads — an arbitrary URL makes qBittorrent an SSRF proxy (`remoteUpload.ts` pins validated IPs, impossible via qBittorrent).
- The RD token is admin-managed (`PUT /api/admin/torrents/debrid`), validated against `GET /user` **before** persisting, written to `data/app.env`. Node-local, not replicated.
- `TORRENT_CONTENT_PATH` exists because import reads off disk and qBittorrent's view of the dir differs when containerized. Debrid jobs don't need it (`importer.ts::localJobDir` branches on `provider`).
- Everything is inert unless an RD token **or** `QBITTORRENT_URL`+`QBITTORRENT_SAVE_PATH` is set; the API answers 503.

### Media library

Folders with `directories.is_library` become collections on `/watch`; video/audio children are titles. `library_visibility`: `public` (anyone) or `restricted` (account with `can_watch_media`; owner and masters always qualify). `library_kind`: `movie` or `series`.

External players have no session cookie, so restricted titles are also reachable with a **play key** (`media/playKeys.ts`): AES-GCM sealed token as `?k=`, scoped to one file or collection. Verification is a decrypt (mpv does a Range per seek), with `media_play_keys` as the revocation list.

- **An unknown `jti` is rejected, never trusted** — that's what makes `media_playkey_prune` (deletes only rows past `expires_at`) safe.
- **Node-local:** the token pins the minting `NODE_ID`; on a peer it fails with a "wrong node" error. Absent from `REPLICATED_TABLES`.
- **Entitlement re-checked per stream request**, so revoking `can_watch_media` kills outstanding keys.
- **Seeking depends on storage form:** untransformed → `Accept-Ranges: bytes`; encrypted/compressed/archived reproduce from byte zero and stream 200-only (`storage/streaming.ts`). `entries[].seekable` tells the client.
- `content_blobs.media_width/height/duration_seconds` are filled by `storage/mediaProbe.ts` via ffprobe at publish time, keyed on the blob.

### Session management

- `sessions` row: `id`, `user_id`, `csrf_token`, `created_at`, `last_seen_at`, `expires_at`, `ip_address`, `user_agent`, `country_code`. 24 h TTL.
- `last_seen_at` updates at most once a minute.
- `country_code` is `CF-IPCountry` (`middleware/auth.ts::clientCountry`), recorded **once, at login**. ISO 3166-1 alpha-2 plus `XX` (no data) and `T1` (Tor). `T1` is not an ISO code — never flag/table-look-it-up; client `regionLabel` spells both out.
  - **Trusted on the same terms as `clientIp`**: `TRUST_PROXY=cloudflare`, or `true` *plus* a `CF-Ray` header. Otherwise a visitor picks their own country.
  - Nothing trustworthy ⇒ NULL, never a guess.
- Expired rows are refused by `resolve()` and swept hourly by `session_prune` (`pruneExpired`), which also drops inert `login_attempts` (`lockout.ts::pruneStale`).
- Settings → Sessions: list, revoke one (password required), sign out everywhere (`GET/DELETE /api/auth/sessions`, `DELETE /api/auth/sessions/:id`).

### Duplicate save prevention

`files.saved_from_file_id` / `directories.saved_from_directory_id` record the origin of saves from share links. Backend 409s an owner saving their own item or the same user saving the same item twice. Public info returns `already_saved: true`; the UI disables Save ("Already saved").

### Frontend API client

`client/src/config/api.ts` — typed `fetch` wrapper: prefixes `/api`, `credentials: "same-origin"`, `X-CSRF-Token` on POST/PUT/PATCH/DELETE, throws `ApiError` with the backend `detail`. Upload progress needs XHR, so `filesService.ts` has its own path with the same CSRF rules.

### Serving the SPA (`server/src/spa.ts`)

`app.ts` calls `mountSpa(app)` once, after every `/api/*` router; `/`, `/file/:slug`, `/d/:slug` go out through `sendSpa`.

- Shell cached against mtime+size (a rebuild is picked up without restart).
- **A file-looking path (extension) is a 404, not the shell** — a missing chunk answered 200 HTML surfaces as an unreadable syntax error.
- **Unknown `/api/*` is `{detail: "not found"}` 404**, never the SPA fallback.
- **HTML vs JSON by `Accept`:** `sendErrorPage` renders HTML for browser navigations, `{detail}` JSON otherwise.
- **The error page is standalone** (inline CSS, no script/assets) because it stands in for the bundle exactly when the bundle can't be trusted (no build → 503, unknown URL → 404, page error → 500). Its palette duplicates `client/src/index.css` tokens on purpose.
- Assets precompressed at build (`vite.config.ts` `precompress` → `.br`/`.gz` in `public/assets/`); `mountSpa` serves the best acceptable one (`Vary: Accept-Encoding`) before `express.static`. Shell gzipped per request. No `compression` middleware.
- **`@sentry/react` is lazy** (`lib/sentry.ts` imports after `window.load`, queues `captureException`). No static import — it's ~200 kB in the entry chunk.
- Every response carries `X-Build-Version` (`version.ts`), set in `app.ts` before `securityHeaders`.
- Cache: `assets/*` is content-hashed → `immutable` 1 year; everything else `no-cache`. Reversed, a deploy is invisible to an open tab.

Client side: `ErrorPage.tsx` (presentational), `NotFoundPage.tsx` (router `*`; shows the failed address instead of bouncing to `/`), `RootErrorBoundary.tsx` (above every provider in `main.tsx`; treats a failed dynamic `import()` as "new version, reload").

---

## Gotchas / invariants

- **Wrap every `async` route handler in `asyncHandler`.** Express 4 doesn't await handlers; a rejection hangs the request forever.
- **`POST /upload/finalize` answers `202 {status: "finalizing"}`, works detached, and the client polls the same endpoint.** Hashing multi-GB takes a minute+, past proxy timeouts (nginx 60 s, Cloudflare 100 s), so inline work reported failure for files that were stored. Cheap actionable checks (token, missing chunks, size, destination, permissions) stay **synchronous**; only per-byte work goes in `startFinalize`. A detached job must record failures in the registry (or pollers wait forever) and must not read anything off `req` that dies with the socket (`FinalizeOpts.requestOrigin`; `clientIp` falls back to `req.socket.remoteAddress`).
- **Finalize is idempotent via ordering:** the replay check runs **before** the `.parts` check (success deleted it), and on the dropbox route **before the receive link is resolved** (success marks the link used → `resolveDropbox` 410s). "Upload incomplete" 409 must stay distinguishable from 202 (send chunks vs keep polling).
- **Digests run in workers; never fold them back onto the event loop.** A `for await` over `createReadStream` doesn't actually yield (512 MB blocked it 4097 ms of 4112 ms). Detaching doesn't help. `hashFile` dispatches to `storage/hashPool.ts` with a path in and hex out. This doesn't conflict with one-process: `worker_threads` share the process. The one inline hasher left is `assembleChunks` (legacy `.parts` only).
- **Only sha256 and md5 are computed.** `content_blobs` keeps `sha1`/`blake2b` columns (still replicated) but nothing writes them; `attachBlob` omits them from INSERT, `fileHashes` reports only non-empty ones. Dedup keys on `stored_sha256`.
- **Chunks are written straight to their offset in `<rel>.part`; `.parts/<i>` is a zero-byte marker**, written only after the last byte lands — so finalize is a stat, not a copy. `isLegacyPartsLayout` handles sessions staged the old way.
- **Chunked uploads resume across reload** by re-picking the file: `files/lib/uploadResume.ts` keeps `{fileIdentity+options → upload_id}` in localStorage `fu_upload_sessions` (12 h = server `CHUNK_SESSION_TTL`); `uploadCore.ts::openSession` asks `/upload/status` and continues from `received`, fresh on any error. A failed transfer **keeps** its session; only user cancel aborts; finished finalize forgets it. **`client`-mode uploads are never resumable** (new key+nonce each attempt; splicing would corrupt).
- **Don't abort an upload whose finalize is still running** — `lib/finalizePoll.ts` polls; abort refuses an already-finalized upload.
- **`express.json()` limit is 8 MB**, above `MAX_TORRENT_FILE_BYTES * 4/3` (base64 `.torrent` payloads up to 2 MiB).
- **Two header policies, never mixed.** `securityHeaders.ts` puts the page CSP + `Permissions-Policy` + COOP on every response. Routes whose body is **uploaded bytes** (`/file/:slug/raw`, `/preview`, `/thumbnail`, folder zip, media streams) override with `BYTES_HEADERS` (`default-src 'none'; sandbox; frame-ancestors 'self'`, `X-Frame-Options: SAMEORIGIN`). `SAMEORIGIN` lets the PDF iframe render. `UNSAFE_CT` (`routes/files.ts`; html/svg/xml/js stored as octet-stream) is the first wall, the sandbox CSP the second.
- **The error handler branches on `res.headersSent`:** a mid-body streaming failure destroys the socket rather than appending an error page.
- **`mountSpa` goes after every API router, then the `/api` JSON 404.** Reordering makes unknown endpoints return HTML.
- **Deleting a user must clear every FK table:** `permissions`, `sessions`, `credentials`, `files`, `directories`, `directory_collaborators` (`user_id` and `invited_by_id`), `api_keys`, `dropbox_upload_links`, `remote_upload_jobs`, `torrent_jobs`, `media_play_keys`, `webhooks`, the three `oauth_*` tables (via `routes/oauth.ts::purgeOauthForUser`, covering owned apps and issued grants), `cluster_nodes.created_by_id`.
- **Deleting a directory must clear FK tables without a cascade:** `files`, `directory_links`, `directory_collaborators`, `dropbox_upload_links`. (`media_play_keys` cascades, `torrent_jobs` sets null.)
- **`/account/reset` must not delete the `permissions` row** (resets admin-assigned quota). Reset purges content; only account deletion purges identity.
- **Decrypt/decompress order depends on producer:** `archived && !compressed` = `ZSTD(ENC(x))` (decompress, then decrypt); every other compressed+encrypted combo = `ENC(ZSTD(x))`. `routes/public.ts` and `storage/zip.ts` both branch on this — keep in sync.
- **Compression is kept only if it saved something.** `shouldCompress` trusts a lying content type, so `compressIfWorthwhile` samples the first 256 KiB then re-checks finished size against a 5% threshold, else deletes output and stores the original. `compressed = 1` costs `Accept-Ranges` forever (`isDirectlyStreamable`); incompressible data measured 1.00006×.
- **Archiving a server-encrypted file compresses nothing** (AES-GCM output is pseudorandom; it was storing it larger with `archive_saved_bytes = 0`, hidden by `Math.max(0, …)`). Such files are settled `archived` untouched. The `ZSTD(ENC(x))` read path stays for files the old job rewrote.
- **The read path composes transforms as streams, never staging to disk:** `decompressFromDecrypted`/`decryptFromDecompressed` chain `decryptStreamFrom` and `decompressGuarded` for constant TTFB. `storage/zip.ts::memberSource` still needs one real file (zip seeks) — one temp copy at most.
- **`Readable.pipe()` doesn't forward errors.** `decompressGuarded` wires `input.on("error") → out.destroy(err)` and `out.on("close") → input.destroy()` by hand, or a mid-stream source failure hangs the consumer and an abandoned download leaks an fd.
- **Blob dedup lookup is `(stored_sha256, transform_key)` and needs `ix_content_blobs_stored`;** `ix_content_blobs_sha256` indexes plaintext and would leave every upload full-scanning.
- **Server-side encryption defeats dedup by construction** (fresh random nonce per `encryptFile`). Ratio 1.0 is known, not a bug — don't make the nonce deterministic without thinking through what convergent encryption leaks.
- **Don't read `process.env` for a config key — use `configValue()`.**
- **Persist config before applying it in memory** (`setEnvValue` throws `ConfigLockedError` when the env supplies the key).
- **`TRUST_PROXY` must be set behind a TLS proxy** or `httpsRedirect` 308-loops.
- **Anything added to `permissions` or `users` must go in `cluster/replication.ts` `TABLE_COLUMNS`**, or it resets on every peer.
- **Deleting a file must call `deleteThumbnail(fileId)`** (cache keyed by file id, not refcounted).
- **A debrid retry decides re-import vs re-download by the `data/debrid/_sources/<tag>.complete` marker**, not "the staging dir has files" (aborted transfers leave files; importing them stores truncated content). Written only after the last byte of the last link (`debrid.ts::markTransferComplete`), outside the job dir so the importer never sees it.
- **Real-Debrid file paths are attacker-controlled:** `debrid.ts` runs each through `sanitizeSegment` + `safeJoin`.
- **No unbounded in-memory maps without a sweep** (halt, login challenges, second-factor tickets, ws-token limiter all prune).
- **Every refusal is logged with its reason** via `middleware/deny.ts` (`deny`/`logDeny`, logger `app.access`); `recordAudit` mirrors rows into the log (`app.audit`); lockout/session/login failures log the true cause the client response hides. Ring buffer holds 10 000 records. Never put a credential in a `why`.
- **Outbound HTTP goes through `outbound.ts`** (`fetchLogged`, or `beginOutbound` where the transport isn't `fetch`, e.g. `remoteUpload.ts`): logged in the same buffer, URL redacted (unrestrict links, blob URLs, `?ek=`, `?k=` are credentials). Healthy calls log at DEBUG; the ring buffer keeps DEBUG anyway.
- **`safeJoin()` every path built from user or DB input.**
- **Only a caller holding a folder's E2E key may upload into it.** `finalizeStoredFile` refuses a `client`/`sealed` destination unless `clientCiphertext: true`, passed only by the two browser/API upload routes. `encryptionMode: "client"` is *not* that claim (server paths copy their directory's mode into it) — trusting it would let a dropbox file plaintext under a mode promising ciphertext.
- **`server` secrets travel as a query param and the server compares them; `client`/`sealed` keys travel in the fragment and never reach the server.** A play key, `?ek=` and `#ek=` are three different things.
- **A recursive tree walk needs a depth bound** (cycles from corrupt/partial replication); every `directoryTree.ts` walker bails.
- **A promotion to break point must carry `access_is_password`, not just the key** — dropping it turns a throttled password into an unthrottled one.
- **Sealing takes the delete gate** (`POST /files/:id/seal`: `can_delete` *and* ownership); it's irreversible and unreadable even to the owner.
- **A folder created inside someone else's tree belongs to that tree's owner**, or an editor could re-delegate via owner-only `POST /directories/:id/collaborators`.
- **Replicating a file must ship its whole ancestor chain, root first** (`parent_directory_id` is a real FK on peers).
- **Don't ancestor-walk per row in a listing.** `buildPathIndex` reads once; `serializeFiles`/`serializeDirectories` take an `EncryptionResolver` (`createEncryptionResolver` over a `TreeCache`) resolving each folder once and answering `role` from one collaborator query; system-wide admin listings `preloadAll()` it.

---

## What NOT to do

- Run migrations (use nullable/`DEFAULT` columns + `ensureColumn`)
- Write an `async` Express handler without `asyncHandler`
- Send the SPA shell for an extension path, or let the catch-all answer `/api/*`
- Commit a per-workspace `bun.lock` (the root workspace lockfile is the only one)
- Bounce an unknown client route to `/` — render `NotFoundPage`
- Scale to multiple processes without redesigning `cluster/eventBus.ts`
- Poll qBittorrent per job
- Refuse a torrent over the concurrency limit, or count `pending` in `IN_FLIGHT_STATUSES` (deadlocks the queue)
- Truncate a stored magnet
- `cleanupJobDir` a seeding job
- Gate Real-Debrid on `instantAvailability`
- `await` a Real-Debrid transfer inside the `torrent_poll` tick (`startDebridFetch` is detached)
- Write API reference content into `ApiDocsPage.tsx` — edit `docs/api.md`
- Put `CopyButton` (or any Radix-backed control) in the `Markdown` renderer — 100+ code blocks means 100+ tooltip roots and jank
- Store a compressed copy without checking it shrank
- Serve uploaded bytes under the page CSP — use `BYTES_HEADERS`
- Stage a transform to a temp file on the read path
- Soft-delete API keys
- Wrap `DropdownMenuTrigger`'s `asChild` button in a `Tooltip` (breaks clicks)
- Use `bg-brand-gradient/90` (opacity modifiers don't apply to CSS-variable gradients)
- Use `text-primary-foreground` on brand gradients — use `text-white`
- Offer `client` as encryption for a *nested* folder (always inherits; backend rejects)
- Add a "convert to end-to-end" backend endpoint (browser-side by construction)

---

## File-specific notes

- `crypto/effectiveEncryption.ts` — `sourceDirectoryId` is set only when the resolver actually *walked*; use `ownerDirectoryId` for "which node holds this key", including a file inheriting straight from its own folder.
- `routes/public.ts` — public file info returns `uploader: {username, has_avatar, user_id} | null` (null under `hide_uploader`) and `already_saved`. `/preview` and `/thumbnail` refuse limited-use links.
- `routes/files.ts` — `serializeFiles()` batch-loads owner usernames and links (no N+1); `recoverAccessKey()` rebuilds the server-mode `?ek=` for the owner. Chunked uploads seal session metadata into an AEAD token (no session table); `uploadLocks` serializes finalize vs abort. `receiveChunkAt()` writes at final offset; `finalizeStoredFile` skips the stored-side rehash when nothing transformed the bytes, leaving one detached hash pass off the event loop (6.4 GB: request returns in ~6 ms, background ~23 s vs ~310 s inline).
- `routes/remoteUpload.ts` — resolves DNS, rejects private/local addresses, connects to the *pinned* validated IP (closes rebinding), re-validates each redirect, caps bytes mid-stream, decodes chunked encoding.
- `storage/zip.ts` — `safeArcname()` flattens paths and dedupes collisions; `memberSource()` resolves a row to plaintext bytes and owns the transform-order rule.
- `torrents/debrid.ts` — `planFiles()` pairs `info.links[]` with *selected* `info.files[]` positionally; on count mismatch (RD splits huge torrents into RAR volumes) it names each download from its unrestrict response. The transfer's only timeout is a **stall** timer (multi-GB pulls run for hours).
- `torrents/poller.ts` — `pollDebrid` uses the row's `updated_at` as its last-polled clock (no side map). `startDebridFetch` guards overlap with a module-level `Set` of job ids. `promotePendingJobs` reads all owners' slot usage in **one** grouped query and increments its tally *before* awaiting dispatch so the same owner's next pending job is decided in the same loop.
- `security/sessions.ts` — cookie carries only a signed opaque sid.
- `client/src/features/download/lib/downloadCore.ts` — read-side mirror of `files/lib/uploadCore.ts` (worker-slot pool, AIMD concurrency, per-chunk retry) pulling ranges. Requests chunk 0 with `Range` and lets the **answer** decide: 206 gives the total from `Content-Range` and it plans the rest; 200 means the server declined and that response is the whole file (no extra request). Every later chunk's `Content-Range` total is compared to the first (stitching two blobs corrupts undetectably). Via `publicService.fetchRawChunked`, which stays single-stream below 16 MiB.
- `client/src/components/layout/UserMenu.tsx` — collapsed sidebar trigger is a plain `Button`; a `Tooltip` breaks the DropdownMenu.
- `client/src/features/files/components/Dropzone.tsx` — `bg-brand-gradient` + `text-white`, per "What NOT to do".
