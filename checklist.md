# Build checklist — Mega-style Drive rework

Companion to `plan.md`. Check a box only after the phase is actually done,
typechecked, and the app boots. Add 1-3 lines under each item noting what you
actually did and any deviations from `plan.md`. Stop after checking a box —
don't start the next phase in the same session unless told to.

- [x] **Phase 1** — 2FA/passkey required permissions (backend + tiny client data file)
      Added `require_mfa` / `require_passkey` through the full flag recipe (schema, ensureColumn,
      rows, BOOL_FLAGS, /account/me, replication TABLE_COLUMNS, client `PERMISSION_FLAGS`/`PERMISSION_META`
      under a new "security" group). Enforcement: `missingRequiredCredential()` gates `requireActiveUser`,
      `getUploadUser` and `requireReadUser` with a distinct 403 (`"mfa|passkey enrollment required"`);
      login uses `mfaEnforcedFor()`, and `require_passkey` filters the offered `methods` to webauthn and
      makes `/totp/verify-login` 403.
      **Deviations:** (1) the two flags are deliberately *not* in `MASTER_ALL_TRUE` or the master seed
      inserts — they are restrictions, not capabilities, and forcing them on would lock every admin out;
      masters keep their existing role-based MFA enforcement. (2) The client did not crash on the new 403
      but did dead-end on `/account/change`, so it now distinguishes the two 403s (`mfaEnrollmentRequired`
      in the auth context) and routes to a new `/account/mfa-setup` page that reuses `SecurityTab`;
      `force_mfa_enrollment` at login now lands there too instead of the credentials page.

- [x] **Phase 2** — Directory tree schema (backend, additive/safe)
      Added `directories.parent_directory_id` + `directories.encryption_overridden` +
      `files.encryption_overridden` (schema, ensureColumn, rows, replication `TABLE_COLUMNS`) and
      `ix_directories_parent_directory_id`. New `server/src/directoryTree.ts`: `MAX_DEPTH = 10`,
      `ancestorChain`, `depthOf`, plus the helpers phases 3/4 needed anyway (`subtree`,
      `subtreeHeight`, `isSelfOrDescendant`, `childDirectories`, `nearestOverride`).
      **Deviation:** `directoryRole`/`isEditor` were moved *into* this module (out of
      `routes/directories.ts`) so `routes/files.ts` can share one ancestor-aware implementation —
      the two route files would otherwise have had to import each other. Verified the upgrade path
      by dropping all three columns from a populated DB and rebooting: they came back, the index
      was recreated, and a legacy row backfilled to `parent_directory_id = NULL,
      encryption_overridden = 1`.

- [x] **Phase 3** — Directory CRUD: nesting, rename, move, recursive delete (backend)
      `POST /directories` takes `parent_directory_id` (parent must exist, requester must be an
      editor of it, depth ≤ 10). New `PATCH /directories/:id` (rename) and
      `PATCH /directories/:id/move` (cycle check + whole-subtree depth check via `subtreeHeight`).
      `DELETE /directories/:id` walks the subtree bottom-up. `isEditor`/`directoryRole` now walk
      the ancestor chain, so a collaborator grant applies to everything beneath it.
      **Deviations:** (1) A child that inherits (`encryption_overridden = 0`) gets the resolved
      key/access/key-check blobs *copied* onto its own row rather than left NULL. Every read path
      still reads a row's own columns until the phase 5 resolver lands, and the copy is
      byte-identical to what that resolver will return — leaving them NULL would have made files
      uploaded into a subfolder of an encrypted folder silently plaintext in the meantime.
      (2) Backend still accepts `encryption_mode: "client"` for *root* folders; the current
      CreateFolderDialog offers it, and 400ing it now would break a working screen mid-plan.
      Nested creates reject it outright and always inherit. (3) Moving a folder promotes it to
      `encryption_overridden = 1`, keeping the key its bytes are already under — re-keying to the
      new parent is phase 6's explicit action, not a side effect of a drag. (4) Recursive delete
      refuses if the subtree contains a folder owned by someone else.

