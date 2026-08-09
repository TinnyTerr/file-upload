# CLAUDE.md — fileupload project guide

## Overview

A self-hosted file sharing platform with end-to-end encryption, folder management, share links, API keys, dropboxes, torrenting, multi-node clustering, and an admin panel. Bun + Express on the backend, React + TypeScript on the frontend.

This project began as a Python/FastAPI app (`app/`). That backend is **retired and has been deleted from the repo** — `server/` (Bun + Express) is the only backend. Every route was ported and every flag in `client/src/config/featureFlags.ts` is `true`.

Many source comments still say "Mirrors `app/routes/x.py`" or similar. Those refer to the deleted Python original and are historical lineage notes only — **do not go looking for `app/`, it isn't there.** Treat such a comment as describing intent, not as a pointer to readable code.

### Cluster subsystem

Multi-node replication lives in `server/src/cluster/*.ts`:
- `membership.ts` — join/heartbeat/enroll handshake, full-mesh peer topology
- `tiering.ts` — leadership as a **pure function** of a master-minted membership snapshot: `cluster_tiering` generations, region inference, the deterministic leader/master computation, `upstreamOf` (the whole topology rule) and the `cluster_drift` hold-down counter. `initTiering` runs from `index.ts` **before** `createAppState`, because the change-log seed reads `replication_control.is_master`. It replaced `election.ts`, which is **deleted** — there are no votes, no epochs and no `cluster_self_state` any more
- `identity.ts` — ULID row identity (`uid`) for replicated tables + the live-safe boot backfill. `UID_TABLES` is the canonical list of replicated tables: `users`, `permissions`, `content_blobs`, `blob_chunks`, `chunk_locations`, `directories`, `directory_links`, `files`, `links` — nothing else replicates
- `changelog.ts` — the `replication_log`: trigger-generated, appended **inside the writing transaction**, and the only mechanism by which metadata leaves a node. Owns `CHANGELOG_TABLES` (= `UID_TABLES`), `TABLE_COLUMNS`, `BLOB_COLUMNS`, `FOREIGN_KEYS`, `installChangeLog`, `setNodeIdentity`, `seedChangeLog`, `readChanges`, `applyChanges`, and the cursor accessors
- `replication.ts` — hierarchical pull of that log (`GET /api/cluster/changes`) + per-peer, per-direction cursors
- `topology.ts` — the replication graph the cluster dashboard draws: every node this one knows of, its derived role, and its upstream. Built from the same `upstreamOf()` over the same generation that `pullTargets` uses, with the same liveness observation, so the picture cannot disagree with the pulls. `GET /api/cluster/topology`
- `placement.ts` — chunking (Phase 8, §5.11): the `blob_chunks` manifest, the `chunk_locations` registry, the local physical layer (`localChunk`, `writeChunkAt`, `reclaimChunk`), the LRU clock in node-local `local_chunk_cache`, `chunkReplicationJob` + `choosePlacementTarget`, `reconcileLocalChunks`/`gcOrphanChunks`, and `chunkSize()` — the one definition of 16 MiB, which `routes/files.ts::chunkUploadSize` now delegates to
- `blobs.ts` — fetch-on-miss, per chunk and registry-driven: `ensureBlobLocal` pulls exactly the chunks this node lacks from whoever `chunk_locations` names, nearest-first by RTT, four at a time, verifying each against its own hash. `fetchBlobFromPeers` (the old whole-blob peer walk) survives for the two cases with no manifest to work from
- `cacheEviction.ts` — LRU eviction over **unpinned** chunks for `REPLICATION_MODE=cache` nodes; durability is read off `chunk_locations` and confirmed with one HEAD against a node it names. Also runs the registry housekeeping (`gcOrphanChunks`, `reconcileLocalChunks`) on every node, cache or not
- `halt.ts` — in-memory TTL'd upload halt registry (user-scope + global), gossiped over the event firehose
- `quota.ts` — the master-side `quota_reservations` ledger and its client. **The only synchronous cross-node call on the write path.** Reserve → commit/release, sliding TTL, sweep. On the master (and on any single-node deployment) every call resolves in-process, so an unclustered server pays nothing
- `degraded.ts` — master-reachability state machine: 5-minute restart grace during which writes are **held**, then degraded (reads only). `middleware/degradedMode.ts` is the write gate that enforces it
- `conflicts.ts` — `replication_conflicts` and §5.8's arbitration: optimistic concurrency keyed on `master_seq`, **later timestamp wins, node id breaks the tie**, evaluated on the master alone. `winnerOf` is total and `comparableTs` clamps a clock running more than `CLOCK_SKEW_MS` fast. The rule runs inside `applyChanges`; this file owns the record, the list, dismiss and the open count
- `revocation.ts` — §5.9's asymmetry: grants are lazy, revocations are pushed. `revocationMark` before the write, `pushRevocation` after, `POST /api/cluster/revocations` on the receiving side. It carries the *same* log entries the pull would, so a failed push costs latency and not correctness
- `identityFetch.ts` — §5.10's identity split: `password_hash` and TOTP seeds are fetched from a peer at first login rather than replicated. `materialState` (held/stale/absent), `ensureCredentialMaterial` (the login path's one entry point), `bumpCredentialVersion` + `publishCredentialChange` (the write path's), `POST /api/cluster/identity/{fetch,publish}`. Not to be confused with `identity.ts`, which is about *row* identity
- `digest.ts` — cluster state digest + divergence alerting (`syncCheckJob`). No split-brain cross-check: role is derived from a generation only the master mints, so "two nodes both believe they are master" is not a state the data model can express
- `eventBus.ts` / `eventStore.ts` / `firehoseClient.ts` — in-memory live event bus, durable `cluster_events` mirror, peer-polling consumer
- `http.ts` — node-to-node fetch helpers (cluster-token auth, timeouts)

**Leadership (Phase 4).** Three tiers — `master` (tier 0: quota + write ordering), `leader` (tier 1: one per region, a relay and cache), `follower`. Nothing is elected. The master computes a snapshot of the cluster, runs `computePlan` over it (`master = argmax(disk_total_bytes, then node_id ASC)` over eligible nodes; each region's leader is the same argmax *minus the master*, so tier 0 and tier 1 are never the same box) and mints a numbered **generation** into `cluster_tiering`. Every other node adopts the highest generation it has seen and derives its role from it, so agreement on *who leads* reduces to agreement on *what the snapshot is* — which is one writer's output, not a quorum's.

- **Only the master mints.** During a master outage no generation can be minted, so leadership does not move. That *is* D-2's "no automatic failover"; it falls out of the design rather than being enforced on top of it. `retier()` returns `null` on a non-master.
- **A role is never asserted over the wire.** `/join` and `/heartbeat` carry a `role` field for logs and the UI, and nothing reads it — `cluster_nodes.role`/`.is_master`/`.region` are written from the local generation (`membership.ts::derivedRole`). An unauthenticated self-asserted role field was defect S4.
- **The generation rides on the handshakes that already exist**, whole, in both directions, adopted on **strictly higher** generation. `enrollWithMaster` is the one exception: it adopts by `force`, because joining a cluster means taking its answer, and both sides start at generation 1 so highest-wins would never fire.
- **Re-tiering has three triggers** (`docs/cluster-redesign.md` §5.4): manual (`POST /api/cluster/retier`), a new node joining (immediate — see below), and structural drift. Drift counts nodes whose status differs from what the current generation was computed against, threshold `max(2, trunc(n/3))`, and a change only counts once **held for 5 minutes** (`HOLD_DOWN_MS`) — a restart is not drift. A node the generation has never seen counts *immediately*: until it is in a snapshot it has no upstream and replicates with nobody.
- **The drift status is a composite, `<up|down|absent>:<role-it-would-get>`.** That is what makes "a capacity change that would alter the computed leader" the only capacity change that counts — comparing raw `disk_total_bytes` would make routine disk growth look like churn.
- `region` comes from `NODE_REGION` (`region_source = 'configured'`, always wins) or from clustering the heartbeat RTTs into `r1`, `r2`, … Inference runs **only at a re-tiering event**, never continuously, or region membership flaps with network weather. With nothing measured everything lands in `r1`, which is the single-region deployment the design assumes today.

**Replication topology:** strictly hierarchical and derived entirely from the generation. Every node pulls **down** from its upstream and **up** from everyone whose upstream is itself — `upstreamOf()` is the whole rule, and `pullTargets()` in `replication.ts` applies it to both halves of every edge, once a second (`cluster_replication_pull`). A follower never pulls from a sibling: its writes reach that peer by going up to the leader, up to the master and back down, which is what keeps the master's log the canonical order. A follower whose leader is unreachable falls back to **the master** — the leader is a relay, not an authority. A node with **no generation at all** pulls from nobody, deliberately: guessing at a peer to sync from is how two halves of a partition converge on different answers.

**Liveness is read from two places, on purpose.** The snapshot's `active` flag is the master's view at mint time, and it is the right input to the *leader computation*. Whether a node can reach its leader *right now* is that node's own observation, and it is what `pullTargets` passes into `upstreamOf` — a follower cut off from its relay must notice that itself, because no new generation is coming to tell it.

**Quota is master-authoritative and synchronous (Phase 5).** Two nodes each reading `SUM(files.size_bytes) = 0` would each admit a 10 GB upload against a 15 GB quota, and the change log would honestly converge on 20 GB — a file that exists cannot be un-accepted, so quota is the one number that cannot be reconciled after the fact. `cluster/quota.ts` holds the master-side `quota_reservations` ledger; a node reserves before accepting bytes and commits after the row exists.

- **The unit is logical quota bytes, everywhere.** `SUM(files.size_bytes)` against `quota_bytes`, so **every path that creates a `files` row reserves** — including save and copy, which write no new bytes at all. Dedup savings are the system's, not the user's; skipping the reservation there would let a user clone past their quota for free.
- **`finalizeStoredFile` is the funnel and takes a reservation if the caller didn't**, so the rule holds by construction rather than by every future upload path remembering. Callers that can reserve earlier (chunked-upload init) pass the uid down via `reservationUid`; `finalizeStoredFile` releases only a reservation it took *itself* on failure, because one handed down belongs to the caller's lifecycle.
- **You cannot reserve against a size you do not know.** A magnet is a promise and a remote URL may not send a `Content-Length`, so torrents reserve at *import* and remote uploads at *finalize* — the moment their true size first exists. `debrid.ts` keeps a local, explicitly **advisory** pre-check so an obviously-too-big torrent is refused in seconds rather than after a 40 GB download.
- **The TTL slides; it is not a ceiling.** `expires_at` is an *inactivity* window (12 h, matching `CHUNK_SESSION_TTL`) pushed forward by chunk commits (strided, one in `RENEW_EVERY_CHUNKS`) and by each file of a long torrent import. Expiry means "nobody has touched this for a full window", which is the only condition under which `cluster_quota_sweep` may release the bytes.
- **Free disk stayed local; the global cap moved to the master.** They look alike and are not: the cap is a cluster-wide budget, but free space is a fact about the node that will hold the bytes. `enforceGlobalUploadCapacity` keeps the disk check where the disk is.

**Conflicts are arbitrated by the master, and the loser is kept (Phase 6, §5.8).**
Only quota is gated on the write path, so two nodes can both accept a rename, a
move, a permission edit or a link revocation on the same row. Detection is
optimistic concurrency keyed on `master_seq`: every entry carries the
`base_master_seq` the row stood at when its writer changed it, and if the row has
moved on, the two edits are concurrent.

- **Later `ts` wins; a tie goes to the higher `origin_node`.** The rule is total
  on purpose — second-resolution timestamps collide constantly under bulk edits,
  and a rule undefined on a tie is a rule that diverges on a tie.
- **Only the master runs it**, once, against one clock's view of arrival. Two
  nodes cannot reach opposite verdicts, which is the failure
  last-write-wins-at-every-node has and this does not.
- **Clock skew is bounded, not trusted.** An entry whose `ts` is more than
  `CLOCK_SKEW_MS` ahead of the master's clock is compared at receipt time, or one
  fast box would win every conflict it ever entered.
- **A losing entry never enters the master's log** — the log is what ships down,
  and a loser with a `master_seq` would be applied by every follower *after* the
  winner. It goes to `replication_conflicts` alone, and the master appends a
  **restatement** of the winning row, which is how the node that lost finds out.
- **Redelivery is a no-op.** An entry already ordered in the log, or already
  recorded as a loser, is skipped rather than re-applied: re-applying an accepted
  entry would clobber whatever later edit has since won the row.
- **Conflicts are read through to the master, not replicated.** They are rows only
  the master writes, so the panel on any other node proxies `/cluster/conflicts`
  to it rather than adding another table to `UID_TABLES`.
- **Re-apply is a fresh edit on top of the winner, never a replay.** Replaying the
  original entry would re-enter the arbitration it already lost.

**Revocations are pushed; grants are lazy (Phase 6, §5.9, D-13).** Permissions are
read from the local row on every request, which is what keeps `requirePermission`
free — and it means a change takes effect on a peer only when the log gets there.
For a grant that is a wait; for a revocation it is a window in which a peer still
honours something an admin took away. So `cluster/revocation.ts` pushes: the admin
call does not return until every *reachable* node has applied the change, and the
response carries `revocation: {acknowledged, lagging}` naming any node that
didn't. Wired into permission edits, user updates and deletion, share- and
folder-link edits and deletes, and `POST /files/:id/seal`.

- **It is not a second replication mechanism.** What travels is exactly the
  `replication_log` entries the write already produced, applied through exactly
  `applyChanges`; the ordinary pull re-delivers them and dedups to nothing. A
  failed push costs latency, not correctness.
- **API keys are absent from that list because they are node-local** — `api_keys`
  is not a replicated table, so there is no peer copy to revoke.
- **The receiver does not move a cursor.** These entries did not come from the
  peer's ordinary stream, and advancing a cursor for them would claim this node
  had read past things it has not seen.

**Identity: authorization replicates, authentication is fetched (Phase 7, §5.10,
D-12/D-18).** Every node holds every `users` row, so `requirePermission` stays a
local read. What no node holds until it needs it is the material that lets it
*authenticate* somebody: `users.password_hash` is absent from `TABLE_COLUMNS`
and `credentials` is not a replicated table at all. A node pulls both up the
tier the first time someone attempts a login there, stores them, and verifies
with local Argon2id from then on — so the candidate password never leaves the
node it was typed into, and one round-trip is paid per user per node rather
than per login.

- **Invalidation is a replicated counter, not a message.** `users.credential_version`
  replicates; `credential_version_local` (which version *this* node's copy
  matches) does not. A bump anywhere makes every other node's copy read as
  stale via a row it was receiving anyway — monotonic, so out-of-order
  delivery, an offline node and a node that cached nothing all behave the same.
  Nothing has to arrive for this to be correct.
- **Credential writes still ride the revocation push**, because a stale password
  hash is a stale *grant*. `publishCredentialChange` does both halves: push the
  log entries (carrying the bump), then hand the master the material.
- **The master is the holder of record**, which is what makes a fetch terminate.
  Writes publish up; fetches walk up; nothing walks down or sideways.
- **A relay forwards without keeping a copy.** The hash is supposed to end up on
  nodes the user has *used*, and a caching leader would widen that to every node
  on every path.
- **Storing fetched material is suppressed**, exactly as `applyChanges` is. It is
  a peer's write, and logging it would append a `users` upsert carrying no new
  replicated state — one that could win an arbitration against a real concurrent
  edit and discard it.
- **WebAuthn never travels (D-18)**, and needed no work: `credentials` was
  already node-local. A passkey is registered against one node's rpID and is
  unusable elsewhere, so `require_passkey` means enrolling per node.
  `webauthn_user_handle` *does* replicate — an identifier, not a credential.
- **Logins work while degraded; credential *writes* do not.** `/api/auth` is on
  the degraded-mode allowlist and `/api/account`, `/api/users` are not, so a
  cut-off node keeps signing in everyone it already holds material for and
  refuses the writes whose publish-to-master could not succeed anyway. That is
  what lets `publishCredentialMaterial` log a failure rather than throw.
- **TOTP seeds travel sealed under `MASTER_KEY_B64`**, which cluster nodes must
  therefore share. They already must: `files.enc_key_blob` replicates and is
  sealed the same way.

**Chunking: a blob is a manifest, and where its chunks live is a table (Phase
8, §5.11, B10/D6/D-10/D-11).** Every blob is split into content-addressed
chunks of its *stored* bytes — `chunkSize()`, 16 MiB, a whole multiple of the
AEAD container's 2 MiB frame, so a boundary never bisects a GCM frame. The
manifest (`blob_chunks`) and the registry of who holds what
(`chunk_locations`) both replicate, so every node can pick a source, a push
target or an eviction candidate from a table read instead of asking every peer
in turn.

- **The bytes are not a separate object store.** A chunk is a byte *range* of
  the blob's file at `content_blobs.storage_path` — a replicated column, so
  every node agrees on the path — and a node holding a subset holds a sparse
  file. A node holding all of them holds exactly the file every existing read
  path already opens, which is why chunking added to the read path rather than
  rewriting it.
- **Presence is a database fact for partial holdings and a file fact for whole
  ones.** A sparse file's length reaches the end of the highest chunk written,
  so size alone cannot spot a hole. `holdsChunkLocally`: believe a location row
  whenever one exists; with none at all, believe a file of exactly
  `stored_size_bytes`. `blobCompleteLocally` is the read path's fast case — one
  stat and one indexed lookup, not a walk over a 2,560-entry manifest.
- **The manifest has exactly one writer.** It is minted by the node that
  created the blob, inside the hash pass `finalizeStoredFile` was already
  making (`hashFile` returns chunk digests, so there is no second read of the
  file), and every other node receives it. A dedup hit records *presence*, never
  a manifest. Legacy blobs are seeded as one whole-file chunk — free, since a
  legacy blob's chunk hash is its `stored_sha256` — and **only on the master**,
  after `seedChangeLog`, or two nodes would ship two manifests for one blob.
- **The archive job is the one thing that rewrites stored bytes in place**, so
  it is the one thing that must call `rechunkBlob`; every hash in the old
  manifest describes bytes that no longer exist.
- **`pinned` separates durability from cache.** A copy placed by
  `REPLICATION_FACTOR` (default 2) is pinned and never evicted, even on a cache
  node; a read-time fetch on a cache node is not. `CACHE_MAX_BYTES` caps the
  *unpinned* bytes only, and the dashboard shows the two apart because
  conflating them is why cache mode has been hard to reason about.
- **Eviction checks the registry, then confirms once.** `copyCount` must exceed
  the factor and one HEAD against a node the registry names must succeed before
  anything is deleted. If the reclaim frees nothing — a hole in a file that has
  to stay, on a filesystem that won't punch one — the chunk stays `present`,
  because a cache that thinks it is under its cap while the disk disagrees
  evicts its way to nothing.
- **Neither natural key is UNIQUE**, deliberately: a UNIQUE violation raised
  while applying a peer's entry halts the whole replication batch. Uniqueness is
  held by one-writer-per-row, and copies are counted with
  `COUNT(DISTINCT node_id)`.
- **`last_read_at` is node-local** (`local_chunk_cache`). In the replicated
  table it would append a change-log entry, cluster-wide, every time somebody
  watched a video. `touchBlobRead` throttles to once a minute per blob for the
  same reason `sessions.last_seen_at` does.

**Degraded mode (§5.5).** A node that cannot reach the master **holds** write-path requests for a 5-minute restart grace, then goes read-only. There is no automatic failover, by design: a node cannot tell "the master died" from "I got cut off", and promoting on the second reading is the split brain the deleted `election.ts` failed to prevent. Recovery is the master returning, or `POST /api/cluster/promote` — refused unless the node is genuinely degraded, and requiring the node's own name typed back as confirmation.

- `middleware/degradedMode.ts` gates **by method with a short allowlist**, mounted once in `app.ts`, rather than enumerating write routes — so it fails closed and a route added later is refused unless deliberately allowlisted. `/api/cluster` is on that list because promotion is the only way out and gating it would make degraded mode unrecoverable.
- Reads never gate. Every read here is local by construction, which is what makes a degraded node useful rather than merely up.

`routes/cluster.ts` exports `clusterRouter` (mounted at `/api/cluster`: session-authenticated management endpoints — `/token`, `/token/rotate`, `/self`, `/topology`, `/conflicts` (+ `/:id/dismiss`, `/:id/reapply`), `/nodes` (GET/POST/PATCH/DELETE), `/retier`, `/cache-cap`, enroll/unlink — **plus** cluster-token-authenticated node-to-node endpoints — `/join`, `/heartbeat`, `/ping`, `/blobs/:storedSha256`, `/chunks/:storedSha256` (GET/HEAD to serve, POST to accept a pushed durability copy), `/digest`, `/changes`, `/tiering`, `/revocations`, `/identity/fetch`, `/identity/publish`) and `adminClusterRouter` (mounted at `/api/admin/cluster`: `/node-logs` + `/events`, the HTTP long-poll fallback for the websocket firehose). `server/src/ws.ts` attaches the websocket firehose directly to the `http.Server` returned by `app.listen()` in `index.ts`, since Express has no native websocket support.

**Invariant:** the in-memory event sequence counter in `eventBus.ts` assumes **one process per node** (this server makes a single `app.listen()` call and never forks workers). Colliding `origin_seq` values across workers is the exact bug class that broke logins under `uvicorn --workers=4` in the old deployment — see `cluster_events`' `UNIQUE(origin_node_id, origin_seq)`. Don't introduce multi-process scaling without redesigning event sequencing.

#### Where the cluster rework stands

`docs/cluster-redesign.md` is the design document and the authority on intent —
Parts 1–3 are the defect inventory, Part 5 the target architecture, Part 7 the
phasing. Work happens on the `cluster-rework` branch.

**Phases 0–7 are built and green** (`clusterEvents`, `clusterIdentity`,
`clusterChangelog`, `clusterReplication`, `clusterTiering`, `clusterQuota`,
`clusterConflicts`, `clusterRevocation`, `clusterTopology`,
`clusterIdentityFetch` tests): the
multi-node test harness, the event-pipeline fixes, ULID `uid` identity, the
trigger-driven change log with hierarchical pull, tiering, master-gated quota +
degraded mode, conflict arbitration + the synchronous revocation path, and the
identity split. Phase 3 deleted
`replicateFile`, `/cluster/reserve`, `/cluster/replicate`, `/cluster/export` and
`rebaseFromMaster` outright — `seedChangeLog` writes an `upsert` entry per
existing row the first time a populated database meets an empty log, so a
joining node gets the whole corpus from cursor 0 through the ordinary pull.
**One mechanism for state transfer, not two that can disagree.** There is no
pending-parent buffer: entries apply in `seq` order and a forwarding hop
re-appends in the order it applied, so seq order *is* dependency order; apply
halts at the first entry it cannot write and leaves the cursor before it, which
retries rather than drops. Phase 4 deleted `election.ts` in full, along with
epochs, vote grants, `cluster_self_state`, `/vote-request`, `/master-assumed`,
the `cluster_election_liveness` job and `digest.ts`'s split-brain check — see
"Leadership (Phase 4)" above for what stands in their place. Phase 5 added
`cluster/quota.ts`, `cluster/degraded.ts` and operator promotion — see "Quota is
master-authoritative" and "Degraded mode" above.

Phase 6 added `cluster/conflicts.ts` and `cluster/revocation.ts` — see
"Conflicts" and "Revocations" below. Phase 7 added `cluster/identityFetch.ts` —
see "Identity" below.

Phase 8 added `cluster/placement.ts` and rewrote `cluster/blobs.ts` and
`cluster/cacheEviction.ts` around chunks — see "Chunking" below.
`cluster_nodes.epoch` is a dead column (vestigial; SQLite cannot drop one in
place). `throughput_bps` is now live: `placement.ts` samples it from real chunk
pushes and feeds it into target selection.

**Phase 9 is next**: per-node credentials — a short-lived one-use enrolment
token minting a per-node-pair credential, rotation with an overlap window, and
the node-to-node router split (S2, S3).

---

## Tech stack

| Layer | Technology |
|---|---|
| Backend | Bun + **Express 4**, `bun:sqlite` (SQLite, no migrations) |
| Frontend | React 19, TypeScript, TanStack Query, Tailwind CSS v4, Radix UI primitives |
| Auth | Cookie sessions (`fu_session`) + CSRF (`fu_csrf_token` in localStorage); optional TOTP / WebAuthn second factor |
| Crypto | AES-256-GCM server-side (`crypto/aead.ts`), browser WebCrypto for client-side E2E (`client/src/workers/`) |
| Compression | zstd via **`node:zlib`** (`zlib.createZstdCompress`) — not the Python `zstandard` package |
| Scheduling | `jobs/scheduler.ts` — plain `setInterval` jobs; no `node-cron`/`croner` dependency |
| Torrenting | Real-Debrid REST 1.0 (preferred), qBittorrent WebUI API v2 on the host (fallback) — `server/src/torrents/*` |
| Images | `sharp` for thumbnails, `ffmpeg` (external binary, optional) for video frame extraction |

---

## Running the project

**One command (build client + run server):**
```bash
bun install             # installs both workspaces (client/, server/)
bun run start           # builds client → public/, then runs server on :8000
```

**Dev (hot reload, both processes in parallel):**
```bash
bun run dev             # Vite on :5173 (proxies API calls) + Express on :8000
```

**Typecheck both workspaces:**
```bash
bun run typecheck
```

**Test both workspaces:**
```bash
bun run test
```

`client/tests/` are pure unit tests plus a few source-text design contracts;
`server/tests/` drive the **real** Express app over an in-memory SQLite database
via `server/tests/harness.ts` (`makeHarness` / `makeUser` / `makeDirectory` /
`makeFile`), so a failure means the route is wrong rather than a stub being
wrong. Both scripts pass `./tests` explicitly — a bare `bun test` from either
workspace globs the whole monorepo and runs the *other* workspace's tests with
the wrong cwd.

Cluster tests go one level further: `server/tests/clusterHarness.ts`
(`makeCluster({size})`) stands up **N real nodes on real ports** talking over
real HTTP, which is why the Phase 0–4 work could ship green at all. A cluster
behaviour that isn't exercised through `makeCluster` isn't tested.
`linkAll()` also **tiers** — it mints a generation on `nodes[0]` and hands it to
everyone — because a linked but untiered node has no upstream and replicates
with nobody. Call `tier()` again after changing what the leader computation
reads (capacity, eligibility, liveness) to see the new plan take effect.

Config lives in `./data/app.env`, auto-generated on first run (mode `0600`).

**`app.env` and the process environment are one namespace** (`config.ts`).
Every key below can be given either way, and a variable set on the command
line, in a unit file or via a container's `-e` **wins** over the file — which
is what lets a value only known at launch be supplied at launch. `configValue()`
is the single resolver: environment → file → default. Two rules keep it safe:

- **The environment is never written back.** `generateFile` records an
  environment-supplied key as a `# KEY is set in this node's environment`
  comment rather than a value, and no backfill mints one. A persisted copy of
  an overlay is a second answer that silently takes over the day the variable
  is dropped — for `SECRET_KEY` that is every session invalidated, where the
  *absent* key is a loud startup error instead.
- **`setEnvValue` refuses an environment-supplied key** (`ConfigLockedError`, a
  409), so the admin panel can't persist a value the running process is
  ignoring. Every caller therefore persists *before* mutating `settings` in
  place, or a refusal would leave memory ahead of the file.

Keys outside `CONFIG_KEYS` are read from the environment only when `app.env`
already carries them — anything you can put in the file you can also set in the
environment, but a stray variable can't invent a value the app never had.
`FILEUPLOAD_CONFIG` is the one environment-only key: it names the file.
`index.ts` logs the overridden key *names* at startup (never values — several
are secrets).

Environment variables:

| Variable | Purpose |
|---|---|
| `APP_ENV` | `dev` (plain cookies, no HTTPS redirect) or `prod` (Secure cookies + HTTPS redirect). **Defaults to `prod`.** |
| `SECRET_KEY` | Session cookie signing key |
| `MASTER_KEY_B64` | base64 AES-256 key for server-side encryption and sealed tokens |
| `DATABASE_URL` | Default `sqlite:///./data/app.db` |
| `ALLOWED_HOSTS` | Comma-separated hostnames. Gates the WebAuthn relying-party ID and the HTTPS-redirect proxy-header trust. **Empty = unconfigured**, which logs a startup warning — set it in production. |
| `TRUST_PROXY` | `true` (generic reverse proxy) or `cloudflare` (prefer `CF-Connecting-IP`, and derive each session's region from `CF-IPCountry`). Required behind a TLS-terminating proxy, or every request 308-redirects to https forever. |
| `NODE_ID` / `NODE_NAME` / `NODE_URL` | This node's cluster identity and the base URL it advertises to peers |
| `NODE_ROLE` | Bootstrap role on *first ever* boot only — it decides whether this node mints tiering generation 1. Afterwards the role derived from the held `cluster_tiering` generation always wins, so an env var can't override a decision the cluster has already made |
| `NODE_REGION` | Explicit region name (`region_source = 'configured'`). Unset = inferred by clustering heartbeat RTTs |
| `CLUSTER_REGION_RTT_MS` | RTT spread within which two *unconfigured* nodes are taken to share a region. Default 30 |
| `MASTER_URL` / `MASTER_TOKEN` | Coordinates a non-master node auto-joins at startup |
| `CLUSTER_TOKEN` | Shared bearer token for node-to-node endpoints |
| `REPLICATION_MODE` | `full` (default) or `cache` (bounded LRU over the cluster blob store) |
| `CACHE_MAX_BYTES` | Cache-mode eviction cap, over **unpinned** chunk bytes only. `0`/unset = never evict. Settable from the cluster dashboard (`PUT /api/cluster/cache-cap`). |
| `REPLICATION_FACTOR` | Chunk copies kept cluster-wide (default `2`). `1` = wherever it was written and nowhere else |
| `FILEUPLOAD_CHUNK_SIZE` | Chunk size for both upload sessions and blob manifests (default 16 MiB — a whole multiple of the AEAD 2 MiB frame) |
| `ARCHIVE_ENABLED` | Advertised to peers; gates archive participation |
| `REALDEBRID_API_KEY` | Real-Debrid API token. Set from the admin panel (Torrents tab), which validates it against `GET /user` before persisting. Empty = every torrent goes to qBittorrent. |
| `REALDEBRID_ENABLED` | Admin kill switch (default `true`). `false` routes torrents to qBittorrent without discarding the saved token. |
| `QBITTORRENT_URL` / `_USERNAME` / `_PASSWORD` | Host qBittorrent WebUI (e.g. `http://127.0.0.1:8080`). The fallback backend; empty *and* no Real-Debrid token = torrenting disabled everywhere. |
| `QBITTORRENT_SAVE_PATH` | Download location, as **qBittorrent** sees it |
| `QBITTORRENT_SEEDING` | Keep finished torrents seeding after import (default `true`). Admin-managed from the Torrents tab. qBittorrent only — a Real-Debrid job has no local torrent to seed. |
| `QBITTORRENT_SEED_RATIO` | Share ratio at which a seeding torrent is removed and its downloaded copy deleted. Default `1.0`; `0` = no ratio limit. |
| `QBITTORRENT_SEED_MINUTES` | Same, by seeding time. Default `10080` (7 days); `0` = no time limit. Whichever limit hits first wins. |
| `TORRENT_CONTENT_PATH` | The same directory as **this server** sees it; only needed when qBittorrent is containerized separately (defaults to `QBITTORRENT_SAVE_PATH`) |
| `PORT` | Listen port, default `8000` |
| `LOG_LEVEL` | Python-style level name (`DEBUG`/`INFO`/`WARNING`/…), default `INFO` |
| `FILEUPLOAD_CONFIG` | Override the config file path (default `./data/app.env`). **Environment-only** — it names the file, so it can't come from it |
| `FILEUPLOAD_STORAGE` | Override the blob storage root (default `./data/storage`) |
| `FILEUPLOAD_THUMBNAILS` | Override the thumbnail cache root (default `./data/thumbnails`) |
| `FILEUPLOAD_DEBRID` | Override the Real-Debrid staging root (default `./data/debrid`) |

### Background jobs

`jobs/scheduler.ts::startBackendWorkers` registers every job on its own
`setInterval`, each timer `unref()`'d so sweeps never hold the process open.
`stopBackendWorkers` / `restartBackendWorkers` back
`POST /api/admin/backend/restart-workers`; `startBackendWorkers` is idempotent
(it stops existing timers first). Every job is wrapped so a throw is logged and
swallowed rather than killing the timer.

| Job id | Interval | Does |
|---|---|---|
| `archive_idle` | 1h | zstd-wraps blobs idle past `archive_after_idle_days` |
| `delete_idle` | 1h | Idle-delete sweep |
| `temp_expiry` | 1h | Expires temporary files |
| `link_expiry` | 10m | Deactivates expired share links |
| `sweep_stale_parts` | 1h | Drops abandoned chunked-upload parts |
| `media_playkey_prune` | 1h | Deletes `media_play_keys` rows already past `expires_at` |
| `oauth_prune` | 1h | Deletes `oauth_*` rows already past `expires_at` |
| `cluster_heartbeat` | 1m | Peer heartbeat + liveness marking |
| `cluster_sync_check` | 5m | Digest divergence alerting |
| `cluster_tiering_drift` | 1m | Drift counter + hold-down; re-tiers on threshold (`tiering.ts`). Master-only |
| `cluster_quota_sweep` | 1h | Releases quota reservations idle for a full window (`quota.ts`). Master-only |
| `cluster_replication_pull` | 1s | Pulls the change log from this node's targets |
| `cluster_cache_eviction` | 10m | LRU chunk eviction on `REPLICATION_MODE=cache` nodes, plus registry housekeeping everywhere (`cacheEviction.ts`) |
| `cluster_chunk_replication` | 1m | Pushes under-replicated chunks toward `REPLICATION_FACTOR` copies (`placement.ts`). 20 per tick |
| `torrent_poll` | 5s | One qBittorrent list fetch per tick + Real-Debrid progress |

`cluster_replication_pull` runs at 1s because one pull interval per hop is the
propagation budget the redesign sets (§5.7). It costs a single-node deployment
nothing: no peers means no request.

---

## Project structure

```
server/src/
  index.ts                 # entrypoint: load config, init db, seed master, start workers, listen
  app.ts                   # Express app factory: middleware order, route mounting, SPA serving, error handler
  appState.ts              # AppState (settings, db, sessionManager, lockout, clusterToken, eventBus,
                           #           eventWriter, haltRegistry, loginChallenges, secondFactorTickets,
                           #           wsTokenRateLimiter). Also arms the replication triggers
                           #           (setNodeIdentity) and runs seedChangeLog.
  config.ts                # Settings loader / generator for data/app.env, and the one
                           #   resolver (configValue) merging it with the environment
  bootstrap.ts             # First-run master user seed (only when `users` is empty)
  spa.ts                   # Reads the built SPA shell, injects per-page og: meta tags
  links.ts                 # Slug minting + atomic single-UPDATE link use consumption
  audit.ts                 # Hash-chained audit log (recordAudit / verifyAuditChain)
  logging.ts               # pino + in-memory ring buffer backing GET /api/admin/backend/logs
  outbound.ts              # fetchLogged/beginOutbound — one log line per request leaving
                           #   this process, with the URL redacted first
  httpError.ts             # HttpError — thrown anywhere, rendered as {detail} by app.ts
  ws.ts                    # Websocket firehose, attached to the raw http.Server
  permissions.ts           # BOOL_FLAGS + getPermissions — the permission source of truth
  db/
    index.ts               # createDb(): picks an adapter by DATABASE_URL scheme (sqlite: only)
    schema.sql             # Whole schema, CREATE TABLE/INDEX IF NOT EXISTS, run every boot
    sqlite.ts              # bun:sqlite adapter + ensureColumn backfills for added columns
    backfill.ts            # ensureColumn helper (ALTER TABLE ADD COLUMN if absent)
    types.ts / rows.ts     # Db interface; row shapes for every table
  security/
    sessions.ts            # SessionManager: signed-cookie sid, server-side row, throttled last_seen_at
    csrf.ts                # requireCsrf (needs an already-resolved req.sessionRow)
    passwords.ts           # Argon2id via Bun.password + a constant-time dummy verify
    lockout.ts             # Rolling-window failed-login lockout, per username AND per IP
    accessLock.ts          # checkLinkAccess — per-key-scope throttle for password-locked links
    apiKeys.ts             # Key generation, hashing, first-use IP binding
    credentials.ts         # TOTP / WebAuthn credential rows
    webauthn.ts            # @simplewebauthn wrappers + rpID/origin resolution
    oauth.ts               # OAuth primitives: PKCE, hashed codes/tokens, SCOPES, pruneOauth
    loginChallenges.ts     # Pre-login websocket correlation ids + ws-token rate limiter
    secondFactorTickets.ts # Single-use password→second-factor bridge tickets
  middleware/
    asyncHandler.ts        # REQUIRED wrapper for every async route (see Gotchas)
    auth.ts                # requireSession, clientIp (proxy-header aware)
    deps.ts                # requireActiveUser / requireMaster / requirePermission / getUploadUser / requireApiKey
    securityHeaders.ts     # nosniff, DENY framing, no-referrer, HSTS in prod
    degradedMode.ts        # §5.5 write gate: method + allowlist, mounted once in app.ts
    requestLogging.ts      # Method/path/status/duration at noise-proportional levels
    httpsRedirect.ts       # 308 http→https outside dev, honoring proxy headers
  directoryTree.ts         # Folder tree: MAX_DEPTH, ancestor/subtree walks, editor checks
  crypto/
    aead.ts                # Streaming chunked AES-256-GCM file container ("FUPL" magic)
    secretbox.ts           # Single-shot AES-256-GCM for key/access blobs + sealed upload tokens
    secretEncrypt.ts       # Versioned single-shot AEAD for tiny secrets (TOTP seeds)
    effectiveEncryption.ts # THE resolver: what key actually protects a row's bytes
    passwordKey.ts         # PBKDF2-HMAC-SHA256 (600k) for password-derived seal keys
  storage/
    paths.ts               # storageRoot/thumbnailRoot, safeJoin traversal guard, fan-out rel paths
    blobs.ts               # Content-addressed dedup + ref counting (attachBlob / releaseBlob).
                           #   hashFile also returns the chunk manifest of the same pass.
    accounting.ts          # Quota + global cap + free-disk enforcement
    compress.ts            # zstd compress/decompress with zip-bomb guards
    zip.ts                 # safeArcname + memberSource (plaintext bytes for zip streaming)
    thumbnail.ts           # Cached JPEG thumbnails (sharp; ffmpeg for video frames)
    rekey.ts               # Byte rewrite behind the encryption-change endpoints
    streaming.ts           # Shared read path: peer fetch-on-miss + plaintext stream
    mediaProbe.ts          # ffprobe backfill of content_blobs media_* columns
  cluster/                 # see "Cluster subsystem" above
  jobs/
    lifecycle.ts           # archive/unarchive cores + idle-archive/idle-delete/expiry/reconcile sweeps
    scheduler.ts           # setInterval registration for every background job
  media/
    playKeys.ts            # Sealed play-key tokens + DB revocation list + prune
  torrents/
    realdebrid.ts          # Real-Debrid REST 1.0 client (user, addMagnet/addTorrent, selectFiles,
                           #   info, delete, unrestrict) + RealDebridError with authFailed
    debrid.ts              # Debrid-first dispatch + qBittorrent fallback, RD status polling,
                           #   streaming transfer of finished torrents into the staging root
    qbittorrent.ts         # WebUI API v2 client (cached SID, allTorrents, byTag, add/delete)
    poller.ts              # torrent_poll scheduler job: progress mirroring + completion import
    importer.ts            # Copies finished torrent content through the normal finalize pipeline
  routes/                  # one file per surface; see "Route mounts" below

client/src/
  App.tsx                  # Route table (public /file/:slug, /d/:slug, /watch, /oauth/authorize;
                           #   guarded /files, /account, /api-keys, /api-docs, /torrents,
                           #   /cluster, /admin)
  main.tsx                 # Provider stack + the pre-paint theme applier (no ThemeProvider —
                           #   an IIFE reads `fu_theme` from localStorage before first paint)
  features/
    auth/                  # Login page, second-factor step, auth context, login websocket
    account/               # Profile, avatar, password, security (MFA) tab
    drive/                 # The unified explorer: tree browsing, upload, move/rename,
                           #   multi-select, drag & drop, the encryption side panel
    files/                 # Upload core + options, link management, remote upload,
                           #   share modal (the old Files *page* lives in drive/ now)
    directories/           # Folder list, folder links modal, folder upload
    download/              # Public download page (/file/:slug)
    folder-view/           # Public folder view (/d/:slug)
    dropbox/               # Dropbox link management + public token-gated upload page
    apikeys/               # API key management UI
    torrents/              # Torrents page (add magnet/.torrent, live progress)
    cluster/               # Cluster dashboard (tier + region + generation + drift,
                           #   nodes, token, halts, manual re-tier) + the topology
                           #   diagram, whose graph comes from the server and whose
                           #   lib/topologyLayout.ts only positions it. ConflictsTab
                           #   lives here too and is mounted by the *admin* panel.
    admin/                 # Admin panel (users, files, keys, audit, storage, logs, torrents)
    media/                 # Media library: poster grid, player, publish + play-key UI
    oauth/                 # OAuth app management + the /oauth/authorize consent page
    api-docs/              # API reference page — renders docs/api.md, imported into the
                           #   bundle at build time (`@docs/api.md?raw`), not fetched
  components/
    layout/                # AppShell, PublicShell, Sidebar, Header, UserMenu, Brand,
                           #   SettingsModal (sessions tab), PageHeader, guards.tsx,
                           #   FeatureUnavailable, FullPageSpinner
    ui/                    # Shared Radix-based design system components
  workers/                 # aead.worker.ts (the worker) + aeadClient.ts / aeadTypes.ts (its
                           #   main-thread wrapper and message contract) + fuplCore.ts (the
                           #   FUPL container itself, shared by both sides)
  lib/                     # base64url, bytes, cn, copy, download, redirect, time, zip helpers
  config/
    api.ts                 # Typed API client (CSRF header, ApiError normalization)
    featureFlags.ts        # All true; kept as a kill switch
    navigation.ts          # Sidebar nav items
    permissions.ts         # Permission flags + UI metadata
  providers/               # QueryProvider (TanStack), DialogProvider, ToastProvider.
                           #   UploadProvider lives in features/files/hooks/useUpload.tsx and
                           #   RevealedKeyProvider in features/drive/hooks/useRevealedKeys.tsx —
                           #   both are mounted from main.tsx, RevealedKeyProvider deliberately
                           #   *above* BrowserRouter so a revealed key survives navigation.

docs/
  api.md                   # THE public API reference — single source; served raw at
                           #   GET /api/docs.md (for LLMs/tooling) and compiled into the
                           #   /api-docs page bundle. Editing it needs a client rebuild
                           #   for the page; the endpoint re-reads it on mtime change.
  cluster-redesign.md      # The cluster rework's design doc + phasing. Authority on intent;
                           #   see "Where the cluster rework stands" above for what is built.
public/                    # Built client output, served by Express
data/                      # Runtime state: app.env, app.db, storage/, thumbnails/, debrid/
                           #   (gitignored)
plan.md, checklist.md, progress.md
                           # Working notes from the completed Drive/explorer rework. Historical
                           #   — they describe finished work, not the current backlog.
```

### Route mounts

Every data endpoint lives under `/api/*` so it can never collide with an SPA client-side route (`/files`, `/admin`, `/cluster` are both page routes and API prefixes).

| Mount | Router |
|---|---|
| `/api/auth` | `auth.ts` — login, MFA verify, logout, session list/revoke |
| `/api/account`, `/api/account/mfa` | `account.ts`, `mfa.ts` |
| `/api/oauth` | `oauth.ts` — `oauthRouter` (session-authenticated app management + consent) **and** `oauthPublicRouter` (`/token`, `/revoke`, `/userinfo`, `/metadata`), mounted at the same prefix |
| `/api/files`, `/api/links`, `/api/admin/files` | `files.ts` (+ `remoteUpload.ts` on `/api/files`) |
| `/api/keys`, `/api/admin/keys` | `keys.ts` |
| `/api/users`, `/api/audit`, `/api/admin` | `users.ts`, `audit.ts`, `admin.ts` |
| `/api/torrents`, `/api/admin/torrents` | `torrents.ts` |
| `/api/media` | `media.ts` — library browse, publish, stream, play keys |
| `/api/cluster`, `/api/admin/cluster` | `cluster.ts` |
| `/api/admin/directories` | `directories.ts::adminDirectoriesRouter` — flat every-folder list, master-only |
| `/api` (self-prefixed paths) | `directories.ts` (`directoriesRouter` + `publicDirectoriesRouter`), `dropbox.ts`, `docs.ts` (`/docs.md`), `public.ts` (`/file/:slug*`), public folder routes (`/d/:slug*`) |

`routes/directories.ts` is one file exporting **three** routers with different
auth postures — `directoriesRouter` (session), `adminDirectoriesRouter`
(`requireMaster`), `publicDirectoriesRouter` (link slug is the credential). The
public one is mounted last, after every authenticated router, so a `/d/:slug`
path can't shadow one.

---

## Key patterns

### Authentication

- Session id in an HMAC-signed `fu_session` HTTP-only cookie (`SameSite=strict`); the session row (including its CSRF token) lives server-side.
- CSRF token returned at login, stored in `localStorage` as `fu_csrf_token`, sent as `X-CSRF-Token` on every mutating request. `requireCsrf` validates it against the resolved session row — it requires `requireSession` to have run first.
- API key auth via `Authorization: Bearer <key>` bypasses CSRF (no cookie, no cross-site risk). Keys bind to their first-seen IP on first use.
- Roles: `master` (admin) and `user`. `master` bypasses all permission checks.
- `must_change_credentials` accounts are rejected by `requireActiveUser` (403) but can still reach `/api/account/change-credentials`.

### Login + second factor

The login flow is a multi-step ceremony, not a single POST:

1. `POST /api/auth/login` verifies the password. If the user has enrolled credentials **and** MFA is enforced (`mfa_required`, or role `master`), it returns `{status: "mfa_required", mfa_ticket, methods}` instead of a session.
2. The ticket (`security/secondFactorTickets.ts`) is single-use, 2-minute TTL, 5-attempt cap. It is *not* proof of authentication on its own.
3. `POST /api/auth/totp/verify-login` or the WebAuthn login pair completes the ceremony and issues the session.
4. Usernameless WebAuthn login (`/api/auth/webauthn/login/start|finish`) skips step 1 entirely — the passkey identifies the user.
5. `GET /api/auth/ws-token` mints a short-lived `conn_id` for the pre-login websocket (`/api/auth`), which pushes live state transitions during the ceremony. `conn_id` is a transport correlation id **only**, never an authorization credential.

Failed logins feed `security/lockout.ts`, which counts per-username *and* per-IP within a rolling 15-minute window; only the username counter resets on success.

### Database

- SQLite via `bun:sqlite` (no ORM, no Alembic). `db/schema.sql` runs on every boot as `CREATE TABLE/INDEX IF NOT EXISTS`.
- **Never use migrations.** Add nullable columns or columns with a `DEFAULT`, then add an `ensureColumn()` call in `db/sqlite.ts` — `CREATE TABLE IF NOT EXISTS` does nothing to an already-existing table, so new columns *only* land via `ensureColumn`.
- New indexes need no backfill: `CREATE INDEX IF NOT EXISTS` in `schema.sql` applies to existing databases on the next boot.
- Timestamps are ISO8601 UTC strings (`nowIso()`), not a dedicated column type. Comparisons are lexicographic string comparisons, which is why the format must stay fixed-width UTC.
- `PRAGMA foreign_keys = ON` and WAL journaling are both enabled in `db/sqlite.ts`.
- Columns dropped from a `db/rows.ts` interface are silently ignored — they remain in the DB.
- `db.get()` returns `undefined` on a miss. `bun:sqlite` itself returns `null`; the adapter normalizes it, so `=== undefined` is safe — but prefer `if (!row)` anyway.

### OAuth 2.0 authorization server

Third-party apps act *as* a fileupload user. `security/oauth.ts` holds the
primitives, `routes/oauth.ts` the endpoints, `middleware/deps.ts` the guards
(`requireOauthScope`, `requireScopeOrSession`, `optionalOauthViewer`).
Authorization-code flow with PKCE (S256 only); the consent page is the SPA route
`/oauth/authorize`.

- **A scope is never the last word on what a token may do.** Each scope in
  `SCOPES` names a permission flag, re-checked against the user's *live*
  permissions on every request — so revoking `can_upload` immediately neuters
  every outstanding token carrying `files:write`, with no token hunt.
- **Bearer values are routed by prefix**: `fuo_` = OAuth access token, `fur_` =
  refresh token, no prefix = API key. That is what lets one `Authorization`
  header serve two credential tables without probing both.
- **Codes and tokens are stored hashed.** A database read must not yield usable
  credentials.
- **A replayed authorization code or a reused refresh token revokes the whole
  grant**, not just the request — the safe reading of a replay is that the
  credential leaked.
- **`redirect_uri` is matched by exact string**, never by prefix or origin.
- **`pruneOauth` only deletes rows already past `expires_at`.** A revoked but
  unexpired row *is* the reuse-detection record; dropping it early would
  downgrade a replayed refresh token to a bare unknown-token error.
- **OAuth state is node-local**, like sessions and play keys: `oauth_clients`,
  `oauth_auth_codes` and `oauth_tokens` are deliberately absent from the change
  log's `CHANGELOG_TABLES`. Registering an app on one node does not make it usable
  against a peer.
- Adding a scope means wiring it into the routes it is supposed to unlock, or an
  app gets granted something that silently does nothing.

### File storage

- Blobs live under `data/storage/` (override: `FILEUPLOAD_STORAGE`) at a random two-level fan-out path (`ab/cd/<rest>`), **not** a name derived from the upload.
- Storage is content-addressed and deduplicated: `attachBlob()` keys on `(stored_sha256, transform_key)` and bumps `ref_count` on a hit; `releaseBlob()` decrements and returns the physical path to unlink only when the last reference goes.
- Two different "used bytes" numbers exist and are not interchangeable:
  - `usedStorageBytes()` — `SUM(stored_size_bytes)` over `content_blobs`. Real disk consumption, post-dedup. Used for the global cap.
  - `usedStorageBytesForUser()` / `usedBytes()` — `SUM(size_bytes)` over that user's `files`. Logical, pre-dedup. Used for per-user quota, so dedup savings aren't silently handed to whoever uploaded second.
- Archived blobs are excluded from dedup matching — their on-disk bytes are zstd-wrapped and don't match the identity they were minted for.

### Folder tree

`directories.parent_directory_id` makes folders a tree, at most `MAX_DEPTH = 10`
levels deep (`server/src/directoryTree.ts`, which also owns `ancestorChain`,
`subtree`, `subtreeHeight`, `isSelfOrDescendant`, `nearestOverride`,
`directoryRole`/`isEditor` and `buildPathIndex`). A collaborator grant on a
folder applies to everything beneath it, because the permission check walks the
ancestor chain rather than looking at one row.

**One endpoint reads the tree: `GET /directories`.** Which read you get is
chosen by search parameters, never by path — browsing a level, walking a
subtree, listing everything reachable and searching are the same request with
different arguments:

| Param | Values | Meaning |
|---|---|---|
| `parent` | `root` (default) or an id | Where to look. Ignored when `scope=all`. |
| `scope` | `level` (default) · `subtree` · `all` | One level · everything beneath `parent` · every folder the caller can reach. |
| `q` | string | Case-insensitive substring over folder titles and file names, within `scope`. |
| `type` | `all` (default) · `directories` · `files` | Restrict the kind returned. |
| `limit` / `offset` | ints, limit caps at 500 | Paging, applied after filtering. |

The default (`scope=level`, no `q`) is the Drive explorer's per-level fetch and
is still **not** a recursive dump. Notes that are easy to re-break:

- `subtree()` in `directoryTree.ts` is *"at or below"* — it includes the folder
  you passed. The endpoint drops it, or a folder turns up among its own
  descendants and its files get counted twice.
- `type` is applied **while collecting, not after**. `scope=all&type=directories`
  is the folder picker's call; collecting every file first and discarding them
  would read the whole `files` table on every picker open.
- Folders can only be dropped *after* collection, because a subtree's file set
  is derived from them.
- Search results carry a `path` (the folder chain they were found at) built with
  `buildPathIndex` — one table read, never an ancestor walk per row.
- `serializeDirectories` runs a `COUNT(*)` per row, so it is only ever called on
  the **paged** slice.

### Encryption modes

| Mode | Description |
|---|---|
| `none` | No encryption. The link slug is the only credential. |
| `server` | AES-GCM encrypted at rest. `?ek=` query param gates download; the server decrypts before streaming. |
| `client` | E2E encrypted in the browser. Ciphertext stored server-side. The `#ek=` fragment never reaches the server. |
| `sealed` | Seal & Forget (files only). The server encrypted it, returned the key once, and kept no copy. Every read path treats it exactly like `client`. |

**Transform order matters and differs by producer** (see Gotchas): upload-time compression produces `ENC(ZSTD(x))` with `compressed = 1`; the archive job produces `ZSTD(ENC(x))` with `compressed = 0, archived = 1`.

### Encryption inheritance

`encryption_overridden` (on both `directories` and `files`) says whether a row
holds a key of its own. `0` means it inherits from the nearest ancestor with
`1` — a "break point" — and its own `enc_key_blob`/`enc_access_blob` columns are
NULL. A root-level folder is always a break point.

**Never read `enc_key_blob`/`enc_access_blob`/`encryption_mode` off a row for a
read path.** `crypto/effectiveEncryption.ts` (`resolveDirectoryEncryption`,
`resolveFileEncryption`) is the authority; `encryption_mode` survives on
inheriting rows only as a denormalized mirror, because plain SQL filters in
`jobs/lifecycle.ts`, `routes/admin.ts` and `storage/mediaProbe.ts` must not walk
a tree per row — so anything that changes an effective mode has to rewrite its
descendants' mirrors.

Changing a node's encryption (`PATCH /{directories,files}/:id/encryption`)
physically rewrites every affected descendant's bytes via
`storage/rekey.ts`, synchronously. `client`/`sealed` are refused there: the
server has no key, so that conversion is a browser-side
download-decrypt-reupload committed by `POST /files/:id/e2e-conversion`.

Public payloads carry a `key_scope` (`dir:7`, `file:34`) naming *which* secret
opens each node, because one shared subtree can contain several break points.

### Password locks

`access_is_password` records that a `server`-mode node's `?ek=` secret is an
owner-chosen password rather than a random 144-bit token. The secret is stored
identically either way; the flag exists because a human password is guessable,
so `security/accessLock.ts::checkLinkAccess` throttles public verification
**per link slug** (a distributed guesser would sail past an IP-keyed limit)
using `security/lockout.ts`'s `link_access` identifier type. Random-token links
are deliberately unthrottled — throttling them would let anyone lock a public
link out of service.

### Share links

- `links` (files) and `directory_links` (folders) have identical shapes: `slug`, `max_uses`, `use_count`, `expires_at`, `active`, `hide_uploader`.
- `hide_uploader` suppresses the uploader's name/avatar on the public page **and** in the API response.
- Multiple links per file, each with its own limits. Folder public URLs resolve via `directory_links.slug`, never `directories.slug`; a default folder link is auto-created at folder creation.
- A folder link covers a **subtree**. `/d/:slug/info`, `/preview-manifest` and `/zip` take `?dir=<id>`, bounded by `isSelfOrDescendant` — a node outside the link's own subtree answers 404, not 403, because a link must not confirm what exists elsewhere. `POST /d/:slug/unlock` proves a key for one node without starting a download.
- The zip and `POST /d/:slug/save` both recurse **only as far as the presented key reaches**: plaintext descendants are included, a descendant holding its own key is skipped. Including it would hand away the entire point of a break point.
- `directories.gallery_view` switches the public folder page from a file list to a gallery of poster tiles with inline players. Cosmetic only; read off the folder the *link* points at, so it doesn't change under a visitor mid-navigation. Unrelated to `is_library`, which is the global `/watch` catalog.
- Use consumption is a single atomic `UPDATE … WHERE … RETURNING id` (`links.ts::consumeUse`) so concurrent downloads can't overshoot `max_uses`.

### Permissions

Defined in `server/src/permissions.ts` (`BOOL_FLAGS`) and mirrored in `client/src/config/permissions.ts`:

`can_upload` · `can_upload_client_encrypted` · `can_delete` · `can_regenerate_links` · `can_delete_links` · `can_create_directories` · `can_manage_lifecycle` · `can_use_api_keys` · `can_view_admin` · `can_manage_users` · `can_manage_storage` · `can_manage_api_keys` · `can_manage_cluster` · `can_use_torrents` · `can_watch_media` · `require_mfa` · `require_passkey`

The last two are *restrictions*, not capabilities: they force an account to
enrol a second factor (any, or a passkey specifically) and block it from every
route except the MFA enrolment endpoints until it does. They are deliberately
absent from `MASTER_ALL_TRUE` and the master seed — turning them on for every
admin by default would lock the panel out.

Plus the non-boolean `quota_bytes`, `max_file_bytes`, `archive_after_idle_days`. `master` bypasses every check.

Adding a flag means touching **all** of: `db/schema.sql`, an `ensureColumn` backfill in `db/sqlite.ts`, `db/rows.ts`, `permissions.ts` (`BOOL_FLAGS` + the master seed insert), `bootstrap.ts`, `MASTER_ALL_TRUE` in `routes/users.ts`, the `/account/me` payload in `routes/account.ts`, `TABLE_COLUMNS.permissions` in `cluster/changelog.ts` (or it silently resets to the default on every peer), and `client/src/config/permissions.ts`.

### Admin panel

- Gated by `requireMaster`, except bulk actions, which also accept a non-master holding `can_view_admin` plus the specific flag for that action (`BULK_ACTION_PERMISSIONS`).
- Files and keys tabs group by owner username, alphabetically.
- Bulk actions require an exact `CONFIRM <n>` phrase matching the previewed candidate count. **A bulk action with no ids and no `owner_id` targets every matching row in the system** — that's intentional, and the confirmation phrase is the only guard.
- API keys are hard-deleted, never soft-deleted, so they leave the panel immediately.
- `GET /api/audit` only verifies the hash chain when asked (`?verify=1`); it's an O(all rows) rehash, so it isn't run on every page load.

### Torrenting

Two backends, chosen per job. **Real-Debrid is preferred and qBittorrent is the fallback** — never the other way round. `torrent_jobs.provider` records which one owns a given job (`'debrid'` | `'qbittorrent'`), and every job of either kind ends at the same place: `finalizeStoredFile`, so quota, blob dedup, link minting and cluster replication behave exactly like a normal upload. Multi-file torrents land in a new folder named after the torrent; single-file torrents become a plain file. `source_type` is `torrent`.

`POST /api/torrents` (needs `can_use_torrents`) accepts a magnet or an uploaded `.torrent` and calls `debrid.ts::dispatchTorrent`, which decides the backend. Each job gets a unique tag (`fu-<hex>`) — for qBittorrent the tag (not the info hash) is how the poller finds the torrent again; for both providers it names the per-job download directory.

**Concurrency is a queue, not a refusal.** `MAX_ACTIVE_PER_USER = 5` (in
`torrents/poller.ts`) caps how many of one user's torrents run at once; a sixth
is accepted and parked in status `pending` with **nothing dispatched to any
backend**, and `promotePendingJobs` starts it from the `torrent_poll` tick as
soon as one of that user's slots frees. Per user, not global — one account
filling its own queue must not stall everyone else's. The only hard refusal is
`MAX_QUEUED_PER_USER = 50` (429), which bounds the backlog itself.

- **A pending job has no provider.** Which backend it lands on is decided at
  dispatch, minutes or hours later, so `provider` still holds its schema default
  and the route serializes it as `null` rather than reporting a guess.
- **Re-dispatch needs the source to survive the request.** A magnet is stored
  whole in `torrent_jobs.source` (**not truncated** — a clipped magnet is a dead
  one, and the Real-Debrid→qBittorrent fallback re-dispatches from this column
  too); an uploaded `.torrent`'s bytes go to the on-disk stash
  (`debrid.ts::stashSource`) at accept time, because the request body is the only
  copy and it is long gone by the time the queue gets there.
- **`started_at`, not `created_at`, is the poller's clock.** `MISSING_GRACE_MS`
  ("qBittorrent has never heard of this tag") runs from dispatch — measured from
  submission, an hour in the queue would blow the 3-minute grace the instant the
  job started. NULL on rows predating the queue, which fall back to `created_at`.

**Seeding (qBittorrent only).** With `QBITTORRENT_SEEDING` on, a finished
qBittorrent job moves to status `seeding` instead of `completed`: the import
already **copied** the files into blob storage, so the download is still on disk
and the torrent keeps uploading from it. `completed_at`, `imported_file_count`
and `progress` are all set at import time — the owner's wait is over either way.

- **A seeding job holds no concurrency slot.** It is absent from
  `IN_FLIGHT_STATUSES` on purpose: its files are imported, and a popular torrent
  must not block that user's next download for days.
- **The poller enforces the limits, qBittorrent only stops uploading.**
  `setShareLimits` is applied per torrent so it stops on its own if the poller
  never runs again, but qBittorrent's *share-limit action* is a global setting we
  don't control — so `pollSeedingJob` compares ratio/seeding-time itself and
  `finishSeeding` is what deletes the torrent, deletes the downloaded copy and
  settles the row to `completed`.
- **A missing torrent settles a seeding job, it does not fail it.** Removed by
  the operator or retired by qBittorrent's own action, the outcome is the same:
  the files were imported before seeding ever began.
- Seeding costs **no extra requests**: downloading and seeding jobs are both
  resolved out of the one `allTorrents` list already fetched per tick.
- Turning seeding off, or unconfiguring qBittorrent, retires every seeding job on
  the next tick rather than stranding it there with its download on disk.

**Real-Debrid path** (`torrents/realdebrid.ts` + `torrents/debrid.ts`):

1. `POST /torrents/addMagnet` or `PUT /torrents/addTorrent` (raw metainfo body), then `POST /torrents/selectFiles/{id}` with `files=all` — a freshly added torrent parks in `waiting_files_selection` and will never start without it. A magnet rejects the call until `magnet_conversion` finishes, so the poller retries it.
2. The `torrent_poll` job polls `GET /torrents/info/{id}` (throttled to 10s per job — the token is rate limited) and mirrors Real-Debrid's status onto `debrid_status`, progress onto `progress`/`size_bytes`/`dl_speed`.
3. On `downloaded`, the job flips to status `fetching` and a **detached** task streams every link (`POST /unrestrict/link` immediately before each transfer, since those URLs are short-lived) into `data/debrid/<tag>/`, laid out to match the torrent's own directory structure. The transfer runs outside the poll loop so a multi-GB pull doesn't stall every other job's progress updates.
4. The staged directory is then handed to the same importer qBittorrent jobs use, and the torrent is deleted from the Real-Debrid account.

**Fallback to qBittorrent** happens when Real-Debrid can't deliver: no token, a rejected token, a non-premium account, exhausted traffic, an API outage, a `magnet_error`/`error`/`virus`/`dead` status, or a transfer that fails twice. The job's row is rewritten in place (`provider`, `save_path`, `created_at` reset, `fallback_reason` set) and restarted on qBittorrent, so the user sees one job throughout.

Notes:
- **No cache pre-check, ever.** Real-Debrid downloads a torrent it has never seen just as happily as a cached one, so `dispatchTorrent` deliberately does *not* call `instantAvailability`. Everything goes through debrid when it's configured; only failure demotes a job.
- **Polling shape (qBittorrent):** one `GET /api/v2/torrents/info` per tick for the whole cluster of jobs, grouped by tag locally (`qbittorrent.ts::allTorrents` + `byTag`), and **zero** qBittorrent requests when nothing is in flight. Don't reintroduce a per-job request — older qBittorrent builds ignore the `?tag=` filter and return the full list every time, so per-job polling is O(jobs) full list fetches every tick.
- Client poll intervals are deliberately matched to the server's 5s cadence, with `refetchIntervalInBackground: false`. Polling faster than the server refreshes just multiplies identical responses.
- Only magnets and uploaded `.torrent` files are accepted. Handing qBittorrent an arbitrary `http(s)` URL would turn it into an SSRF proxy into the host's network — a surface `routes/remoteUpload.ts` guards by pinning validated public IPs, which is impossible to enforce through qBittorrent. The same URL through Real-Debrid is just remote-upload with extra steps.
- The Real-Debrid token is admin-managed (`PUT /api/admin/torrents/debrid`), validated against `GET /user` **before** it is persisted — an unchecked key would look installed while quietly demoting every job — and written to `data/app.env` (mode 0600). It is node-local config, not replicated cluster state.
- `TORRENT_CONTENT_PATH` exists because the import reads files directly off disk, and qBittorrent's view of the download directory differs from this server's as soon as either side is containerized. Debrid jobs never need it: `importer.ts::localJobDir` branches on `provider` and returns our own staging root.
- Everything (routes, poller, nav item) is inert unless a Real-Debrid token **or** `QBITTORRENT_URL` + `QBITTORRENT_SAVE_PATH` are set; the API answers 503 and the admin Torrents tab says so.

### Media library

Folders published with `directories.is_library` become browsable collections on
`/watch`; their video/audio children are the playable titles. `library_visibility`
is `public` (anyone, no account, like a share link) or `restricted` (an account
holding `can_watch_media`; the owner and masters always qualify). `library_kind`
picks the presentation — `movie` (one title) vs `series` (episode list).

External players carry no session cookie, so restricted titles are also reachable
with a **play key** (`media/playKeys.ts`): an AES-GCM sealed token appended to the
stream URL as `?k=`, scoped to one file or one collection. Verification is a
decrypt rather than a join (mpv issues a Range request per seek), with
`media_play_keys` as the revocation list behind it.

- **An unknown `jti` is rejected, not trusted.** That strictness is what makes the
  `media_playkey_prune` job safe: it only deletes rows already past `expires_at`,
  by which point the token is refused on expiry anyway, so a pruned revocation can
  never revive a working key.
- **Play keys are node-local**, like sessions. The token pins the minting node's
  `NODE_ID`; presented to a peer it fails with a "wrong node" error rather than a
  bare 401. `media_play_keys` is deliberately absent from `CHANGELOG_TABLES`.
- **Entitlement is re-checked per stream request**, not just at mint time, so
  revoking `can_watch_media` kills outstanding keys immediately.
- **Seeking depends on storage form.** An untransformed file is served with
  `Accept-Ranges: bytes`; encrypted/compressed/archived titles are reproduced from
  byte zero (`storage/streaming.ts`) and stream 200-only. `entries[].seekable`
  tells the client which is which.
- `content_blobs.media_width/height/duration_seconds` were never written by
  anything until now — `storage/mediaProbe.ts` fills them via ffprobe at publish
  time, keyed on the blob so dedup shares the result.

### Session management

- The `sessions` row holds: `id` (the signed cookie's sid), `user_id`, `csrf_token`, `created_at`, `last_seen_at`, `expires_at`, `ip_address`, `user_agent`, `country_code`. 24-hour TTL.
- `last_seen_at` updates at most once a minute per session, so an active client doesn't cause a write per request.
- `country_code` is Cloudflare's `CF-IPCountry`, read by `middleware/auth.ts::clientCountry`: ISO 3166-1 alpha-2, plus Cloudflare's two specials — `XX` (no country data for this client) and `T1` (client came out of the Tor network). It is recorded **once, at login**, so it describes where the session was started rather than drifting as the user moves.
  - **Trusted on exactly the same terms as `clientIp`**: `TRUST_PROXY=cloudflare`, or `TRUST_PROXY=true` *plus* a `CF-Ray` header proving the request really passed through Cloudflare. Any client can send `CF-IPCountry`, so reading it ungated would let a visitor pick their own country.
  - Nothing trustworthy to report ⇒ the column stays NULL. It is never filled with a guess.
  - `T1` is **not** an ISO code — never render it as a flag or look it up in a country table. The client's `regionLabel` spells both specials out in words.
- Settings → Sessions tab: list active sessions, revoke one (password required), sign out everywhere.
- `GET /api/auth/sessions`, `DELETE /api/auth/sessions/:id`, `DELETE /api/auth/sessions`.

### Duplicate save prevention

- `files.saved_from_file_id` / `directories.saved_from_directory_id` record the origin when something is saved from a share link.
- The backend rejects (409) an owner saving their own item, or the same user saving the same item twice.
- The frontend disables the Save button and shows "Already saved" when the public info endpoint returns `already_saved: true`.

### Frontend API client

`client/src/config/api.ts` — typed `fetch` wrapper that prefixes `/api`, sends `credentials: "same-origin"`, attaches `X-CSRF-Token` to POST/PUT/PATCH/DELETE, and throws `ApiError` carrying the backend's `detail`. Upload progress needs `XMLHttpRequest`, so `filesService.ts` has its own XHR path that mirrors the same CSRF rules.

---

## Gotchas / invariants

Non-obvious rules that are easy to re-break. Each one has bitten this codebase already.

- **Wrap every `async` route handler in `asyncHandler`** (`middleware/asyncHandler.ts`). This is Express **4**, which does not await handlers — a rejected promise becomes an unhandled rejection and the request hangs forever with no response ever sent, rather than producing a 500.
- **`express.json()` runs with an explicit 8 MB limit**, not the 100 KB default, because `POST /api/torrents` accepts base64 `.torrent` payloads up to 2 MiB (base64 inflates 4/3). Keep the limit above `MAX_TORRENT_FILE_BYTES * 4/3`.
- **Deleting a user requires clearing every table that FKs to `users`** — `PRAGMA foreign_keys = ON` means a missed one throws instead of cascading. Currently: `permissions`, `sessions`, `credentials`, `files`, `directories`, `directory_collaborators` (both `user_id` and `invited_by_id`), `api_keys`, `dropbox_upload_links`, `remote_upload_jobs`, `torrent_jobs`, `media_play_keys`, the three `oauth_*` tables (via
`routes/oauth.ts::purgeOauthForUser`, which clears both the apps they *own* and
the grants they were *issued*), and `cluster_nodes.created_by_id`.
- **`/account/reset` must not delete the user's `permissions` row** — that would silently reset an admin-assigned quota to the default. Reset purges *content*; only true account deletion purges identity.
- **Decrypt/decompress order depends on the producer.** `archived && !compressed` is `ZSTD(ENC(x))` (decompress, then decrypt); every other compressed+encrypted combination is `ENC(ZSTD(x))` (decrypt, then decompress). `routes/public.ts` and `storage/zip.ts` both branch on this — keep them in sync.
- **Don't read `process.env` for a config key — go through `configValue()`.** A direct read skips `app.env`, which re-splits the one namespace `config.ts` exists to merge; a key resolved two ways is a key that answers differently depending on which module asks.
- **Persist config before applying it in memory.** `setEnvValue` throws `ConfigLockedError` when the environment supplies the key, so `settings.x = v; setEnvValue(...)` leaves the process holding a value the file refused.
- **`TRUST_PROXY` must be set behind a TLS-terminating proxy.** Otherwise `req.protocol` stays `http` in prod and `httpsRedirect` 308s in an infinite loop.
- **Anything added to a replicated table must also be added to `cluster/changelog.ts`'s `TABLE_COLUMNS`**, or the column silently resets to its default on every peer. A new `BLOB` column additionally needs an entry in `BLOB_COLUMNS` (`json_object()` refuses to hold blob values, so they travel as hex) and a new id-valued column needs one in `FOREIGN_KEYS` — an untranslated id lands on a peer pointing at whatever row happens to occupy that number there.
- **Don't call anything to replicate a write.** The change log is appended by a trigger inside the same transaction as the write itself (`cluster/changelog.ts`), which is the entire point of Phase 3 — the previous design asked every route handler to remember, and two of about forty did. A route that "also replicates" is a bug.
- **`replication_control.suppressed` must be lowered on every path that raises it.** It is raised while applying a peer's entries so they aren't re-logged as local writes; left raised, this node silently stops logging its own. `installChangeLog` clears it at boot for exactly that reason.
- **The change-log triggers do nothing until `setNodeIdentity` runs**, and that is load-bearing, not a startup race. It is what keeps `identity.ts`'s boot `uid` backfill — which rewrites every row in every replicated table — out of the log. `createAppState` calls it, and nothing writes between `createDb` and there. Don't move a write earlier in `index.ts`.
- **`index.ts`'s startup order is a dependency chain, not a style choice.** `createDb` → `initTiering` (mints generation 1 from `NODE_ROLE` on first ever boot, and mirrors `replication_control.is_master`) → `createAppState` (`setNodeIdentity` + `seedChangeLog`, whose seed reads that column to decide whether this node assigns `master_seq`) → `ensureMaster` → workers → join. Reordering it either logs the backfill or seeds the log against the wrong role.
- **`replication_control` carries `node_id`, `suppressed` and `is_master` as *columns* because a trigger cannot reach application state — only other tables.** `is_master` is mirrored there by `tiering.ts` on every generation change; a code path that changes who is master without going through `mirror()` silently stops (or starts) assigning `master_seq`.
- **A replicated table is one in `identity.ts`'s `UID_TABLES`, and that list is `CHANGELOG_TABLES`.** Adding a table to one adds it to the other by construction — but it also needs a `TABLE_COLUMNS` entry, a `uid` column in `schema.sql`, and the backfill will rewrite every existing row on the next boot. Node-local tables (`sessions`, `media_play_keys`, `oauth_*`, `cluster_*`, `torrent_jobs`, `remote_upload_jobs`, `audit_log`) are absent **on purpose**; each has its own reason, recorded next to it.
- **`id` is node-local and never replicates.** `TABLE_COLUMNS` deliberately omits it from every table — a row is identified across the cluster by its ULID `uid`, and an id-valued column that crosses the wire needs a `FOREIGN_KEYS` entry so the peer translates it. An untranslated id lands pointing at whatever row happens to occupy that number there.
- **A node pulls from its upstream and from whoever's upstream it is — nothing else.** `pullTargets()` derives both halves of every edge from `upstreamOf()` over the same generation, so the two ends agree without negotiating. The permitted fallback is exactly one: a follower whose region leader is unreachable pulls from the **master**. Adding a "fall back to any peer" branch is how a partition converges on two different answers, and a node holding no generation pulls from nobody at all — it is supposed to degrade, not improvise.
- **A role is derived, never asserted.** `cluster_nodes.role`/`.is_master`/`.region` are written from the local tiering generation. The `role` field on a `/join` or `/heartbeat` body is for logs and the UI; reading it back into the table re-opens S4.
- **Only the master mints a generation.** `retier()` no-ops on a non-master, and that is what makes "no master ⇒ leadership does not move" true without a separate check. Don't add a promote-yourself path — operator promotion (Phase 5) mints `reason='promotion'` *from the node being promoted only after a human has confirmed it*, which is a different thing.
- **Never read `users.password_hash` on a login path.** Go through
  `cluster/identityFetch.ts::ensureCredentialMaterial` — on a node that has not
  fetched the material the column holds `''`, which `verifyPassword` reads as a
  wrong password. A re-auth on an *already authenticated* session (revoking a
  session, deleting an account, removing a credential) may read it directly: the
  session only exists because a login on this node already fetched it.
- **Every path that sets a password or enrols TOTP must bump
  `credential_version`** and publish. Without the bump, peers keep honouring the
  old credential until something else happens to invalidate their copy — which
  may be never.
- **`INSERT INTO users` must set `credential_version_local`.** A row inserted
  without it reads as "holds no material" on the node that just minted the hash,
  and that node will go looking for an upstream to fetch its own password from.
- **A chunk manifest has one writer, and it is the node that created the blob.** `recordManifest` is a no-op when rows exist, and a dedup hit records presence only — minting a second manifest ships a duplicate set of `(blob_id, idx)` rows to every peer. The legacy seed (`seedLegacyManifests`) runs on the master alone, and *after* `seedChangeLog`, because appending entries is exactly what makes the seed pass think it has already run.
- **Anything that rewrites a blob's stored bytes in place must call `rechunkBlob`.** Today that is only the archive/unarchive path in `jobs/lifecycle.ts`; every other rewrite mints a new blob through `attachBlob`. A stale manifest makes every peer's chunk fetch fail its hash check forever.
- **Never add a UNIQUE constraint to `blob_chunks` or `chunk_locations`.** A UNIQUE violation raised while applying a peer's entry halts the replication batch at that entry, permanently. Count copies with `COUNT(DISTINCT node_id)` instead.
- **Don't put a per-read column in a replicated table.** `chunk_locations.last_read_at` was the obvious place for the LRU clock and would have appended a change-log entry — shipped cluster-wide — on every read; it lives in node-local `local_chunk_cache` instead.
- **A play key must never be trusted on a jti that isn't in `media_play_keys`.** Treating a missing row as valid would make the prune job a revocation-bypass.
- **Deleting a file must also call `deleteThumbnail(fileId)`** — the thumbnail cache is keyed by file id and is not reference-counted.
- **A debrid retry decides re-import vs. re-download by the `data/debrid/_sources/<tag>.complete` marker**, not by "the staging directory has files in it". A transfer aborted halfway also leaves files there, and importing those would silently store truncated content. The marker is written only after the last byte of the last link lands (`debrid.ts::markTransferComplete`), and lives outside the job directory so the importer never sees it as content.
- **Real-Debrid file paths are attacker-controlled** (they come out of the torrent): `debrid.ts` runs every one through `sanitizeSegment` + `safeJoin` before creating anything.
- **Don't add unbounded in-memory maps without a sweep.** Several registries (halt, login challenges, second-factor tickets, ws-token rate limiter) are process-local Maps that must prune expired entries or they grow forever.
- **Outbound HTTP goes through `outbound.ts`, not a bare `fetch`.** `fetchLogged` (or `beginOutbound` where the transport isn't `fetch`, as in `remoteUpload.ts`) is what puts a request leaving this process in the same log buffer as inbound traffic. Healthy calls log at DEBUG so the 1s firehose poll and the 5s torrent poll don't flood the console, but the ring buffer keeps DEBUG regardless — so the admin log view sees them all. It also redacts the URL, which matters because unrestrict links, cluster blob URLs, `?ek=` and `?k=` all carry credentials and the buffer is admin-readable.
- **`safeJoin()` every path built from user or DB input** before touching the filesystem.
- **Never read a row's own `enc_key_blob`/`enc_access_blob`/`encryption_mode` on a read path** — an inheriting row's are NULL and its mode is only a mirror. Go through `crypto/effectiveEncryption.ts`. A missed path fails loudly ("encryption key not stored") rather than silently using a stale key, which is the point.
- **Only a caller that actually holds a folder's end-to-end key may upload into it.** `finalizeStoredFile` refuses a `client`/`sealed` destination unless the caller passes `clientCiphertext: true`, which only the two browser/API upload routes do. `encryptionMode: "client"` is *not* that claim — every server-side path copies its directory's mode into that field, so trusting it would let a dropbox link file an anonymous uploader's plaintext under a mode that promises ciphertext.
- **A play key, an `?ek=` and a `#ek=` are three different things.** `server` secrets travel as a query parameter and the server compares them; `client`/`sealed` keys travel in the fragment and must never reach the server.
- **An `ensureColumn` definition carries only the constraints it spells out.** A column added with `REFERENCES directories(id)` on an upgraded database has no `ON DELETE` action even if `schema.sql` says `ON DELETE SET NULL` — write the full clause in both places or deleting a referenced row throws.
- **Deleting a directory must clear every table that FKs to it** without a cascade: `files`, `directory_links`, `directory_collaborators`, `dropbox_upload_links`. `media_play_keys` cascades and `torrent_jobs` sets null, both by declaration.
- **A recursive walk over the folder tree needs a depth bound.** `MAX_DEPTH` is enforced on create and move, but corrupt or partially replicated data could still form a cycle; every walker in `directoryTree.ts` bails rather than spinning.
- **A promotion to break point must carry `access_is_password`, not just the key.** Moving an inheriting folder materializes the key it was resolving to; dropping the password flag silently turns a throttled human password into an unthrottled one.
- **The access-guess counter is keyed on the key scope, never on a link slug.** `/d/:slug/info` publishes every member file's slug, so a per-slug counter hands out one fresh guess budget per member against the same folder password.
- **Sealing takes the delete gate, not the edit gate.** `POST /files/:id/seal` is irreversible and leaves the file unreadable even to its owner, so it requires `can_delete` *and* ownership — an editor of the containing folder may move and rename, nothing more.
- **A folder created inside someone else's tree belongs to that tree's owner.** Otherwise an editor owns it, and `POST /directories/:id/collaborators` (owner-only by design) becomes re-delegatable.
- **Replicating a file must ship its whole ancestor chain**, root first. `parent_directory_id` is a real FK on a peer running `foreign_keys = ON`, and the containing folder's parent may never have been replicated.
- **Don't ancestor-walk per row in a listing.** `ancestorChain` costs a query per level; `buildPathIndex` reads the table once and resolves any number of rows in memory. The admin panel renders every file in the system.

---

## What NOT to do

- Don't run migrations — add nullable columns (or columns with a SQLite `DEFAULT`) plus an `ensureColumn` backfill
- Don't write an `async` Express handler without `asyncHandler`
- Don't scale this server to multiple processes without redesigning `cluster/eventBus.ts` sequencing
- Don't write a route handler that "also replicates" — the trigger already did it, and a second copy is a bug
- Don't add a second state-transfer mechanism alongside `seedChangeLog` — Phase 3 deleted `/cluster/export` specifically so there is exactly one, and two that can disagree is the failure mode it was deleted to prevent
- Don't reintroduce an election, an epoch, or a `candidate` role — leadership is computed from a snapshot, and the only thing that travels between nodes is the generation
- Don't write a peer's claimed `role` into `cluster_nodes` — derive it from the tiering generation
- Don't recompute the replication topology in the client — `upstreamOf()` is the whole rule, and a second copy of it can disagree with the pulls the cluster is actually doing. `cluster/topology.ts` ships the graph; the client only lays it out
- Don't count a brand-new node against the drift hold-down — until it is in a snapshot it has no upstream and replicates with nobody
- Don't add a write path that creates a `files` row without a quota reservation — go through `finalizeStoredFile`, or reserve explicitly like save/copy do
- Don't check quota by reading `SUM(files.size_bytes)` locally — that's the read two nodes can both pass, and it is the bug reservations exist to close
- Don't move the free-disk check to the master — the master's spare space says nothing about the node holding the bytes
- Don't gate `/api/cluster` behind the degraded-mode middleware — promotion is the only way out of degraded mode
- Don't make promotion automatic — that's the split brain the design deliberately refuses to risk
- Don't arbitrate a conflict anywhere but the master — a verdict reached in two places is a verdict that can disagree with itself
- Don't append a losing entry to the master's log — it would ship down and overwrite the winner on every follower; record it in `replication_conflicts` and restate the winner instead
- Don't re-apply an entry the master has already judged — an accepted one would clobber a later edit that has since won the row, and a rejected one would overwrite the winner with the loser
- Don't implement "re-apply" as a replay of the losing entry — write it as a fresh local edit, or it re-enters the arbitration it already lost
- Don't add `password_hash` (or any credential material) to `TABLE_COLUMNS` — it is fetched on demand precisely so it lives only where it is used
- Don't have a relaying node cache the material it forwards — the bound "nodes the user has actually logged in on" is the point
- Don't write fetched credential material without raising `replication_control.suppressed` — it is a peer's write, and logging it can lose a real concurrent edit to arbitration
- Don't invent a second invalidation channel for credentials — the replicated `credential_version` counter already is one, and it works for a node that was offline
- Don't leave a revocation to the pull — a stale grant is a security hole and a stale denial is only an inconvenience, which is the whole reason the two are treated differently
- Don't evict a `pinned` chunk — those are the durability copies the replication factor placed, and evicting them to make room for cache deletes the second copy the cluster just went to the trouble of making
- Don't record an eviction that freed no bytes — the cache would believe it is under a cap the disk says it is over, and evict its way down to nothing
- Don't mint a chunk manifest anywhere but the node that created the blob (and the master, for legacy blobs) — two manifests for one blob is two sets of rows on every peer
- Don't walk the peer list to find a blob any more — `chunk_locations` says who holds it; the whole-blob walk survives only for a blob with no manifest at all
- Don't poll qBittorrent once per job — one list fetch per tick, grouped by tag, covering downloading *and* seeding jobs
- Don't refuse a torrent for being over the concurrency limit — park it in `pending` and let `promotePendingJobs` start it
- Don't count `pending` toward `IN_FLIGHT_STATUSES` — that is the status a job sits in *because* it has no slot, so counting it deadlocks the queue
- Don't truncate a stored magnet — the queue and the qBittorrent fallback both re-dispatch from `torrent_jobs.source`
- Don't `cleanupJobDir` a seeding job — those bytes are what qBittorrent is uploading
- Don't gate Real-Debrid on `instantAvailability` — uncached torrents are supposed to go through it too
- Don't `await` a Real-Debrid transfer inside the `torrent_poll` tick — it runs detached (`startDebridFetch`)
- Don't write API reference content into `ApiDocsPage.tsx` — it renders `docs/api.md`; edit the markdown
- Don't put `CopyButton` (or any Radix-backed control) inside the `Markdown` renderer — `docs/api.md` has 100+ code blocks, and that many tooltip roots is what made the page jank
- Don't soft-delete API keys — hard delete them so they leave the admin panel immediately
- Don't wrap `DropdownMenuTrigger`'s `asChild` button in a `Tooltip` — it breaks click events
- Don't use `bg-brand-gradient/90` — opacity modifiers don't apply to CSS variable gradients
- Don't use `text-primary-foreground` on brand gradient backgrounds — use `text-white`
- Don't offer `client` as a directory-level encryption choice for a *nested* folder — a child always inherits, and the backend rejects it
- Don't add a "convert this file to end-to-end" backend endpoint — going into or out of `client`/`sealed` is browser-side by construction
- Don't run `bunx biome` and assume you got the formatter: that resolves to an unrelated package. It is `bunx --bun @biomejs/biome`

---

## File-specific notes

- `crypto/effectiveEncryption.ts` — `sourceDirectoryId` is only set when the resolver actually *walked*; `ownerDirectoryId` is the one to compare when you need "which node holds this key", including when a file inherits straight from its own folder.
- `routes/public.ts` — public file info returns `uploader: {username, has_avatar, user_id} | null` (null when the link sets `hide_uploader`) and `already_saved: bool`. `/preview` and `/thumbnail` both refuse limited-use links so link budget can't be spent by a preview fetch.
- `routes/files.ts` — `serializeFiles()` batch-loads owner usernames *and* links to avoid N+1; `recoverAccessKey()` reconstructs the server-mode `?ek=` for the owner. Chunked uploads seal their session metadata into an AEAD token (no server-side session table); `uploadLocks` serializes finalize against abort.
- `routes/remoteUpload.ts` — resolves DNS, rejects private/local addresses, and connects to the *pinned* validated IP to close the rebinding window; re-validates every redirect hop; caps bytes mid-stream and decodes chunked transfer-encoding.
- `storage/zip.ts` — `safeArcname()` flattens paths and de-duplicates collisions; `memberSource()` resolves a row to plaintext bytes and is the file that has to know the transform-order rule.
- `torrents/debrid.ts` — `planFiles()` pairs `info.links[]` with the *selected* entries of `info.files[]` positionally; when the counts disagree (Real-Debrid splits very large torrents into RAR volumes, which are links with no matching file entry) it gives up on the mapping and names each download from its own unrestrict response instead. The transfer's only timeout is a **stall** timer — a legitimate multi-GB pull runs for hours, so idleness is what gets policed, not duration.
- `torrents/poller.ts` — `pollDebrid` uses the row's own `updated_at` as its last-polled clock rather than a side map, so there is no in-memory registry to prune. `startDebridFetch` guards against overlapping transfers with a module-level `Set` of job ids. `promotePendingJobs` reads every owner's slot usage in **one** grouped query, not a `COUNT` per candidate, and increments its in-memory tally *before* awaiting dispatch — the same owner's next pending job is decided in that same loop. `seedLimitReached` compares against a strictly positive limit because qBittorrent reports `ratio` as `-1` before anything has been uploaded.
- `security/sessions.ts` — the cookie carries only a signed opaque sid; `resolve()` refreshes `last_seen_at` at most once a minute.
- `cluster/changelog.ts` — the append is a **SQLite trigger**, not a wrapper around `db.run()`. Detecting writes by parsing SQL at the adapter would be guesswork; a trigger sees the committed row. That also moved uid minting into the trigger, so "minted where the row is created" is literally true. `replication_control` carries the node identity and the suppression flag *as table columns* because a trigger cannot reach application state — only other tables.
- `cluster/replication.ts` — `PULL_LIMIT = 500` per request, `MAX_BATCHES_PER_TICK = 20` (a node far behind can't hold the 1s job forever — it resumes next tick), `PULL_TIMEOUT_MS = 20_000`. A pull that fills a batch immediately issues another rather than waiting for the next tick.
- `cluster/tiering.ts` — `computePlan`, `inferRegions` and `upstreamOf` are pure and exported, which is why most of `clusterTiering.test.ts` needs no cluster at all. `computePlan` takes an `incumbent` used only when nothing is eligible: an all-ineligible snapshot must keep the current master, because *vacating* leadership is precisely what no node is allowed to decide. `KEEP_GENERATIONS = 20` trims history. `measureDrift(…, {persist: false})` measures without touching the hold-down clock, for read-only surfaces like `GET /cluster/self`.
- `cluster/membership.ts` — `heartbeatJob` times its own round-trip and writes the median of the last `RTT_SAMPLES = 5` into `cluster_nodes.rtt_ms`; the sample map is pruned against the live target list every run. Region inference is free precisely because that round-trip was already happening.
- `db/index.ts` — the only place a `DATABASE_URL` scheme is interpreted. `sqlite:///rel`, `sqlite:////abs` and `:memory:` are the three forms; anything else throws. A future Postgres adapter implements `Db` and gets another case here rather than touching callers.
- `client/src/components/layout/UserMenu.tsx` — the collapsed sidebar trigger is a plain `Button`; wrapping it in a `Tooltip` breaks Radix DropdownMenu clicks.
- `client/src/features/files/components/Dropzone.tsx` — uses `bg-brand-gradient` and `text-white` for the reasons in "What NOT to do".
