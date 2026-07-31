# Mega-style Drive Rework — Build Plan

This is a build plan for an executing AI (a future Claude Code session in this
repo). Read `CLAUDE.md` first — everything in it still applies. This plan does
not repeat conventions already documented there (asyncHandler, ensureColumn,
TABLE_COLUMNS, etc.) — it just tells you *what* to build, phase by phase.

## How to work through this plan

- **One phase at a time, in order.** Do not start phase N+1 until phase N is
  checked off in `checklist.md`.
- After finishing a phase: update `checklist.md` (check the box, add 1-3
  lines under it about what you actually did and any deviations from this
  plan), run `bun run typecheck`, sanity-check the server still boots
  (`bun run start` or `bun run dev`), then **stop and wait for the user**.
  Do not chain into the next phase automatically.
- Every phase must leave the app in a working, deployable state. No
  half-finished endpoints, no broken builds. The user has limited usage and
  wants to push after every phase without worrying about what state things
  are in.
- Phases 1-9 are backend-only (schema, routes, crypto). Phases 10-15 are
  frontend. If usage runs out after phase 9, the backend is complete and
  correct on its own (old UI still works against it — the old flat
  Files/Folder endpoints keep working unless a phase explicitly says
  otherwise) and the rest can resume later in a fresh session by reading this
  file + `checklist.md`.
- If something in this plan turns out to be wrong once you're looking at the
  real code for that phase, use your judgment, note the deviation in
  `checklist.md`, and keep going — don't block on re-confirming trivial
  details.

---

## The design (read this before touching code)

### Nesting

`directories` gets a nullable self-referential `parent_directory_id`. A
directory with `parent_directory_id IS NULL` is a root-level item (today's
behavior, unchanged). Max depth is **10** — a directory may have at most 10
ancestors. Enforce this on both create and move (moving a subtree can push
descendants deeper, so re-check the whole subtree's depth on move, not just
the target node).

Files already have `directory_id` (nullable = root-level file). That doesn't
change shape, just meaning: it can now point at a directory at any depth.

Collaborator access (`directory_collaborators`) granted on a directory must
apply to every descendant, not just direct children — walking up a chain of
at most 10 is cheap, so permission checks (`isEditor`, `directoryRole` in
`routes/directories.ts`) become "walk ancestors until you find a
grant-or-owner, or run out."

### Encryption inheritance model

This is the part the user was unsure about. Confirmed design, spelled out
with the exact example that was used to confirm it:

> directory1 contains directory2 and directory3. Encrypt directory1
> server-side, copy its link — visiting it decrypts everything under it
> (directory2, directory3, and their files). You can *also* decrypt
> directory2 entirely and share it individually — directory1's link still
> works and shows directory2's contents too, now in plaintext. You can also
> change directory3's key — that breaks it from directory1; directory1's
> link/key no longer opens directory3.

Mechanism: every directory and every file gets a new boolean,
**`encryption_overridden`**.

- `encryption_overridden = 0` ("inherits"): this node has no key of its own.
  Its *effective* encryption state is whatever the nearest ancestor with
  `encryption_overridden = 1` has. Default for every newly created child of
  an encrypted parent.
- `encryption_overridden = 1` ("break point"): this node defines its own
  `encryption_mode` + `enc_key_blob` + `enc_access_blob`, ignoring whatever
  is above it. This is how directory2 (set to `none`, forcing plaintext) and
  directory3 (set to `server` with a fresh key) break away from directory1
  in the example above. A root-level directory (`parent_directory_id IS
  NULL`) is always `encryption_overridden = 1` — there's nothing above it to
  inherit from.

Resolving a node's *effective* encryption (what key actually protects its
bytes right now) means: walk up from the node (or from a file's containing
directory) until you hit a row with `encryption_overridden = 1`, and use
that row's mode/key. Write this once as a shared resolver — every read path
(download, preview, zip, streaming) must use it instead of reading a
directory's/file's own columns directly.

