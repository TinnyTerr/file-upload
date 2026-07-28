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

## How it works

**Client/server split.** The server does one job: serve every backend route under `/api/*` (JSON + binary alike — uploads, downloads, previews, admin) and, for everything else, serve the built React SPA and let React Router handle the page. Because the API lives entirely under its own `/api` prefix, a page route and an API route can share the same name (`/files` the page, `/api/files` the endpoint) with no ambiguity — the dev-mode Vite proxy forwards `/api/*` to the Express server and lets Vite serve everything else itself.

**Auth.** Logging in sets an HTTP-only `fu_session` cookie and returns a CSRF token, which the client stores in `localStorage` and sends back as `X-CSRF-Token` on every mutating request (`POST`/`PUT`/`PATCH`/`DELETE`) — the server rejects a mutation that has a valid session cookie but no matching CSRF header, which is what stops a third-party site from silently using a logged-in user's cookie against them. API keys (`Authorization: Bearer <key>`) are a separate auth path for scripts/integrations and skip CSRF entirely, since there's no ambient cookie to forge.

**Uploads.** A file under the chunking threshold (80 MiB, measured post-encryption) goes up in one request. Above that, the client requests a chunked upload session, splits the file into fixed-size chunks, and sends them over a small pool of concurrent requests — pool size starts at 2 and adapts every few chunks based on measured throughput (stepping up when speed improves, halving on a failed chunk), so the transfer leans on whatever bandwidth is actually available without hard-coding a number. Multiple files in one upload batch are still sent one at a time, deliberately, to keep memory and bandwidth use predictable; only the chunks *within* a single large file run in parallel. A folder upload is a distinct flow — the whole selected directory tree is uploaded and grouped server-side into one folder with one share link, rather than becoming a batch of unrelated individual files.

**Encryption.** Every file has one of three modes, chosen per-file or per-folder: `none` (link slug is the only credential), `server` (AES-GCM at rest, decrypted server-side when a valid `?ek=` access key is presented), or `client` (encrypted in the browser before upload; the key lives only in the URL fragment `#ek=`, which browsers never send to the server, so the server never sees plaintext or key).

**Share links.** Files and folders each get one or more links (slug + optional expiry, use-limit, and uploader-visibility toggle) independent of the file/folder's own permissions — revoking or regenerating a link doesn't touch the underlying file, and a file can have several links live at once with different limits.

## Project structure

```
server/src/     Bun + Express backend (routes, db, security, storage, jobs)
client/src/     React + TypeScript frontend (features, components, config)
public/         Built client output, served by the Express app
data/           Runtime state: app.env, sqlite db, uploaded files (not checked in)
```

See `CLAUDE.md` for a detailed developer/agent guide (architecture, key patterns, conventions).
