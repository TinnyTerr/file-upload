# Oxymoron — React client

The web frontend for **Oxymoron (for files)**, a React + TypeScript SPA built with
Vite and Tailwind CSS. It is a faithful re-implementation of the original vanilla-JS
pages in `app/static/js`, with a redesigned UI. The crypto (`aead-worker.js`, FUPL v1)
and ZIP writer are reproduced byte-for-byte so they stay wire-compatible with the
Python server (`app/crypto/aead.py`).

## Prerequisites

- [Bun](https://bun.sh) ≥ 1.3 — used for all install/build/dev steps.

## Install

```sh
cd client
bun install
```

## Develop

```sh
bun run dev
```

Starts the Vite dev server (default http://localhost:5173). All backend paths
(`/auth`, `/account`, `/files`, `/directories`, `/links`, `/keys`, `/users`,
`/admin`, `/audit`, `/d/*`, `/file/*`, `/dropbox-links`, `/health`) are proxied to a
locally-running FastAPI backend. Point at a different backend with:

```sh
BACKEND_ORIGIN=http://localhost:9000 bun run dev
```

Run the Python server separately (from the repo root), e.g. `python -m app`.

> The page routes `/d/:slug` and `/file/:slug` are served by the SPA in dev; their
> deeper sub-paths (`/d/:slug/info`, `/file/:slug/raw`, …) proxy to the backend.

## Build

```sh
bun run build          # tsc + vite build → ../public
# or, via the orchestration script:
bun run build.ts       # same, structured for a later Python hand-off
```

Output lands in **`../public`** (`public/index.html` + `public/assets/*`). The
existing `app/static` tree is left untouched.

Type-check only:

```sh
bun run typecheck
```

## Serving (later phase)

Wiring the FastAPI server to serve `public/` as the SPA (catch-all route, deep-link
fallback, and the OpenGraph meta injection currently in `download_page`) is **not yet
done** — no Python files have been modified. When that lands, fill in step 2 of
`build.ts` and use `bun run build.ts --serve` to build-then-serve in one command.

## Layout

```
client/
  src/
    lib/         api client, key/share-url helpers, crypto+zip, file icons
    workers/     aead-worker.js  (verbatim copy — FUPL v1 AEAD)
    providers/   Toast + Dialog (alert/confirm/prompt) context
    auth/        useAuth, RequireAuth, RequireMaster
    components/  shared Tailwind UI (Button, Card, Modal, Tabs, …)
    pages/       Login, Change, Files, Admin, ApiDocs, Directory, Download
    App.tsx      routes
    main.tsx     entry
```
