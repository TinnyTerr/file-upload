# Bun+Express backend — remaining route ports

The Python backend (`app/`) is retired — `server/` (Bun + Express) is the only
backend that runs. It ports `app/routes/auth.py`, `account.py`, `keys.py`,
`users.py`, `audit_view.py`, `files.py`, `public.py`, and `remote_upload.py`
so far; the rest of `app/routes/` is read-only reference material that still
needs to be reimplemented against the same `Db` interface
(`server/src/db/types.ts`) and `AppState` (`server/src/appState.ts`). Mount
prefixes below match `app/main.py`'s `include_router` calls (kept only as a
naming reference).

Foundations ported: `server/src/logging.ts` (pino-backed logger + admin log
ring buffer), `server/src/middleware/deps.ts` (requireActiveUser/requireMaster/
requirePermission/getUploadUser/requireApiKey), `server/src/permissions.ts`,
`server/src/crypto/{aead,secretbox}.ts`, `server/src/security/apiKeys.ts`,
`server/src/storage/{paths,blobs,compress,accounting,zip}.ts`, `server/src/links.ts`
(slug/consume-use), `server/src/spa.ts` (SPA shell + OG-meta injection).

Until a route is ported, its frontend surface is hidden behind a flag in
`client/src/config/featureFlags.ts` — flip the flag once the route lands
here.

| Source file | Mount prefix | Status |
|---|---|---|
| `app/routes/account.py` | `/account` | **Ported** (`server/src/routes/account.ts`) — change-credentials, `/me`, avatar upload/serve/delete, reset, delete account |
| `app/routes/files.py` | `/files`, `/links`, `/admin/files` | **Ported** (`server/src/routes/files.ts`) — single-shot multipart upload (busboy), chunked upload (init/status/chunk/finalize/abort, sealed tokens), save, list, batch-zip (archiver), link CRUD, disk-stats, usage, admin list. Directory-bundle upload path (`directory_id`) is wired but untested — no `directories.py` yet to create directory rows |
| `app/routes/directories.py` | *(none)* | Folder CRUD, member management, link CRUD, zip download (`_safe_arcname` dotfile stripping) |
| `app/routes/public.py` | *(none)* | **Ported** (`server/src/routes/public.ts`) — `/file/:slug/info`, `/raw` (Range support, ?ek= gate, decrypt/decompress streaming), `/preview`, HTML shell with OG meta tags |
| `app/routes/keys.py` | `/keys` (+ admin sub-router) | **Ported** (`server/src/routes/keys.ts`) — create/list/delete/reset-ip, `/admin/keys` |
| `app/routes/dropbox.py` | *(none)* | Single-shot dropbox uploads, `_precheck_declared_size` |
| `app/routes/admin.py` | `/admin` | Storage/backend-logs/lifecycle tabs — not yet ported (users/keys/audit/files ported separately) |
| `app/routes/users.py` | `/users` | **Ported** (`server/src/routes/users.ts`) — CRUD + permissions, last-master guard |
| `app/routes/audit_view.py` | `/audit` | **Ported** (`server/src/routes/audit.ts`) — `/audit/` with q/action/limit/offset + hash-chain verify; `/audit/cluster` stubbed empty (cluster deferred) |
| `app/routes/remote_upload.py` | `/files/remote-upload*` | **Ported** (`server/src/routes/remoteUpload.ts`) — SSRF-guarded (public-IP validation + pinned-connection fetch, redirect re-validation), job status polling |
| `app/routes/ws.py` | *(none)* + `/admin/cluster` | Realtime/websocket routes — **deferred**, cluster flag stays off |
| `app/routes/cluster.py` | `/cluster` | Cluster node management — **deferred**, cluster flag stays off |

## Also not yet ported

- Scheduled jobs (`app/jobs/`): archive/delete-idle, temp/link expiry sweeps, stale-part sweep (APScheduler → would become `node-cron`/`croner` or `setInterval`-based jobs in `server/`). `sweepStaleParts()` exists in `server/src/routes/files.ts` but isn't wired to a scheduler yet — call it before flipping any flag that depends on parts-dir hygiene under sustained load.
- Cluster runtime (event bus, firehose consumer, heartbeat/sync jobs) — deferred, `cluster` flag stays off.
- Static asset minification at boot (`rjsmin`/`rcssmin`) — likely skip in favor of pre-built minified Vite output.
- Archive/lifecycle (`archived` files, `_archive_file_core` zstd repack) — files.ts serializes the fields but nothing sets them yet; lands with `admin.py`'s lifecycle jobs.

Until `directories`/`dropbox`/`admin` land, their frontend surfaces stay gated off via `client/src/config/featureFlags.ts` rather than falling back to the Python backend.
