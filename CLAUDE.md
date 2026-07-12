# CLAUDE.md — fileupload project guide

## Overview

A self-hosted file sharing platform with end-to-end encryption, folder management, share links, API keys, dropboxes, and an admin panel. Built with FastAPI (Python) on the backend and React + TypeScript on the frontend.

---

## Tech stack

| Layer | Technology |
|---|---|
| Backend | FastAPI, SQLAlchemy 2.0 (SQLite, no Alembic migrations), Pydantic v2 |
| Frontend | React 18, TypeScript, TanStack Query, Tailwind CSS, Radix UI primitives |
| Auth | Cookie-based sessions (`fu_session`) + CSRF tokens (`fu_csrf_token` in localStorage) |
| Crypto | AES-GCM (server-side via `cryptography` lib), browser WebCrypto (client-side E2E) |
| Scheduling | APScheduler (background jobs: expiry cleanup, link pruning) |

---

## Running the project

**Backend:**
```bash
pip install -e ".[dev]"
python -m app          # dev server on :8000
```

**Frontend (dev):**
```bash
cd client
npm install
npm run dev            # Vite on :5173, proxies /api → :8000
```

**Run tests:**
```bash
pytest
```

**Bun + Express rewrite (`server/`, in progress):**

A Bun+Express backend is being built in `server/` to eventually replace `app/` (the Python backend). It currently implements only the core skeleton — config loading, the DB abstraction layer (`server/src/db/`, `bun:sqlite` adapter, full schema in `schema.sql`), and the auth/session/CSRF/lockout flow (`/auth/login`, `/auth/logout`, `/auth/sessions`) with byte-for-byte behavioral parity (cookie name `fu_session`, `X-CSRF-Token` header, same status codes, same lockout policy). All other routes (files, directories, links, admin, keys, dropbox, remote-upload, cluster, ws, public, account, audit) are **not yet ported** — see `TODO_ROUTES.md`. The Python backend in `app/` remains the primary, feature-complete implementation until parity is reached.

```bash
cd server
bun install
bun run dev             # Express server on :8000, same config path (./data/app.env)
```

Config lives in `./data/app.env` and is auto-generated on first run. Environment variables:
- `APP_ENV` — `dev` (HTTP cookies) or `prod` (Secure cookies)
- `SECRET_KEY` — session signing key
- `MASTER_KEY_B64` — base64 AES-256 key used for server-side encryption
- `DATABASE_URL` — SQLAlchemy URL (default: `sqlite:///./data/app.db`)
- `TRUST_PROXY` — set `true` behind a reverse proxy for real IP detection

---

## Project structure

```
app/
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
- `can_use_api_keys`, `can_use_dropbox`
- `master` role bypasses all permission checks

### Admin panel

- Requires `master` role (`require_master` dependency)
- Files tab: grouped by owner username, alphabetically sorted
- Keys tab: grouped by owner username, alphabetically sorted  
- Hard-deletes API keys when users delete them (not soft-delete)

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