**Directories** only ever use `encryption_mode` ∈ `none | server` — there is
no directory-level `client` (E2E) mode anymore. Existing rows using
`client` at the directory level (check for any at migration time) get
migrated to `encryption_overridden = 1`, `encryption_mode` unchanged for
compatibility — but new directory creation should only offer `none`/`server`
going forward (see phase 3 note).

**Files** keep all three: `none | server | client`, plus a new fourth value
`sealed` (Seal & Forget, phase 8). `none`/`server` on a file follow the same
inherit/override mechanism (inheriting from the containing directory chain
when `encryption_overridden = 0`). `client` and `sealed` are **always**
`encryption_overridden = 1` — they're never inherited, only ever set
directly on that one file (E2E is fundamentally a browser-side, per-upload
operation; see below).

Migration note: every existing directory and file row gets
`encryption_overridden = 1` on backfill. This is correct, not just safe —
today's model has no inheritance at all, so every existing row already *is*
its own break point. The resolver degrades to today's exact behavior for all
pre-existing data.

### Changing encryption after the fact

- **`none <-> server`**, on a directory or a file: freely toggleable at any
  time, any direction, since the server holds the keys either way. This
  physically rewrites stored bytes (decrypt/re-encrypt, content-addressed
  storage means this is a real byte rewrite, not a metadata flip) but can
  run as a plain synchronous request/background pass — no browser
  involvement needed.
- **`client` (E2E)**: only ever set at upload time, client-side, before
  ciphertext reaches the server. There is no in-place conversion *into*
  `client` mode for an existing file — going to E2E means: browser
  downloads the current plaintext (or decrypts current ciphertext if
  already encrypted, given the key), re-encrypts with a fresh E2E key in
  the browser, uploads as a fresh file. Converting *out of* `client`/`sealed`
  mode ("permanently decrypt") means: the browser is given the key, fetches
  the ciphertext, decrypts client-side, then re-uploads the plaintext
  through the normal finalize flow with whatever new mode is wanted. Both
  directions are "browser does the crypto work, then a normal upload
  happens" — no special backend re-encryption endpoint is needed for
  anything touching `client` mode. The old file+links get deleted after the
  new one is confirmed; audit-log this as `file.e2e_decrypted` /
  `file.e2e_reencrypted` so it's visible that plaintext transited the server
  at that moment (it always does for a normal upload — the point of the log
  entry is marking *when* previously-E2E content stopped being E2E).

### Seal & Forget (file-only, new `sealed` mode)

