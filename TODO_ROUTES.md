# Bun+Express backend — remaining route ports

The `server/` skeleton currently ports only `app/routes/auth.py`. The rest of
`app/routes/` still needs to be reimplemented against the same `Db`
interface (`server/src/db/types.ts`) and `AppState` (`server/src/appState.ts`)
before `app/` (the Python backend) can be retired. Mount prefixes below match
`app/main.py`'s `include_router` calls.

| Source file | Mount prefix | Notes |
|---|---|---|
| `app/routes/account.py` | `/account` | `/account/me`, avatar upload, password change |
| `app/routes/files.py` | *(none)* | Upload, list, delete, link CRUD — largest file, depends on encryption/storage helpers not yet ported |
| `app/routes/directories.py` | *(none)* | Folder CRUD, member management, link CRUD, zip download (`_safe_arcname` dotfile stripping) |
| `app/routes/public.py` | *(none)* | Public file/folder info (no auth), `already_saved` logic |
| `app/routes/keys.py` | `/keys` (+ admin sub-router) | API key management, hard-delete on removal |
| `app/routes/dropbox.py` | *(none)* | Single-shot dropbox uploads, `_precheck_declared_size` |
| `app/routes/admin.py` | `/admin` | Users/files/keys/audit tabs, `require_master` |
| `app/routes/users.py` | `/users` | Admin create/edit/delete users |
| `app/routes/audit_view.py` | `/audit` | Admin audit log viewer |
| `app/routes/remote_upload.py` | *(none)* | Remote URL fetch-and-upload jobs |
| `app/routes/ws.py` | *(none)* + `/admin/cluster` | Realtime/websocket routes |
| `app/routes/cluster.py` | `/cluster` | Cluster node management |

## Also not yet ported

- Storage layer (`app/storage/`): file storage, quota accounting, zstandard compression.
- Crypto layer (`app/crypto/`): AES-GCM server-side encryption, key blob handling.
- Scheduled jobs (`app/jobs/`): archive/delete-idle, temp/link expiry sweeps (APScheduler → would become `node-cron`/`croner` or `setInterval`-based jobs in `server/`).
- Cluster runtime (event bus, firehose consumer, heartbeat/sync jobs).
- Static asset minification at boot (`rjsmin`/`rcssmin`) — likely skip in favor of pre-built minified Vite output.
- Permission dependency helpers (`require_permission`, `get_upload_user`, `require_api_key` from `app/deps.py`) — needed once `files.py`/`dropbox.py` are ported.

Until these are ported, run the Python backend (`python -m app`) for full functionality; `server/` is auth/session/DB-layer only.