- [x] **Phase 4** — File placement: move, rename, tree data endpoint (backend)
      New `PATCH /files/:id` (rename; strips path segments out of `original_filename`),
      `PATCH /files/:id/move` (`directory_id: null` = root; fixes up both folders' `total_bytes`),
      and `GET /directories/root/children` + `GET /directories/:dirId/children` returning
      `{directory, breadcrumbs, directories, files}` for one level only. `serializeFiles` is now
      exported (and carries `directory_id` + `encryption_overridden`) so the children endpoint
      returns the same file shape as `/files`.
      **Deviations:** (1) `canEditDirectory` in `files.ts` now delegates to the ancestor-aware
      `isEditor`, so folder grants reach nested folders for uploads/dropbox too. (2) A moved file
      keeps its own key (`encryption_overridden = 1`) instead of being re-encrypted to the
      destination's key — a plaintext file dropped into an encrypted folder stays plaintext until
      phase 6's rekey endpoint exists. Only the owner (or a master) may move a file out to the root.
      Verified against a live server: 43/43 checks including inheritance through three levels, the
      depth-11 rejection, cycle/self-move rejection, breadcrumbs, `total_bytes` bookkeeping, and a
      file uploaded into a nested folder decrypting through its *ancestor's* `?ek=` (wrong/absent
      key → 401).

- [x] **Phase 5** — Encryption inheritance resolver (backend, careful)
      New `server/src/crypto/effectiveEncryption.ts`: `resolveDirectoryEncryption`,
      `resolveFileEncryption`, plus `recoverAccessSecret` / `accessSecretMatches` (the three
      copies of the `?ek=` recover-and-compare dance collapsed into one). Rewired every read
      path: `routes/public.ts` (raw/preview/thumbnail/info/og-tags), `storage/streaming.ts`
      (`plaintextStream`, `isDirectlyStreamable`), `storage/zip.ts::memberSource`,
      `routes/directories.ts` (`recoverDirAccessKey`, `verifyDirAccessKey`, `publicFiles`
      consumers, `/d/:slug/zip`, `/d/:slug/info`, preview-manifest, `archivePreview`),
      `routes/files.ts` (`recoverAccessKey`, `verifyFileAccessKey`, `serializeFiles`,
      batch-zip) and `routes/media.ts`. `memberSource` and `isDirectlyStreamable` now take
      a `Db`; `DirRow` in files.ts was replaced by the real `DirectoryRow`.
      **Deviations:** (1) **Reversed phase 3's key copying.** An inheriting row's key columns
      are now NULL — one copy of the key material, on the break point, so phase 6 can re-key
      without leaving stale duplicates. A missed read path fails loudly ("encryption key not
      stored") instead of silently using a stale key. (2) **`encryption_mode` stays a
      denormalized mirror** on inheriting rows (the resolver is still the authority). Making
      it meaningless would have broken the plain SQL filters in `jobs/lifecycle.ts`,
      `routes/admin.ts` and `storage/mediaProbe.ts`, which must not walk a tree per row —
      so anything that changes an effective mode must rewrite descendants' mirrors.
      (3) `finalizeStoredFile` now *derives* the mode from the target folder (resolved) and
      writes `encryption_overridden = 0` for files in folders, instead of copying the
      folder's key onto the file. Without that, a phase 6 folder re-key would skip every
      file in it. Callers that pass a directory (dropbox, remote upload, torrent import)
      can no longer get the mode wrong whatever they pass. (4) Both move handlers had to be
      fixed: promoting an inheriting node to a break point now **materializes** the key it
      was resolving to — the move is exactly what severs the chain, so leaving the columns
      NULL stranded everything underneath. (5) `/d/:slug/save` and `/file/:slug/save` copy
      *resolved* key material, since the copy lands at the root as its own break point.
      (6) Serialized folders/files gained `inherited_from_directory_id` for phase 12's
      "Inherited from …" affordance.
      Verified with a 42-check in-process harness (real Express app, throwaway DB under the
      session scratchpad): the plan's required regression (single-level server folder →
      upload → `?ek=` download) plus three-level inheritance, deep `?ek=` download through
      the root ancestor's key, wrong/absent key 401s, folder zip through an inherited key,
      preview refusal, a plaintext chain, and both move-promotion paths staying readable.