Encrypts an *already-uploaded* file server-side (no reupload needed — the
server already has the plaintext on disk), generates a fresh key, encrypts
in place (new blob — content-addressed dedup means this can't just mutate
the existing blob if it's shared), returns the key to the caller **exactly
once** in the API response, and does not persist it anywhere
(`enc_key_blob = NULL`). From that moment, the server cannot decrypt the
file — every read path (`storage/streaming.ts`, `routes/public.ts`,
`storage/zip.ts`) must treat `sealed` exactly like `client`: require the
caller to supply the key (URL fragment, never sent to the server as a query
param the way `?ek=` server-mode tokens are — same handling as `client`
mode's `#ek=`).

The distinction from true `client`/E2E, worth surfacing honestly in the UI:
Seal & Forget's key passed through server memory for one operation (the
sealing itself), even though it's discarded immediately after and never
touches disk or logs. True `client` mode content never exists as plaintext
on the server at all. Same protection against "attacker steals the disk /
database," different protection against "attacker controls the server at
the moment of sealing." Say this plainly in the UI tooltip, don't market it
as identical to E2E.

### Password locks

An alternate form of the existing `server`-mode access secret. Today,
`server` mode's access gate (`?ek=` on files, same on directories) is a
random token (`randomBytes(18).toString("base64url")`) sealed under the
master key, recoverable by the owner. Add the option for the owner to
supply their own memorable password instead of a random token, for both
directories and files, combinable with Seal & Forget (the "forgotten" key
can be a chosen password instead of a random string, so the user has
something to remember instead of something to write down).

This changes the threat model of the access gate from "high-entropy
capability token, brute force is infeasible" to "human password, brute
force over the network is very feasible" — so public verification of a
password-locked `?ek=`/fragment **must** be rate-limited per slug, reusing
the shape of `security/lockout.ts` (rolling window, lock the slug out
temporarily after N failed attempts). This is new work, not automatically
covered by the existing per-username/per-IP login lockout.

### Locked-node navigation

Browsing a shared directory (`/d/:slug`) and navigating into a descendant
whose effective encryption differs from what the visitor currently holds
(a `encryption_overridden = 1` node further down, or a password-locked
node) must prompt inline for that node's key/password, with a way to back
out (a "back" control) if the visitor doesn't have it — never a dead end.

### 2FA/passkey-required permissions

Two new boolean permission flags, following the exact recipe already
documented in `CLAUDE.md` under "Permissions" (`schema.sql`, `ensureColumn`
in `db/sqlite.ts`, `db/rows.ts`, `permissions.ts`'s `BOOL_FLAGS` + master
seed, `bootstrap.ts`, `MASTER_ALL_TRUE` in `routes/users.ts`, the
`/account/me` payload in `routes/account.ts`, `TABLE_COLUMNS.permissions` in
`cluster/replication.ts`, `client/src/config/permissions.ts`):

- `require_mfa` — this user must have at least one MFA credential (TOTP or
  WebAuthn) enrolled and must complete second-factor at login. Generalizes
  the existing per-user `users.mfa_required` column into the standard
  permission system; keep the existing `role === "master"` special case in
  the login flow additively (`mfaRequired = user.role === "master" ||
  perm.require_mfa`), don't remove it.
- `require_passkey` — this user must specifically have a WebAuthn credential
  enrolled (TOTP alone isn't sufficient). Independent flag — a user can have
  `require_mfa` without `require_passkey` (any second factor is fine) or
  both (must be a passkey specifically).

An account with either flag set but missing the required credential type
must be blocked from everything except the MFA enrollment endpoints —
mirror the existing `must_change_credentials` gate pattern in
`requireActiveUser` (403 everywhere except the one path that lets them fix
it).

### Unified Drive explorer

Replace the Files tab + Folder tab with one page: breadcrumbs, a single
tree-aware view (folders and files together, current directory's children
only — lazy-loaded, not a full recursive dump), upload-into-current-folder,
create-folder, rename, move (drag-and-drop *and* a "Move to" dialog),
multi-select, right-click context menu, delete. Keep Dropbox/Remote-upload
as their own tabs (they're a different mental model — receiving uploads
from someone else / pulling from a URL) but point their "destination
folder" pickers at the new tree instead of a flat `<select>`.

### Gallery / showcase mode for any shared folder

The existing media library (`directories.is_library`, `library_visibility`,
`library_kind`, `routes/media.ts`, `client/src/features/media/*`) stays
exactly as-is — don't touch it, don't remove it, it's the global `/watch`
catalog. Separately, give the **public folder viewer** (`/d/:slug`,
currently `FolderPage.tsx` + `GET /d/:slug/preview-manifest`, which already
groups members into images/videos/audio/text/pdfs/archives — most of the
grouping logic already exists) an optional "gallery view" toggle: instead of
a flat file list with download links, render subfolder cards plus playable
video/audio (inline `<video>`/`<audio>`, same streaming endpoints the media
library already uses) and image/file previews, in the same visual language
as the existing `MediaPosterCard`/`WatchLayout` components. Reuse those
components/styles rather than re-implementing them — this is "copy the
Netflix-style implementation to the general folder view," not a rewrite of
it. This view also needs real nested navigation (breadcrumbs, subfolder
tiles) since folders can now contain folders.

---

## Phase list

Each phase below is meant to be small — a focused session, not a marathon.
See `checklist.md` for the literal checkboxes to update.

1. **2FA/passkey required permissions** (backend + tiny client data file)
2. **Directory tree schema** (backend, additive/safe)
3. **Directory CRUD: nesting, rename, move, recursive delete** (backend)
4. **File placement: move, rename, tree data endpoint** (backend)
5. **Encryption inheritance resolver** (backend, careful)
6. **Directory/file encryption override + rekey endpoints** (backend)
7. **Password-lock access secrets** (backend)
8. **Seal & Forget** (backend)
9. **E2E conversion audit glue** (backend, small)
10. **Unified Drive explorer shell** (frontend)
11. **Move / rename / right-click / multi-select** (frontend)
12. **Encryption side panel: override, rekey, password lock, Seal & Forget, E2E convert** (frontend)
13. **Public folder viewer: nested browsing + lock prompts** (frontend)
14. **Gallery/showcase mode for shared folders** (frontend)
15. **Cleanup pass: admin panel, remaining pickers, docs** (backend + frontend, small)

---

## Phase details

### Phase 1 — 2FA/passkey required permissions

- Add `require_mfa`, `require_passkey` to `permissions` (schema.sql +
  ensureColumn, default 0 for both).
- Follow the exact "adding a permission flag" checklist from `CLAUDE.md`
  for both flags.
- `routes/auth.ts` login flow: `mfaRequired = user.role === "master" ||
  perm.require_mfa || perm.require_passkey` (passkey requirement implies MFA
  is required too, just narrows *which* factor is acceptable).
- Add a gate (alongside/near `requireActiveUser` in `middleware/deps.ts`):
  if `require_mfa` and the user has zero rows in `credentials`, or if
  `require_passkey` and the user has zero `credentials` rows with
  `kind = 'webauthn'`, block every route except the MFA enrollment
  endpoints (`/api/account/mfa/*`) and logout, same shape as the existing
  `must_change_credentials` block.
- `client/src/config/permissions.ts`: add both flags to the list the admin
  Permissions dialog renders from. Confirm `PermissionsDialog.tsx` is
  data-driven off this file (it should be, given every other flag works
  this way) — if it isn't, add the two checkboxes there directly.
- No new UI screens needed beyond the permission checkboxes and whatever
  the existing 403 error handling already shows for a blocked account —
  confirm the client doesn't crash on this new 403 shape, add a minimal
  "you must set up 2FA to continue" redirect if it does.

### Phase 2 — Directory tree schema

- `directories`: add `parent_directory_id INTEGER REFERENCES
  directories(id)`, `encryption_overridden INTEGER NOT NULL DEFAULT 1`.
- `files`: add `encryption_overridden INTEGER NOT NULL DEFAULT 1`.
- `ensureColumn` backfills for all three (defaults above are correct for
  every pre-existing row — see "Migration note" above).
- New index: `ix_directories_parent_directory_id`.
- `cluster/replication.ts` `TABLE_COLUMNS`: add the new columns for both
  `directories` and `files`.
- New helper module (suggest `server/src/directoryTree.ts`): `MAX_DEPTH =
  10`, `ancestorChain(db, directoryId): DirectoryRow[]` (walks
  `parent_directory_id` up to root, throws/bails if it somehow exceeds
  `MAX_DEPTH` — that would mean corrupt data, not a normal case),
  `depthOf(db, directoryId): number`.
- No route changes. No behavior changes. This phase is pure schema +
  helpers so it's safe to land and push on its own.

### Phase 3 — Directory CRUD: nesting, rename, move, recursive delete

- `POST /directories`: accept `parent_directory_id`. Validate: parent
  exists, requester is editor on parent (or parent is null = root),
  resulting depth ≤ `MAX_DEPTH`. New directories default
  `encryption_overridden = 0` when the parent's *effective* encryption
  mode is `server` (inherit by default), else `1` (nothing to inherit,
  matches root behavior). Directory creation should stop offering `client`
  as a directory-level `encryption_mode` choice going forward (still valid
  to read on old rows, per the migration note).
- New `PATCH /directories/:id` — rename (`title`).
- New `PATCH /directories/:id/move` — change `parent_directory_id`.
  Validate: requester is editor on both source-parent and target-parent,
  target isn't the directory itself or one of its own descendants (cycle
  check — walk the target's ancestor chain, reject if the moving
  directory appears in it), and re-check depth for the *entire moving
  subtree* (find its current max depth below itself, make sure
  `newDepth + thatSubtreeHeight ≤ MAX_DEPTH`).
- `DELETE /directories/:id`: recurse into child directories before
  deleting (currently only deletes direct file children — extend to walk
  the subtree depth-first, deleting files then directories, bottom-up).
- `isEditor`/`directoryRole` in `routes/directories.ts`: change from
  "check `directory_collaborators` for this exact directory" to "walk the
  ancestor chain (via the phase 2 helper), check each ancestor for a
  matching collaborator row or ownership, first match wins."

### Phase 4 — File placement: move, rename, tree data endpoint

- New `PATCH /files/:id/move` — change `directory_id`. Validate editor
  rights on the target directory (or root, if permitted).
- New `PATCH /files/:id` — rename (`original_filename`), if no such
  endpoint exists yet.
- New `GET /directories/:dirId/children` (and a root variant, e.g.
  `GET /directories/root/children` or `dirId` accepting the literal
  string `root`) returning `{ directories: [...], files: [...] }` for
  that one level only — this is the data endpoint the explorer (phase 10)
  will call as the user navigates, not a full recursive tree dump.

### Phase 5 — Encryption inheritance resolver

- New module, e.g. `server/src/crypto/effectiveEncryption.ts`:
  `resolveDirectoryEncryption(db, directory): { mode, keyBlob, accessBlob,
  sourceDirectoryId }` — if `directory.encryption_overridden`, return its
  own columns; else walk up via the phase 2 ancestor helper to the nearest
  `encryption_overridden = 1` ancestor (or "none" if it reaches root
  without finding one — shouldn't happen given root is always overridden,
  but handle it defensively) and return that one's columns.
  `resolveFileEncryption(db, file): { mode, keyBlob, accessBlob,
  sourceDirectoryId }` — if `file.encryption_overridden`, return the
  file's own columns; else resolve via the file's `directory_id` using the
  function above.
- Rewire every place that currently reads a directory's or file's
  `enc_key_blob`/`enc_access_blob`/`encryption_mode` directly for a
  *read/decrypt* path to go through the resolver instead:
  `routes/public.ts` (raw/preview handlers), `storage/streaming.ts`,
  `storage/zip.ts` (`memberSource`), `routes/directories.ts`
  (`publicFiles`, the `/d/:slug/zip` handler, `recoverDirAccessKey`).
  Upload-time key assignment (`routes/files.ts` finalize, currently line
  ~386-389 unwrapping the directory's key into `perFileKey`) should keep
  working the same way for the common case (uploading into a
  `server`-mode folder with no per-file override) but should call the
  resolver too, so a file uploaded into an *inheriting* subfolder correctly
  picks up whatever key its nearest overridden ancestor actually holds.
- Regression check before moving on: create a single-level `server`-mode
  folder the old way, upload a file into it, confirm it still
  downloads/decrypts correctly through `?ek=` after this phase — this
  exercises the resolver's "no inheritance, I am my own break point" path,
  which must be identical to pre-phase-5 behavior since every existing row
  has `encryption_overridden = 1`.

### Phase 6 — Directory/file encryption override + rekey endpoints

- `PATCH /directories/:id/encryption` — body picks one of: set own mode
  (`none` or `server`, generating a fresh key exactly like directory
  creation does today when going to `server`), or `adopt_parent` (set
  `encryption_overridden = 0`, clear own key columns, effective state now
  comes from its ancestor chain).
- `PATCH /files/:id/encryption` — same shape, `none`/`server` only here
  (not `client`/`sealed` — those are separate flows, phases 8/9).
- Either endpoint, when it changes what a node's *effective* key actually
  is, must re-encrypt every descendant file whose effective key currently
  resolves through this node and who isn't itself an override point.
  Walk the affected subtree, for each such file: decrypt with the old
  resolved key (if any), re-encrypt with the new one (if any), write as a
  new blob (content-addressed storage — can't mutate a shared blob in
  place, `ref_count` may be >1), update the file row, release the old
  blob ref. Do this synchronously in the request for now (per the user's
  "keep phases short" instruction — a background-job-with-progress version
  is a reasonable future improvement, not required here). Fine to leave a
  short comment noting that a large subtree makes this a slow request.

### Phase 7 — Password-lock access secrets

- Extend the access-secret shape for `server`-mode directories/files: an
  owner can supply a password instead of accepting the auto-generated
  random token. Store it the same way (sealed under the master key in
  `enc_access_blob`) — the only change is *where the secret comes from*,
  not how it's stored or checked, so `verifyDirAccessKey`/the file
  equivalent keep working unmodified.
- Public verification of a password-locked `?ek=`/fragment must be
  rate-limited per-slug. Add a new lockout identifier type (reuse
  `security/lockout.ts`'s shape — `checkLoginAllowed`/`recordFailure`/
  `resetSuccess` already take an arbitrary identifier + type) keyed on the
  link slug, not the requester's IP or username (a slug is the resource
  being guessed, not an account).

### Phase 8 — Seal & Forget

- New file `encryption_mode` value: `sealed`.
- `POST /files/:id/seal` — requester must be owner/editor. Reads the
  file's current plaintext (decrypting first if it currently has any
  encryption/compression/archival transform, using the phase 5 resolver),
  generates a fresh random key, encrypts to a new blob, updates the file
  row (`encryption_mode = 'sealed'`, `encryption_overridden = 1`,
  `enc_key_blob = NULL`, `enc_access_blob = NULL`), releases the old blob
  ref, and returns the raw key **once** in the response body — never
  logged, never persisted.
