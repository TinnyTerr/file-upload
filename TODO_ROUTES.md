# Bun+Express backend — remaining route ports

The Python backend (`app/`) is retired — `server/` (Bun + Express) is the only
backend that runs. Every route in `app/routes/` has been ported to `server/`
and mounted in `server/src/app.ts`, including `app/routes/ws.py` and
`app/routes/cluster.py` (cluster/realtime — see below). The Python
tree remains read-only reference material only. Mount prefixes below match
`app/main.py`'s `include_router` calls (kept only as a naming reference) --
in the actual Bun server every route is mounted under `/api/*` (see
`server/src/app.ts`), so e.g. the `/files` row below is really `/api/files`.

Foundations ported: `server/src/logging.ts` (pino-backed logger + admin log
ring buffer), `server/src/middleware/deps.ts` (requireActiveUser/requireMaster/
requirePermission/getUploadUser/requireApiKey), `server/src/permissions.ts`,
`server/src/crypto/{aead,secretbox}.ts`, `server/src/security/apiKeys.ts`,
`server/src/storage/{paths,blobs,compress,accounting,zip}.ts`, `server/src/links.ts`
(slug/consume-use), `server/src/spa.ts` (SPA shell + OG-meta injection).

Every flag in `client/src/config/featureFlags.ts` is now `true`, including
`cluster`.

| Source file | Mount prefix | Status |
|---|---|---|
| `app/routes/account.py` | `/account` | **Ported** (`server/src/routes/account.ts`) — change-credentials, `/me`, avatar upload/serve/delete, reset, delete account |
| `app/routes/files.py` | `/files`, `/links`, `/admin/files` | **Ported** (`server/src/routes/files.ts`) — single-shot multipart upload (busboy), chunked upload (init/status/chunk/finalize/abort, sealed tokens), save, list, batch-zip (archiver), link CRUD, disk-stats, usage, admin list. Directory-bundle upload path (`directory_id`) is wired but untested — no `directories.py` yet to create directory rows |
| `app/routes/directories.py` | *(none)* | **Ported** (`server/src/routes/directories.ts`) — folder CRUD (`directoriesRouter`), auto-created default `DirectoryLink` on create, collaborator add/remove, per-folder link CRUD, `/admin/directories` (`adminDirectoriesRouter`), and the public `/d/:slug*` surface (`publicDirectoriesRouter`): info/preview-manifest/save/zip (archiver-streamed, `safeArcname` dotfile stripping) with OG-meta HTML shell. Mounted in `app.ts` |
| `app/routes/public.py` | *(none)* | **Ported** (`server/src/routes/public.ts`) — `/file/:slug/info`, `/raw` (Range support, ?ek= gate, decrypt/decompress streaming), `/preview`, HTML shell with OG meta tags |
| `app/routes/keys.py` | `/keys` (+ admin sub-router) | **Ported** (`server/src/routes/keys.ts`) — create/list/delete/reset-ip, `/admin/keys` |
| `app/routes/dropbox.py` | *(none)* | **Ported** (`server/src/routes/dropbox.ts`) — dropbox-link create/cancel (owner-scoped, session+CSRF), public token-gated info + single-shot busboy upload (`_precheck_declared_size` before body) + chunked upload (init/status/chunk/finalize), sealed dropbox tokens via secretbox. Mounted in `app.ts` |
| `app/routes/admin.py` | `/admin` | **Ported** (`server/src/routes/admin.ts`, `adminRouter`) — storage overview (`GET`/`PATCH /storage`), `GET /backend/logs` (`queryBackendLogs`, cluster peer proxying deferred — a `server` param naming a peer 404s), `POST /backend/restart-workers` (`jobs/scheduler.ts`'s `restartBackendWorkers`), manual file `POST /files/:id/archive`/`unarchive` (shared `archiveFileCore`/`unarchiveFileCore` in `server/src/jobs/lifecycle.ts`), manual lifecycle triggers (`POST /lifecycle/{temp-expiry,link-expiry,reconcile,archive-idle}`), and `POST /bulk/preview`/`run` (delete/reset api keys, delete inactive links, delete/archive/unarchive files, delete directories, run-cleanup-jobs). users/keys/audit/files admin panels remain ported separately. Mounted in `app.ts` |
| `app/routes/users.py` | `/users` | **Ported** (`server/src/routes/users.ts`) — CRUD + permissions, last-master guard |
| `app/routes/audit_view.py` | `/audit` | **Ported** (`server/src/routes/audit.ts`) — `/audit/` with q/action/limit/offset + hash-chain verify; `/audit/cluster` stubbed empty (cluster deferred) |
| `app/routes/remote_upload.py` | `/files/remote-upload*` | **Ported** (`server/src/routes/remoteUpload.ts`) — SSRF-guarded (public-IP validation + pinned-connection fetch, redirect re-validation), job status polling |
| `app/routes/ws.py` | *(none)* + `/admin/cluster` | **Ported** (`server/src/ws.ts`) — `GET /api/ws/events` per-user live stream (session cookie auth, master receives the full firehose), `GET /api/admin/cluster/firehose` websocket (cluster-token auth), `GET /api/admin/cluster/events` HTTP long-poll fallback + `GET /api/admin/cluster/node-logs` (`server/src/routes/cluster.ts`'s `adminClusterRouter`) |
| `app/routes/cluster.py` | `/cluster` | **Ported** (`server/src/routes/cluster.ts`'s `clusterRouter`, mounted at `/api/cluster`) — token reveal/rotate, self/nodes, node link (+ master-driven enroll command)/unlink, and the node-to-node membership/replication/blob handshake (`/join`, `/enroll`, `/heartbeat`, `/ping`, `/blobs/:hash`, `/digest`, `/reserve`, `/replicate`, `/export`), all backed by `server/src/cluster/*.ts` |

## Also not yet ported

- Scheduled jobs (`app/jobs/`): **Ported** (`server/src/jobs/lifecycle.ts` + `server/src/jobs/scheduler.ts`) — archive_idle/delete_idle/temp_expiry/sweep_stale_parts run hourly, link_expiry every 10 min, cluster_heartbeat every minute, cluster_sync_check every 5 minutes, plain `setInterval` timers (no `node-cron`/`croner` dependency needed). `reconcile_stale_states` has no interval in Python either and stays manual-trigger-only via `admin.ts`. `startBackendWorkers(state)` is called from `server/src/index.ts` at boot, after `ensureMaster`; `restartBackendWorkers(state)` backs `POST /admin/backend/restart-workers`.
- Cluster runtime (event bus, firehose consumer, heartbeat/sync jobs) — **Ported**, see `server/src/cluster/{eventBus,eventStore,firehoseClient,membership,digest}.ts`. `cluster` flag is on.
- Static asset minification at boot (`rjsmin`/`rcssmin`) — likely skip in favor of pre-built minified Vite output.
- Archive/lifecycle (`archived` files, `_archive_file_core` zstd repack) — **Ported**: the shared archive/unarchive logic lives in `server/src/jobs/lifecycle.ts` (`archiveFileCore`/`unarchiveFileCore`, `archiveIdleJob`), used by both the hourly job and `admin.ts`'s manual/bulk routes.

Nothing from `app/routes/` remains unported. `/admin/cluster/node-logs` cluster
peer log proxying (from `admin.ts`'s `GET /backend/logs?server=`) is still not
wired up -- see the note on that line above -- everything else, including the
full cluster/realtime subsystem, is ported and the `cluster` feature flag is on.