- [x] **Phase 6** — Directory/file encryption override + rekey endpoints (backend)
      New `PATCH /directories/:id/encryption` and `PATCH /files/:id/encryption`, both taking
      `{mode: "none"|"server"}` (become a break point; `server` mints a fresh key) or
      `{adopt_parent: true}` (drop the key, follow the chain again). New
      `server/src/storage/rekey.ts` does the byte rewrite: decrypt via `memberSource`,
      re-encrypt, `attachBlob` the new blob, `releaseBlob` the old. Synchronous, as the plan
      asks; the "large subtree = slow request" note is in the route comment. Audit actions
      `directory.encryption_changed` / `file.encryption_changed`.
      **Deviations:** (1) **Fixed a phase 3 rule the plan's own example depends on** — a
      child of a *plaintext* folder used to be its own break point ("nothing to inherit"),
      which meant encrypting a folder later never reached its existing subfolders. Children
      now always inherit; only a root folder is forced to be a break point. (2) A rewritten
      file lands untransformed (`compressed = 0`, `archived = 0`, `lifecycle_state =
      'active'`) — plaintext is what comes back out of `memberSource`, and re-deriving the
      original zstd layering would mean reproducing whichever of the two transform orders it
      was stored in. The archive sweep re-compresses it when it next goes idle. (3) The set
      of files a folder re-key rewrites is "everything below it whose effective state *is*
      the folder's current state", stopping at subfolders that hold their own key. That
      deliberately includes files pinning the key on their own row — every file predating
      phase 5 carries a copy of its folder's key, so the narrower "only `overridden = 0`"
      rule would make the feature a no-op on all existing data. (4) Crash safety: every
      affected file is first *pinned* to its current key (`pinFileEncryption`), so a failure
      part-way through leaves untouched files readable with the key they already had rather
      than pointing at a folder that has already moved on. (5) `client`/`sealed` are
      refused (409) on both endpoints and skipped by the subtree walk — the server has no
      key for them; that conversion is phase 9's browser-side flow.
      48-check suite: plaintext→server (including a nested subfolder), re-key to a fresh
      key with the old one going dead, a break-point subfolder walling off its subtree,
      `adopt_parent` in both directions, back to plaintext, a per-file override surviving a
      folder re-key, and the root-cannot-adopt / client-mode rejections. Phase 5's suite
      still passes (43).

- [x] **Phase 7** — Password-lock access secrets (backend)
      New `directories.access_is_password` / `files.access_is_password` (schema, ensureColumn,
      rows, replication `TABLE_COLUMNS`, resolver as `EffectiveEncryption.passwordLocked`) —
      the secret is still just sealed in `enc_access_blob`, exactly as the plan says; the flag
      only records *where it came from*, because that is what decides whether the public check
      has to be throttled. New `server/src/security/accessLock.ts::checkLinkAccess` is now the
      single implementation of "verify a presented `?ek=`", used by `/file/:slug/raw`,
      `/file/:slug/save`, `/d/:slug/zip` and `/d/:slug/save`. Passwords can be set at folder
      creation, via `PATCH /{directories,files}/:id/encryption` (`password` alongside
      `mode: "server"`), or swapped with no re-encryption at all through the new
      `PUT /directories/:id/access` and `PUT /files/:id/access` (empty body reverts to a random
      token). `/file/:slug/info` and `/d/:slug/info` now report `password_locked` so the public
      page knows to prompt for a password instead of a key.
      **Deviations:** (1) Lockout is keyed on the **slug** with a new `link_access` identifier
      type via two new `LockoutPolicy` methods (`isIdentifierLocked`, `resetIdentifier`) —
      the private `isLocked` was username/ip-only. A *missing* `?ek=` counts as a failed attempt,
      or the counter could be dodged by omitting the parameter; a wrong guess answers 401 and a
      locked-out slug 429. Changing a secret clears the counter on every one of that node's slugs.
      (2) Random-token links are deliberately left unthrottled — 144 bits is not a guessing
      target, and throttling them would let anyone lock a public link out of service.
      (3) The old "server-encrypted row with no access blob at all" allowance was file-only;
      that asymmetry is now explicit (`allowMissingSecret`) rather than accidental, and folders
      stay fail-closed. (4) An inheriting node refuses (409, naming the owner) rather than
      quietly taking a secret that reads would never consult.
      30-check suite plus a column-drop/reopen upgrade test: password at creation, minimum
      length, five wrong guesses tripping the lock (and the lock holding against the *correct*
      password), the lock being per-slug not per-file, eight misses against a token link
      changing nothing, secret swap in both directions, inheriting folder/file refusals, a
      per-file password, and a plaintext folder having nothing to lock. Phases 5 (43) and
      6 (48) still pass.