- Every read path from phase 5's rewiring must treat `sealed` exactly like
  `client`: no server-side decryption possible, caller must supply the key
  out-of-band (URL fragment), same handling `client` mode already has.

### Phase 9 — E2E conversion audit glue

- No new crypto engine needed — going into or out of `client`/`sealed`
  mode is a browser-side download-decrypt-reencrypt-reupload operation
  using the existing upload/finalize flow and the existing
  `client/src/workers/` AEAD worker. This phase is just making sure the
  backend supports it cleanly:
  - Confirm there's a way to delete the old file + its links right after
    the new one's upload is confirmed, without a race where both exist
    briefly under the same folder causing confusion (fine if both briefly
    exist — just document the expected client sequence: upload new file →
    confirm success → delete old file).
  - Add audit actions `file.e2e_sealed` (something became `client`/`sealed`)
    and `file.e2e_decrypted` (something left `client`/`sealed`) so this
    transition is visible in the audit log even though it's not a single
    atomic backend operation.

### Phase 10 — Unified Drive explorer shell

- New feature area (suggest `client/src/features/drive/`) replacing the
  Files tab and Folder tab's upload panel. Route-level: current directory
  in the URL (e.g. `/files/:dirId?` or a query param), breadcrumbs built
  from the ancestor chain (new small endpoint or client-side accumulation
  as the user navigates).
