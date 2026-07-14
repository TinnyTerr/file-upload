# fileupload

A self-hosted file sharing platform with end-to-end encryption, folder management, share links, API keys, dropboxes, and an admin panel.

Built with **Bun + Express** on the backend and **React + TypeScript** on the frontend.

## Features

- Upload files (single-shot or chunked) and organize them into folders
- Share links with expiry, use limits, and optional password/key gating
- Three encryption modes: none, server-side AES-GCM, or client-side end-to-end (WebCrypto)
- API keys for programmatic access (`Authorization: Bearer <key>`)
- Dropboxes — token-gated public upload links
- Admin panel: users, permissions, files, keys, audit log, storage/backend controls
- Remote URL fetch-and-upload

## Quick start

```bash
bun install            # installs both workspaces (client/, server/)
bun run start           # builds client → public/, then runs server on :8000
```

### Dev mode (hot reload)

```bash
bun run dev             # Vite on :5173 (proxies API calls) + Express on :8000
```

Config lives in `./data/app.env` and is auto-generated on first run.

| Variable | Purpose |
|---|---|
| `APP_ENV` | `dev` (HTTP cookies) or `prod` (Secure cookies) |
| `SECRET_KEY` | session signing key |
| `MASTER_KEY_B64` | base64 AES-256 key used for server-side encryption |
| `DATABASE_URL` | default `sqlite:///./data/app.db` |
| `TRUST_PROXY` | set `true` behind a reverse proxy for real IP detection |

## Tech stack

| Layer | Technology |
|---|---|
| Backend | Bun + Express, `bun:sqlite` (SQLite, no migrations) |
| Frontend | React 18/19, TypeScript, TanStack Query, Tailwind CSS, Radix UI primitives |
| Auth | Cookie-based sessions (`fu_session`) + CSRF tokens (`fu_csrf_token` in localStorage) |
| Crypto | AES-GCM (server-side), browser WebCrypto (client-side E2E) |

## Project structure

```
server/src/     Bun + Express backend (routes, db, security, storage, jobs)
client/src/     React + TypeScript frontend (features, components, config)
public/         Built client output, served by the Express app
data/           Runtime state: app.env, sqlite db, uploaded files (not checked in)
```

See `CLAUDE.md` for a detailed developer/agent guide (architecture, key patterns, route status) and `TODO_ROUTES.md` for the remaining cluster/realtime work.