- [x] **Phase 8** — Seal & Forget (backend)
      New file `encryption_mode` value `sealed` and `POST /files/:id/seal`: reads the current
      plaintext through the phase 5 resolver, encrypts under a fresh key into a new blob,
      releases the old one, sets `encryption_mode = 'sealed'`, `encryption_overridden = 1`,
      `enc_key_blob = NULL`, `enc_access_blob = NULL`, and returns the key exactly once. The
      key is never logged. Every read path treats `sealed` like `client`: no `?ek=` check,
      raw serves ciphertext, preview/thumbnail refuse, media streaming refuses, batch-zip and
      folder-zip skip the member, the archive job and admin bulk-archive exclude it, and
      `PATCH /files/:id/encryption` 409s. Audit action `file.sealed`.
      **Deviations:** (1) Implemented the plan's phase-7 note that Seal & Forget is
      combinable with a password: `{password}` derives the key with PBKDF2-HMAC-SHA256
      (600k iterations, new `server/src/crypto/passwordKey.ts`) instead of using a random
      one. That needed one more additive column, `files.seal_salt` (schema, ensureColumn,
      rows, replication) — a salt is not a secret, and `/file/:slug/info` publishes it plus
      `seal_kdf` so the browser can rederive. PBKDF2 rather than scrypt/argon2 because
      WebCrypto implements it natively and a sealed file has to be decrypted client-side.
      (2) The folder zip now *skips* client/sealed members instead of bundling ciphertext
      under their filename — the old behavior only guarded the whole-folder case.
      (3) `rewriteFileEncryption` now encrypts whenever it is handed a key rather than
      branching on `mode === "server"`; sealing is byte-identical to server encryption
      except for what gets stored.
      35-check suite, decrypting the downloaded container with the returned key through the
      *same* FUPL primitives the browser worker uses: random seal, password seal (with a
      wrong password failing), sealing an already-server-encrypted file, double-seal and
      server-side-conversion refusals, sealed members dropping out of a folder zip, and a
      folder re-key stepping over a sealed file. Phases 5/6/7 still pass (43/48/30), and the
      column-drop/reopen upgrade test now covers `seal_salt` too.

- [x] **Phase 9** — E2E conversion audit glue (backend, small)
      New `POST /files/:id/e2e-conversion` (`:id` = the **new** file, body `{replaced_file_id}`):
      resolves both files' effective modes, refuses (400) if neither side is `client`/`sealed`,
      purges the old file, and records `file.e2e_sealed` or `file.e2e_decrypted` with a target
      naming both ids and the direction (`sealed->none`). Extracted `purgeFile()` from the
      `DELETE /files/:id` handler so the two share one teardown (links, `total_bytes`, blob ref,
      thumbnail, row).
      **Deviations:** (1) The plan left this as "confirm a delete path exists"; a bare
      `DELETE` would have logged `file.deleted`, which is exactly the entry that *doesn't*
      say plaintext transited the server. Folding the delete into the conversion commit makes
      the audit entry unavoidable and gives the client one call instead of two. (2) Deleting
      requires `can_delete` and owner/master on the *replaced* file (same rule as `DELETE`),
      while the replacement only needs edit rights — an editor may create, only an owner may
      destroy. (3) The both-files-briefly-exist window is kept deliberately (documented in the
      route comment): the old file dies only after the replacement is durable.
      28-check suite: sealed→plaintext and plaintext→client round trips, the old link 404ing,
      audit targets/directions, the hash chain still verifying, five refusal cases, and the
      plain delete path still working after the refactor. Phases 5/6/7/8 still pass
      (43/48/30/35).