- Pulls from `GET /directories/:dirId/children` (phase 4). Renders folder
  tiles and file rows together. Upload (reuse existing `Dropzone` +
  `useUpload`) targets whatever directory is currently open. "New Folder"
  button targets the current directory as parent.
- No drag-drop, no right-click, no encryption UI yet — just browse,
  create, upload, open. This alone is a big visible milestone: nesting is
  usable end-to-end after this phase.

### Phase 11 — Move / rename / right-click / multi-select

- Drag-and-drop: drag a file/folder tile onto another folder tile to move
  it (calls the phase 3/4 move endpoints). Drag files from the OS onto a
  folder tile to upload into it directly (not just the current directory).
- Right-click context menu per item: rename, move (opens a folder-picker
  dialog for people who don't want to drag), delete, download, share.
- Multi-select (shift-click range, ctrl/cmd-click toggle) with a bulk
  action bar: move selected, delete selected.
- Keep it visually clean — this is the "feel like a real file explorer"
  phase, but don't over-build; a competent single-pane explorer, not a
  dual-pane power-user tool.

### Phase 12 — Encryption side panel

- Per-file/per-folder "Encryption" panel (side panel or dialog): shows
  current effective state — "Inherited from *[ancestor name]*" with a
  breadcrumb-style link to jump to that ancestor, or "Own key" if this
  node is an override point.
- Actions: set own encryption (`none`/`server`, generates new key),
  "Adopt parent's encryption" (only shown if currently overridden and a
  server-mode ancestor exists), password-lock toggle (phase 7), Seal &
  Forget button + a one-time key-reveal dialog that makes very clear the
  key will never be shown again (copy-to-clipboard, maybe a "type it
  again to confirm you saved it" step), and an E2E convert flow
  (download+decrypt+reupload wizard per phase 9's expected sequence, with
  a progress bar since this can take a while for a large tree — walk
  through file-by-file if the panel is opened on a folder).

### Phase 13 — Public folder viewer: nested browsing + lock prompts

- `FolderPage.tsx` (mounted at `/d/:slug`) becomes tree-aware: breadcrumbs,
  subfolder cards, navigate deeper without leaving the page.
- When navigating into a subfolder whose effective encryption differs from
  what the visitor currently holds (a break point below the entry point,
  or a password lock), show an inline unlock prompt (key/password field)
  before revealing that subfolder's contents, with a visible "back" action
  that always works even if the visitor never unlocks it.
- This does not change `/d/:slug/info` or `/d/:slug/preview-manifest`'s
  fundamental shape much — they already batch-fetch member files — but
  they need to become depth-aware (only the entry directory's direct tree
  going down, respecting per-node overrides) rather than assuming one flat
  encryption mode for the whole link.

### Phase 14 — Gallery/showcase mode for shared folders

- Add a toggle (per directory, or per directory_link) for "gallery view"
  on the public folder page: same tree-nav from phase 13, but rendered
  using the existing media library's visual components
  (`MediaPosterCard`, `WatchLayout`, the video/audio player) instead of a
  plain file list. Subfolders show as cards you navigate into; video/audio
  files are playable inline; images get a lightbox/preview; everything
  else falls back to a normal preview/download row.
- Do not touch or duplicate the existing `is_library`/`/watch` system —
  that stays exactly as it is today, for the global curated catalog. This
  is a separate, per-folder opt-in that happens to borrow its component
  library.

### Phase 15 — Cleanup pass

- Admin panel: `FilesTab`/directory listings show a path/breadcrumb
  instead of (or alongside) the flat owner-grouped list, so nested items
  are identifiable.
- Dropbox upload link target picker, remote-upload target picker, torrent
  destination picker: swap flat `<select>` for a folder-tree picker
  (can reuse whatever picker component phase 11's "Move" dialog built).
- Update `docs/api.md` for every endpoint added or changed across phases
  1-9 (this is the single source of truth per `CLAUDE.md` — don't also
  write inline docs elsewhere).
- Final pass through `CLAUDE.md`'s "Gotchas / invariants" list with this
  rework specifically in mind: confirm every new column landed in
  `cluster/replication.ts`'s `TABLE_COLUMNS`, every new async handler is
  wrapped in `asyncHandler`, every new filesystem path goes through
  `safeJoin`, and the user-deletion cascade (`CLAUDE.md`'s "Deleting a
  user requires clearing every table that FKs to `users`" list) still
  covers everything if any new tables were added.
