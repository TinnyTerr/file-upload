# Drive rework — progress

Full plan: `~/.claude/plans/ok-we-need-to-declarative-anchor.md`

**State:** Part A complete and verified against a running server. Part B stages
B-0 through B-7 complete — the new explorer is live at `/files`, rows are
virtualized, and copy/paste is backed by two new server endpoints that have been
exercised end to end. `bun run typecheck`, `bun --cwd=client run build` and
`bunx --bun @biomejs/biome check` are all clean.

**Still untested in a browser.** Everything below has been typechecked, built
and (for the backend) driven through curl against an isolated scratch DB, but
nobody has clicked on any of it.

---

## Part A — post-upload key reveal ✅ DONE

The reported bug ("encrypting post-upload doesn't show the key, or the popup
never comes up") turned out to be **five** separate defects, one of which was
silently corrupting files.

### A-1 ✅ `RevealedKeyProvider`
- **New** `client/src/features/drive/hooks/useRevealedKeys.tsx` — queue of
  `RevealedKey`, plus a tab-lifetime `keyFor`/`remember`/`forget` map of keys the
  browser genuinely holds.
- Mounted in `client/src/main.tsx` **above** `BrowserRouter`.
- Persists to `sessionStorage` (`fu_pending_keys@v1`, `fu_held_keys@v1`) so a
  reload mid-flow can't destroy the only copy of a key. Deliberately *not*
  `localStorage` — reasoning is in the file's doc comment.
- `beforeunload` guard while a key is on screen.
- `SealKeyDialog` now imports its type from the hook, gained an `incomplete`
  banner and a **Download-as-.txt** button (the retype gate was the only exit,
  so a locked-down clipboard trapped the user).

**Root cause it fixes:** `EncryptionPanel.tsx` held `revealed` in local state and
rendered the dialog itself, but returns `null` when its `item` disappears. An E2E
conversion *purges the old file*, the drive refetches, the item vanishes, and the
dialog was unmounted milliseconds after appearing.

### A-2 ✅ Panel + convert dialog wired to the provider
- `EncryptionPanel` closes the Sheet **then** calls `reveal()`.
- `E2EConvertDialog` lost its `onRevealed` prop, calls `reveal()` directly, and
  gained `onConverted` so the panel closes before the reveal lands.
- Fixed: the panel was fetching the whole root listing every time it opened on a
  *file* (missing `enabled` flag on `useDriveChildren`).

### A-3 ✅ `ConversionResult`
`convert()` now returns `{ clientKeyB64, newFileId, committed }` (or `null` only
when nothing was uploaded). A failed commit still reveals the key — withholding
it would strand the uploaded ciphertext forever — but flags `incomplete`.

### A-4 ✅ Backend: honour an explicit `client` mode  ← **the data-corruption fix**
`server/src/routes/files.ts`:
- `prepareUpload` takes `clientCiphertext` and no longer clobbers an explicit
  `client` request with the destination folder's mode (was line ~185).
- `finalizeStoredFile` same (was line ~328).
- Both call sites pass `clientCiphertext: true`, matching what they already
  passed at finalize.

Before: converting a file inside a `none`/`server` folder stored real browser
ciphertext **recorded as plaintext**, then 400'd on commit. Verified fixed —
see "Verification" below.

### A-5 ✅ `sealed` treated as a user-held key
- `ShareModal` uses the existing `isKeyHeldByUser` instead of
  `mode === "client"`, so the "Key only" row appears for sealed files; the badge
  says *sealed*, not *server-encrypted*.
- Share actions thread `keyFor("file"|"folder", id)` instead of hardcoded `null`.
- **The unlocked-folder key moved out of `DriveUploadCard` state into the
  provider map**, keyed by directory id — a stale key encrypting uploads under
  the wrong folder's key is now structurally impossible rather than guarded by an
  effect. `CreateFolderDialog` also remembers keys it mints.

### A-6 ✅ Hardening
- **Seal section is now permission-gated** (`can_delete` + ownership). This was
  almost certainly the reported "popup doesn't come up at all": the route
  requires both, the UI checked neither, so anyone else got a 403 toast and no
  dialog.
- A too-short seal password is refused inline instead of silently becoming a
  random key.
- `server/src/storage/rekey.ts`: calls `ensureBlobAvailable` before
  `memberSource` (on a `REPLICATION_MODE=cache` node with an evicted blob, seal
  and every encryption change 500'd while the E2E path worked), and
  `deleteThumbnail` after rewriting (thumbnails are keyed by file id and not
  ref-counted — a prerequisite for any owner-side thumbnail endpoint).
- A dropped connection during a seal now says "the seal may have completed"
  rather than "couldn't seal", because the DB commit precedes the response.

### Verification (done, against an isolated scratch DB on :8099)
| Check | Result |
|---|---|
| Convert a file inside a `server` folder to E2E | `encryption_mode=client`, `encryption_overridden=1`, `enc_key_blob NULL`, `stored_size == size` (proves no double-encryption), commit **HTTP 200** (was 400) |
| Seal, random key | returns the key, `mode=sealed`, `access_key: null` |
| Seal, password key | returns `key_is_password: true`, `seal_kdf: pbkdf2-sha256-600000` |
| `client` upload at root without `can_upload_client_encrypted` | 403 (unchanged) |
| `client` upload into a `none` folder without the permission | **403** (was silently stored as `none`) |
| Plain upload into the same folder | 200 |
| **Regression:** anonymous dropbox upload into a `client` folder | **409** "this folder is end-to-end encrypted…" ✅ |
| Legit browser upload into a `client` folder | 200 |

---

## Part B — Windows 11 explorer

### B-0 ✅ Deps + primitives
- Installed `react-resizable-panels@4`, `@tanstack/react-virtual@3`,
  `@radix-ui/react-popover`.
- **Did not** add `@radix-ui/react-context-menu`: added
  `Sub`/`SubTrigger`/`SubContent`/`RadioGroup`/`RadioItem`/`Shortcut` exports to
  `components/ui/dropdown-menu.tsx`, so the existing custom `context-menu.tsx`
  gains submenus with zero migration.
- **New** `components/ui/popover.tsx` (menus can't host form inputs — their items
  steal typeahead and arrows).
- ⚠️ `react-resizable-panels` v4 has a **different API** than the v3 the plan
  assumed: `Group`/`Panel`/`Separator`/`useDefaultLayout`, sizes are unit
  strings (`"20%"`), no `order` prop. `ExplorerShell` is written against v4.

### B-1 ✅ Explorer shell (and much of B-2/B-3/B-4/B-5 came with it)
The stages turned out to be too interlocked to ship separately — selection lives
in `ExplorerPage` and the command bar, tree, menus and key map all need it — so
the shell landed with its panes already real rather than wrapping the old listing.

**New files** under `client/src/features/drive/`:

*Components* (`components/explorer/`): `ExplorerPage`, `ExplorerShell`,
`AddressBar`, `CommandBar`, `StatusBar`, `NavTree`, `NavTreeNode`, `FileList`,
`ColumnHeader`, `ItemRow`, `ItemTile`, `ItemThumb`, `InlineRename`,
`DropOverlay`, `DetailsPane`, `UploadMenu` (+`NewMenu`), `BackgroundMenu`,
`panes/{DetailRow,FolderDetails,FileDetails,TransfersSection}`.

*Hooks*: `useExplorer` (context), `useExplorerPrefs`, `useNavHistory`,
`useDriveActions`, `useDropTarget`, `useExplorerKeys`, `useMarquee`,
`useClipboard`, `useExplorerUpload`, `useThumbnail`.

*Lib*: `columns.ts`, `sorting.ts`, `typeLabel.ts`, `dropEntries.ts`.

**Modified**: `App.tsx` (route → `ExplorerPage`), `AppShell.tsx` (full-bleed on
`/files` only, via `useMatch`), `useDriveSelection.ts` (added `setSelected`,
`selectOnly`, `extendTo`, `anchorKey`), `CreateFolderDialog` (controllable
`open`/`onOpenChange`).

**Deleted**: `DrivePage`, `DriveListing`, `DriveBreadcrumbs`, `CurrentFolderBar`,
`FolderTile`, `SelectionBar`, `DriveUploadCard`, `DriveSidePanel`,
`RenameDialog`.

**What works now:** three resizable panes with persisted widths; address bar with
back/forward/up/refresh, collapsing breadcrumbs, click-to-edit path and a
scoped search filter; command bar where every button explains *why* it's
disabled; four view modes; sortable + resizable + hideable Details columns;
hover checkboxes; marquee selection; drag anywhere (background, rows, tree nodes,
breadcrumbs, "up") with a full-pane overlay; OS folder drop via
`webkitGetAsEntry`; inline F2 rename; full keyboard map; details pane absorbing
everything `CurrentFolderBar` did; status bar with counts, selection size and
quota.

### B-3/B-4/B-5 punch list ✅ cleared

- **Column chooser** now opens on right-click. It was wired to
  `DropdownMenuTrigger`, which listens for *click* — so it hijacked every sort
  click in the header. It uses the app's own `components/ui/context-menu.tsx`
  (which already anchors a dropdown at the cursor), and toggling a column no
  longer closes the menu.
- **`UploadMenu`'s options popover** shared the chevron as its anchor via
  `PopoverAnchor` instead of a zero-size `span`, so it opens from the button.
  `onCloseAutoFocus` stops the closing menu yanking focus back off the popover.
- **`isCut` is wired**: it went onto `ExplorerContext`, and `FileList` passes it
  to every row and tile, so cut items dim.
- **Escape cascade** implemented as a real cascade: a live marquee cancels
  first (a capture-phase listener in `useMarquee`, which beats the window
  listener in `useExplorerKeys`) and restores the pre-drag selection; a rename
  is handled by the input; then the cut queue; then the selection.
- **`useDropTarget` takes `DropZone | null`.** Files no longer register a
  phantom `{kind:"current"}` zone just to keep hook order stable.
- **List view** is now a dense single-column list rather than a CSS
  multi-column flow. `useExplorerKeys` already treated it as a vertical list
  (`grid` is false for `list`), so the two now agree about what ↓ means.
- **Right-click on a row vs. the background** is not a problem after all:
  `ContextMenu` already calls `stopPropagation()` on the inner handler, so the
  row's menu wins over the pane's.

### B-6 ✅ virtualization + thumbnails

`FileList` virtualizes every view through `@tanstack/react-virtual`. Items are
chunked into rows of *n*, where *n* is measured from the pane with a
`ResizeObserver` rather than guessed from a breakpoint — the nav and details
panes are resizable, so a static guess would be wrong most of the time. Rows
report their real height back via `measureElement` (a name wraps to two lines in
the icons view, so a fixed estimate would drift).

Two details worth keeping: the Details view states its own `minWidth` from the
column widths, because absolutely positioned rows contribute nothing to their
container's width and horizontal scrolling would otherwise break; and the
virtualizer takes a `scrollMargin` equal to the column header's height, since
the header sits inside the same scroll container.

`useThumbnail`/`ItemThumb` are unchanged and still unverified against a live
`GET /file/:slug/thumbnail`.

### B-7 ✅ clipboard, with real copy endpoints

**New:** `POST /api/files/:id/copy` and `POST /api/directories/:id/copy`, lifted
from the save-from-share handlers. A copy writes no bytes — it bumps
`content_blobs.ref_count` and inserts a row carrying the *resolved* encryption —
but is charged against the caller's logical quota.

Rules, in both:
- inherit from the destination when the resolved key material is byte-identical,
  otherwise become a break point holding a materialised key;
- **refuse a `client`/`sealed` destination with 409**, the same refusal
  `finalizeStoredFile` makes and for the same reason: the server holds no key,
  so it cannot decide the copy's inheritance without lying about it. Copying
  *out of* an e2e folder is allowed;
- folders additionally guard `isSelfOrDescendant` and `MAX_DEPTH`, and name a
  colliding copy `<title> - Copy`;
- `directories.total_bytes` counts direct files only, so a folder copy does not
  touch the destination's total — the same thing the move handler does.

`useClipboard` grew a real `copy`; a copy stays on the clipboard after a paste
(pasting the same thing into three folders is the point), a cut doesn't.
`docs/api.md` documents both endpoints.

Verified against an isolated scratch DB on :8099:

| Check | Result |
|---|---|
| Copy a file out of a `server` folder to the root | new row, `encryption_overridden=1`, key materialised, **bytes read back as plaintext through `/content`** |
| Copy a file into a folder on the same key chain | `encryption_overridden=0`, key columns NULL — it inherits |
| Copy a folder to the root | whole subtree copied, every descendant inheriting, `A - Copy` |
| Copy a folder into another folder on the same chain | root copy inherits too (`overridden=0`) |
| `ref_count` after 5 references to one blob | `5` — no bytes duplicated |
| Links minted | 7 file links for 7 files, 4 folder links for 4 folders |
| Copy into a `client` folder (file and folder) | **409** "this folder is end-to-end encrypted…" |
| Copy a folder into its own subfolder | 400 |
| Copy someone else's file | 403 "not your file" |
| Copy without `can_upload` (file, and folder) | 403 |
| Copy without `can_create_directories` (folder) | 403 |
| Copy over quota | 413 "copy would exceed your quota" |
| Destination `total_bytes` after a folder copy | unchanged, as after a move |

### Housekeeping ✅
- Deleted the dead `useFolderUpload.ts` and `useAddFiles.ts`.
- `ExplorerPage` is lazy-loaded like every other route: the entry chunk went
  from 504 kB to 313 kB, with the explorer in its own 198 kB chunk.
- Fixed a genuine conditional-hook bug in `AppShell`: `useMatch(a) || useMatch(b)`
  short-circuits the second hook.
- Scratch test data lives in the session scratchpad. The repo's `data/` was
  never written to.

---

## Remaining checklist

### Must do before this is shippable
- [ ] **Run it.** Nothing in Part B has been exercised in a browser — only
      typecheck, build, and curl against the backend. Start with `bun run dev`.
- [ ] **`AddressBar` breadcrumb drop zones** use `{kind:"parent", id}`, which
      accepts moves but refuses OS-file drops (no `Directory` row to check the
      encryption mode against). Confirm that reads as intentional, or fetch the
      row and allow uploads.
- [ ] **Keyboard model untested end to end.** In particular: `Backspace` as
      "up one folder" fires whenever focus isn't in an input — check it doesn't
      surprise anyone; the `document.body.style.pointerEvents === "none"` modal
      guard needs a real dialog to verify.
- [ ] **Virtualized layout untested visually.** The row estimates
      (`METRICS` in `FileList.tsx`) are first guesses that `measureElement`
      corrects — watch for a jump on first paint in the icons view.
- [ ] Verify the **`client`-folder upload refusal**: dropping OS files on a
      locked E2E folder should raise `UnlockFolderDialog` and then resume the
      queued upload (`useExplorerUpload.resumePending`).

### B-2 — remainder
- [ ] Per-file **preview** (double-click an image/video opens a viewer). The
      public `folder-view` feature already has `FolderFilePreviewModal` worth
      sharing.
- [ ] Details pane on mobile (currently `hidden lg:block`) — needs a sheet.

### B-5 — remainder
- [ ] Nav tree has `role="tree"` but **no roving-tabindex keyboard navigation**.

### B-6 — remainder
- [ ] `useThumbnail` is used by `ItemThumb` but unverified against a real
      `GET /file/:slug/thumbnail`.
- [ ] Optional: owner-side `GET /api/files/:id/thumbnail` (needs the A-6
      `deleteThumbnail` fix first, which is done).

### B-8 — not started
- [ ] `GET /api/directories/search?q=&limit=200` for cross-folder search. The
      search box today filters **the open folder only** and says so in its
      placeholder.

### Known limitations, deliberate
- **"Date added", not "Date modified"** — there is no modification timestamp in
  the schema. Mention it in release notes.
- **Copying into an end-to-end folder is refused.** Doing it properly is a
  browser-side operation (download, decrypt, re-encrypt, re-upload), the same
  shape as `POST /files/:id/e2e-conversion`.