- [x] **Phase 10** — Unified Drive explorer shell (frontend)
      New `client/src/features/drive/`: `DrivePage` (mounted at both `/files` and `/files/:dirId`,
      so the open folder is real routed state with working back/forward), `DriveBreadcrumbs`,
      `FolderTile`, `DriveUploadCard`, `DriveSidePanel`, `CurrentFolderBar`, `UnlockFolderDialog`,
      `useDriveChildren`/`useInvalidateDrive`/`useDriveTreeUpload`. Deleted `FilesPage`,
      `FilesList`, `FoldersList`, `FolderRow`, `UploadPanel`, `FilesMode`, `FolderMode`.
      `CreateFolderDialog` is now parent-aware. Client `EncryptionMode` gained `"sealed"`, and
      `Directory`/`FileObject` gained the tree + inheritance fields. Nav item is now "Drive".
      **Deviations:** (1) **The folder-tree upload recreates the directory structure** instead of
      flattening one bundle (`useDriveTreeUpload` walks `webkitRelativePath`, creating folders on
      demand). Flattening was only ever right when folders couldn't nest. (2) `FolderRow`'s
      per-folder actions moved into `CurrentFolderBar` — share, links, publish-to-library and
      delete now act on the folder you're *inside* rather than on a row. Per-item menus are
      phase 11, so nothing is unreachable in the meantime. (3) `useUpload.start` takes an optional
      `presetKey`, because uploading into an end-to-end folder needs that folder's key; the drive
      prompts for it (verified against `key_check_blob`) and reuses it for the whole batch and
      every subfolder underneath. (4) `UploadOptionsForm` gained `encryptionLockedTo` /
      `hideDirectoryPicker`: inside a folder the destination and the mode are both already decided,
      and the backend derives the mode anyway, so showing pickers there would be a lie.
      Verified: `bun run typecheck`, `bun run build`, `biome check` all clean, plus a 43-check API
      contract suite covering every request shape the new client issues and every field it reads
      (nested create with no `encryption_mode`, breadcrumb ordering, tile counts, inheritance
      through three levels, the client-mode unlock path, and the rename/move endpoints phase 11
      needs). Chrome wasn't reachable this session, so the UI itself is unverified in a browser.

- [x] **Phase 11** — Move / rename / right-click / multi-select (frontend)
      `DriveListing` now owns selection, drag-and-drop and menus: `useDriveSelection`
      (click / ctrl-cmd-click toggle / shift-click range, keyed `kind:id` so folders and files
      select together), `useDriveMutations`, `DriveItemMenu` (open, download, share, rename,
      move to…, delete), `MoveToDialog` + `FolderPicker` (lazy per-level tree), `RenameDialog`,
      `SelectionBar`. Dragging tiles/rows onto a folder tile moves them; dragging files in from
      the OS uploads into that folder. `FileRow`, `FolderTile` and `ListRow` gained optional
      selection/drag/menu props.
      **Deviations:** (1) **No new dependency for the context menu** — `components/ui/context-menu.tsx`
      anchors the existing Radix dropdown to a zero-size element at the cursor. A second Radix
      package would have meant a second set of popover styles to keep in step with
      `dropdown-menu.tsx`. (2) Batches run sequentially and **continue past a failure**, reporting
      which items didn't make it. Moving ten things into a folder that rejects one (cycle, depth
      cap, someone else's folder) should still move the other nine. (3) The move picker greys out
      the folders being moved and refuses to expand them, so the cycle case is unreachable from
      the UI rather than merely rejected by the server. (4) A single click on a folder *selects*;
      the icon or a double-click opens — otherwise a click while building a selection would
      navigate away from it. (5) Dropping OS files on an end-to-end folder is refused with an
      explanation instead of silently doing nothing: encrypting into it needs that folder's key,
      which only the unlock prompt inside the folder can supply.
      26-check endpoint suite alongside the UI: multi-item moves, both cycle rejections leaving
      the folder untouched, a deliberately partial batch, moves back out to the root promoting an
      inheriting folder to a break point, blank-title and path-traversal rename validation, and
      recursive delete taking the subtree and its files. Typecheck, build and `biome check` clean.

- [x] **Phase 12** — Encryption side panel: override, rekey, password lock, Seal & Forget, E2E convert (frontend)
      New `EncryptionPanel` (a Sheet, reachable from every item's menu and from `CurrentFolderBar`):
      shows whether the node holds its own key or inherits — with a link that jumps to the folder
      that does — then offers `none`/`server`/adopt-parent, the password-lock swap, Seal & Forget,
      and the end-to-end convert. Supporting pieces: `encryptionService`, `useEncryption`,
      `useE2EConversion`, `SealKeyDialog` (one-time reveal that refuses to close until the key is
      typed back), `E2EConvertDialog`, and `features/files/lib/sealKey.ts` (WebCrypto PBKDF2).
      **Deviations:** (1) **New backend endpoint `GET /files/:id/content`** — the owner's own read
      of their bytes. Phase 9 assumed the browser would fetch via `/file/:slug/raw`, which spends
      a use of the share link; re-encrypting your own file shouldn't cost share budget, and a file
      with no link would have been unreachable to its own owner entirely. Same read path, session
      auth, no use consumed. (2) **`serializeFiles` now carries `seal_salt`/`seal_kdf`** so the
      convert dialog can rebuild a password-sealed key; a salt is not a secret. (3) **The public
      download page learned `sealed`** — it previously fell through to "no encryption" and handed
      out ciphertext, which would have made the new Seal button a way to destroy a file. It now
      takes either a `#ek=` key or the seal password (derived client-side), and re-shows the
      prompt if the download fails, since deriving can't tell a wrong password from a right one.
      (4) **A folder cannot be converted to end-to-end**, because the backend refuses `client` on
      an existing folder — so the panel converts the files *directly inside* it instead, under one
      key revealed once, and says so rather than offering something that would 409. (5)
      `client/tsconfig.json` gained the `@/*` alias: the solution-style config is what non-tsc
      tools resolve against, and without it nothing outside `tsc -b` (including `bun test`) can
      import a client module.
      39-check suite: the server's node PBKDF2 and the browser's WebCrypto PBKDF2 deriving
      identical keys from the same password, the content endpoint returning plaintext for
      server-mode and the raw container for sealed while consuming no link use and refusing
      signed-out callers, a full seal → derive → decrypt → re-upload → commit round trip, and the
      panel's mode/password/adopt buttons including both refusals. All prior suites still pass
      (43/48/30/35/28/43/26).

- [x] **Phase 13** — Public folder viewer: nested browsing + lock prompts (frontend)
      `/d/:slug/info` and `/preview-manifest` take `?dir=<id>` and return `breadcrumbs`,
      `directories` and `entry_id`; `?dir=` is bounded by `isSelfOrDescendant`, so a link can
      never be walked outside its own subtree (404, not 403 — a link mustn't confirm what exists
      elsewhere). New `POST /d/:slug/unlock` proves one node's key without starting a download,
      on the same per-slug throttle as every other public check. `FolderPage` is now tree-aware:
      `FolderBreadcrumbs`, subfolder tiles (locked ones marked), and `FolderUnlockPrompt` in place
      of the contents when the visitor lacks that node's key, always with a Back.
      **Deviations:** (1) **Every node now publishes a `key_scope`** (`dir:12` / `file:34`)
      naming *which* secret opens it. With break points inside a shared subtree, "the folder's
      key" stopped being a single thing; `useFolderKeys` holds a map keyed by scope, so unlocking
      a break point once opens everything inheriting from it while a sibling that broke away
      still asks. (2) That needed a new resolver field, **`ownerDirectoryId`** —
      `sourceDirectoryId` is only set when the resolver *walked*, so a file inheriting straight
      from its own break-point folder reported null and looked like its own key holder. This was
      a live bug in the zip's entitlement check, not just cosmetics. (3) **The folder zip now
      recurses**, with paths preserved (new `safeArcsegment`), but only as far as the presented
      key reaches: plaintext descendants are included (they need no key from anyone), a
      descendant holding its own key is skipped — including it would hand away the entire point
      of a break point. `?dir=` lets such a subfolder be zipped on its own key. (4) Back is
      derived from the breadcrumb rather than a visit history, so it means "the containing
      folder" even when the visitor never unlocked where they are. (5) **Known gap left for
      phase 15:** `POST /d/:slug/save` still copies only the entry folder's direct files, so
      saving a nested shared folder gets an incomplete copy. Pre-existing code, newly reachable.
      39-check suite built on plan.md's own directory1/2/3 example: browsing three levels,
      breadcrumbs, per-node key scopes, the parent's key being refused on the folder that broke
      away and accepted on the one that inherits, both boundary escapes 404ing, and a zip that
      contains the entry's own file and the plaintext subtree but not the broken-away folder.
      Every earlier suite still passes (43/48/30/35/28/43/26/39).

- [x] **Phase 14** — Gallery/showcase mode for shared folders (frontend)
      New `directories.gallery_view` (schema, ensureColumn, rows, replication `TABLE_COLUMNS`),
      settable through `PATCH /directories/:id` (which now takes `title` and/or `gallery_view`) and
      reported on `/d/:slug/info`. `FolderGallery` renders one level as poster tiles — subfolder
      cards, video/audio played in place, photos in a lightbox, everything else a compact row —
      borrowing `MediaPosterCard`'s card language without touching the `is_library` /watch system.
      The old list moved into `FolderListing` so the two views are symmetric. Toggle lives on
      `CurrentFolderBar`.
      **Deviations:** (1) **`/file/:slug/preview` now serves server-encrypted bytes** given the
      same `?ek=` /raw wants (and the same per-slug throttle when it's a password). Without this a
      gallery in an encrypted folder could show nothing at all, since preview refused every
      encrypted file outright. `client`/`sealed` are still refused — the server holds no key —
      archived is still refused, and a limited-use link still exposes no preview at all, so no link
      budget becomes spendable. Encrypted/compressed bytes go out 200-only with no `Accept-Ranges`,
      the same "reproduced from byte zero" rule `storage/streaming.ts` reports as `seekable`.
      (2) **Public members carry `previewable`**, the server's own answer to "would /preview serve
      this?" — the gallery has to know *before* it renders a `<video>`, and only the server knows
      which transforms the blob is under. The plain list now gates its Eye button on it too, so a
      server-encrypted member gained an inline preview there as well.
      (3) **`gallery_view` is read off the link's *entry* folder**, not the folder being viewed, so
      the layout doesn't change under the visitor as they walk deeper.
      (4) `PublicShell` grew a context-driven width (`usePublicShellWidth`) — a poster grid doesn't
      fit `max-w-3xl`, and the router can't know a folder is a gallery until its info arrives.
      42-check suite: the flag's round trip and both validation refusals, the entry-folder rule at
      depth, `previewable` for plaintext/encrypted/limited-use/client/sealed members, a
      server-encrypted preview returning byte-identical plaintext (and a root-level
      compressed+encrypted one decompressing too), preview spending no link use, and five wrong
      passwords locking the slug out against the right one. Plus a column-drop/reopen upgrade test.
      Every earlier suite still passes (43/48/30/35/28/43/26/39/39).

- [x] **Phase 15** — Cleanup pass: admin panel, remaining pickers, docs (backend + frontend, small)
      `FolderPicker` (phase 11's move dialog) is now the one folder-destination control everywhere:
      the upload form's flat `<select>`, remote upload, receive links and torrents. Admin: the files
      tab lists **every** file, each with its folder path; folders report theirs too. `docs/api.md`
      gained every endpoint phases 1–14 added, plus `sealed`, inheritance, password locks and the
      end-to-end conversion sequence. `CLAUDE.md` gained the tree, the resolver, password locks, the
      two new permission flags and eight new gotchas.
      **Deviations / things found:** (1) **`POST /d/:slug/save` now recurses** — phase 13's known
      gap. It follows the zip's rule exactly (as far as the presented key reaches, stopping at a
      descendant that broke away), and a copied subfolder inherits from its new parent only when
      its resolved key material is byte-identical; otherwise it becomes its own break point, since
      inheriting would relabel bytes it doesn't describe. (2) **Two of the three pickers had no
      backend to point at.** Remote upload hardcoded `directory: null`; torrents had no destination
      at all. Both now take one (`torrent_jobs.target_directory_id`, additive), and a multi-file
      torrent creates its folder *underneath* it, inheriting the parent's encryption. (3) **Found a
      real bug doing it:** a server-side upload into an end-to-end folder stored plaintext labelled
      `client` — the dropbox receive link made that reachable by an anonymous uploader. Uploads into
      such a folder are now refused (409) unless the caller passes `clientCiphertext: true`, which
      only the two browser/API upload routes do; the mode field alone is not that claim, because
      every server-side path copies its directory's mode into it. (4) The admin files list filtered
      on `directory_id IS NULL`, so it hid most of the system once folders became the norm.
      (5) `torrent_jobs.target_directory_id` needed `ON DELETE SET NULL` spelled out in the
      `ensureColumn` definition as well as `schema.sql` — an ALTER TABLE column carries only its own
      declared constraints, so an upgraded database would have thrown on deleting a targeted folder.
      (6) The stale `uiDesignContract` test still read `UploadPanel.tsx`/`FilesPage.tsx`, deleted in
      phase 10; it now asserts the same intent against `DriveSidePanel`/`DrivePage`.
      (7) **`bunx biome` resolves to an unrelated package**, so earlier phases' "biome check clean"
      was checking nothing. Under the real `bunx --bun @biomejs/biome` the tree is format-clean and
      error-free, with 245 pre-existing warnings (220 of them `noNonNullAssertion`, a deliberate
      house style).
      26-check suite: a three-level save carrying the whole subtree but not the folder that broke
      away, the copied bytes still decrypting, a plaintext subfolder staying plaintext, the
      double-save refusal, destination validation on remote upload and torrents (404/403), the
      anonymous dropbox upload into an end-to-end folder being refused, and the admin listing
      showing nested files with their paths. Every earlier suite still passes
      (43/48/30/35/28/43/26/39/39/42), plus both column-drop upgrade tests.

- [x] **Review pass** — bug + security review of the whole rework (three Opus subagents: security,
      backend correctness, frontend correctness), findings triaged, verified and fixed.
      **Security:** (1) moving an inheriting folder materialized its key but dropped
      `access_is_password`, turning a human password into an *unthrottled* oracle on the moved
      folder's link. (2) `POST /files/:id/seal` was gated on folder-editorship, so a collaborator
      could irreversibly seal files they did not own — it now takes the delete gate (`can_delete` +
      ownership), since sealing is strictly more destructive than deleting. (3) The guess counter
      was keyed on the presenting **link slug**, and `/d/:slug/info` publishes every member's slug —
      so a folder password got 5 guesses *per member file*. It is now keyed on the key scope (the
      node that actually owns the secret), which is also one clean reset instead of a loop over
      links. (4) A collaborator could move an owner's **root** folder into their own tree, and the
      existing source-parent guard then stopped the owner moving it back; relocating a root folder
      is now the owner's call. (5) A subfolder created inside someone else's tree was owned by its
      *creator*, letting an editor invite third parties through it and route around the owner-only
      collaborator gate — it now belongs to the tree's owner, mirroring `routes/dropbox.ts`.
      **Backend:** (6) `collectFileRows` shipped only a file's own directory row, so replicating a
      file in a nested folder hit a `parent_directory_id` FK violation on any peer that had never
      seen the parent — the whole peer transaction rolled back and the failure was logged at debug
      as "unreachable". It now ships the ancestor chain root-first. (7) `POST /files/:slug/save`
      dropped `seal_salt`, making a saved password-sealed file permanently unopenable. (8)
      `PUT /directories/:id/access` missed descendant files that pin their own copy of the secret
      (every file predating the inheritance model), leaving the old token live on their links.
      (9) A torrent aimed at an end-to-end folder was accepted, downloaded in full, then failed at
      import — orphaning an empty folder per retry; it is refused at queue time, and the import
      re-validates the destination (encryption, rights, depth) and falls back to the root rather
      than losing already-downloaded bytes. (10) `PATCH /directories/:id` committed the rename
      before rejecting a malformed `gallery_view`. (11) A nested folder silently ignored `password`.
      (12) The save/zip walks were the only tree walkers without a cycle guard.
      **Frontend:** (13) `DriveUploadCard` never reset its unlocked folder key on navigation — and
      `/files` and `/files/:dirId` render the same component, so moving between two end-to-end
      folders suppressed the unlock prompt and encrypted uploads under the *previous* folder's key.
      (14) Clicking a locked gallery tile navigated the tab to a 401 and spent a password guess.
      (15) The encryption panel acted on a snapshot, so it kept offering Seal after sealing.
      (16) The gallery player survived navigating into a subfolder. (17) A failed conversion commit
      discarded the new file's only key. (18) The folder batch revealed a key even when every
      conversion failed. (19) The picker fetched every collapsed node's children. (20) The
      destination pickers offered end-to-end folders the server will always refuse. (21) "Save
      folder to my files" never sent `?ek=`, so it always 401'd on an encrypted folder. Plus
      `sealed` handling in the share modal, a dead Share menu item, and admin cache invalidation.
      **Judged not-a-bug:** the reviewers also flagged that `/d/:slug/info?dir=` exposes a
      descendant break point's *metadata* without its key. That is phase 13's documented decision
      (metadata is readable, `?ek=` gates bytes) and the UI depends on it to render a locked
      subfolder tile at all; the guess-amplification it fed is closed by fix (3) instead.
      New 28-check `review-fixes` suite, one check per fix, named after the failure it prevents.
      All eleven phase suites still pass (43/48/32/35/28/43/26/39/39/42/26 — phase 7 gained two
      checks and had its "the lock is per slug" assertion inverted, since that behavior *was*
      finding 3).
