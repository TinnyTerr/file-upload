# Cluster redesign — analysis and proposal

**Status:** proposal, no code written.
**Scope:** `server/src/cluster/*` (3,352 lines incl. `routes/cluster.ts` and `ws.ts`), the
`cluster_*` tables in `db/schema.sql`, and the replication call sites in `routes/files.ts`.

---

## Part 1 — What exists today

Eight modules, layered roughly like this:

```
election.ts (536)      elected epoch-versioned leadership, vote-request / master-assumed
    ↑ used by
membership.ts (463)    join / enroll / heartbeat, full-mesh peer topology
replication.ts (553)   announce-id row replication + rebase-from-master fallback
digest.ts (114)        state digest, drift detection, split-brain cross-check
blobs.ts (74)          content-addressed fetch-on-miss from peers
cacheEviction.ts (147) LRU for REPLICATION_MODE=cache nodes
halt.ts (115)          TTL'd upload halt registry, gossiped over the firehose
eventBus/eventStore/firehoseClient (391)   live bus, durable mirror, peer polling
routes/cluster.ts (625) both the session-auth admin surface and the node-to-node surface
```

Three background jobs (`jobs/scheduler.ts`): `cluster_heartbeat`, `cluster_sync_check`,
`cluster_election_liveness`, `cluster_cache_eviction`. One firehose consumer per peer
(`firehoseClient.ts`), one event-writer drain loop (`eventStore.ts`).

**There are zero tests.** `server/tests/` contains `clientCountry`, `directoriesBrowse`,
`oauth`, `outbound` — nothing cluster. The Python original had
`test_cluster_{events,membership,halt,digest,blobs,replication}.py`; the port dropped all
of them. Every defect below is therefore invisible to CI.

---

## Part 2 — Defect inventory

### 2.1 Confirmed bugs

**B1 — `EventBus.seq` resets to 0 on every restart.**
`appState.ts:33` constructs `new EventBus(settings)` with `private seq = 0`
(`eventBus.ts:38`) and nothing ever seeds it. The Python version explicitly seeded
`event_bus.seed_seq(MAX(origin_seq) for this node)` at startup precisely to prevent this;
the port lost it. Consequences, all silent:

- `cluster_events` has `UNIQUE(origin_node_id, origin_seq)` and `eventStore.ts:91` inserts
  with `INSERT OR IGNORE`. After a restart, every event re-uses `origin_seq` 1, 2, 3… and
  is **silently discarded** until the counter climbs past the pre-restart maximum.
- Peers' firehose cursors (`firehoseClient.ts:130`) are already past the restarted node's
  new low sequence numbers, so peers receive **nothing** from it for the same window.
- `lastAppliedVector()` (`election.ts:243`) folds `eventBus.currentSeq()` into the vector
  used for vote-grant safety. A just-restarted node reports a self-watermark of ~0, so
  `vectorAtLeast` (`election.ts:253`) marks it "behind" and it can never win an election —
  including when it is the only node left alive.

This is the exact failure mode CLAUDE.md's single-process invariant warns about,
reintroduced by a different mechanism. It fires on every ordinary restart, not just under
multi-worker scaling.

**B2 — `EventBus.recent()` drops the oldest events under load.**
`eventBus.ts:104`:

```ts
return matches.slice(Math.max(0, matches.length - limit));
```

That returns the *newest* `limit` matches. The firehose consumer polls
`?after=<cursor>&limit=500` and then sets `cursor = data.last_id` — the highest id
returned. If more than 500 events accumulate between polls (1s interval, so this needs a
burst or a brief peer outage), the oldest are skipped and the cursor jumps past them.
They are never re-requested. Should be `matches.slice(0, limit)`.

**B3 — Peer polling reads the in-memory ring buffer, not the durable table.**
`routes/cluster.ts:619` serves `/admin/cluster/events` from `state.eventBus.recent(...)`,
a 5,000-entry in-process array (`BUFFER_CAPACITY`, `eventBus.ts:35`). A restart empties it.
Combined with B1, a node restart is an **unrecoverable permanent gap** in every peer's
cluster-wide event view: the events are gone from the buffer, and the replacements collide
on `origin_seq` and get dropped. The durable `cluster_events` table exists and is never
read to answer a peer.

**B4 — `rebaseFromMaster` cannot converge; it only ever adds.**
`replication.ts:387` fetches the master's full export and calls `applyRows`, which is
`INSERT … ON CONFLICT(id) DO UPDATE` (`replication.ts:262`). There is no `DELETE`. A row
deleted on the master is never deleted on a follower — it stays, stays listable, stays
downloadable, and stays counted against quota. "Rebase from the source of truth" is
actually "merge the master's rows in on top of ours." Divergence is monotonically
increasing and the designated repair mechanism cannot reduce it.

**B5 — Only file *creation* replicates.**
`replicateFile` has exactly two call sites: `files.ts:551` (inside `finalizeStoredFile`,
so all upload paths — browser, API, dropbox, remote-upload, torrent import — are covered)
and `files.ts:1691` (file copy). Nothing else in the codebase replicates anything. Not
replicated, ever:

| Mutation | Where | Peer sees |
|---|---|---|
| File delete | `files.ts`, admin bulk actions | file still there, still downloadable |
| File rename / move | `files.ts` | old name, old folder |
| Folder create / rename / move / delete | `directories.ts` | nothing, or a stale tree |
| Collaborator grants | `directories.ts` | no access |
| Permission / quota change | `users.ts`, admin panel | stale flags until that user's next upload |
| Password change, MFA enrol | `account.ts`, `mfa.ts` | stale `password_hash` |
| Link create / revoke / expire / `use_count` | `links.ts`, `files.ts` | revoked link still works |
| Encryption change / rekey | `files.ts`, `directories.ts` | stale key blobs → undecryptable |
| Archive / unarchive / expiry sweeps | `jobs/lifecycle.ts` | stale `archived`, wrong transform order |
| Media publish, `is_library` | `media.ts` | not in the peer's `/watch` |

A revoked share link continuing to serve downloads from a peer is a security bug, not just
a consistency bug.

**B6 — A stale node's epoch can livelock the whole cluster, permanently.**
`upsertPeer` (`membership.ts:456`) calls `adoptEpochIfHigher` on the `epoch` field of any
inbound `/join` or `/heartbeat` body. Epochs are monotonic and `runElection` increments by
exactly 1 (`election.ts:430`). One node that ever reports a wildly high epoch — a bug, a
corrupted `cluster_self_state`, a replayed old body, a test fixture — pushes every node to
that epoch. `handleVoteRequest` only grants when `candidateEpoch > self.epoch`
(`election.ts:306`), so the cluster now needs that many sequential elections before any
vote can ever be granted again. There is no epoch reset, no bound, no sanity check.

**B7 — Quorum is computed over a set nodes do not agree on.**
`knownClusterPeers` (`election.ts:271`) reads *this node's* `cluster_nodes` table.
Membership is maintained by best-effort mesh registration (`membership.ts:230`, wrapped in
a try/catch that only logs at DEBUG) and unlink is a bare local `DELETE`
(`routes/cluster.ts:293`) that is never propagated. Different nodes routinely hold
different membership sets. A majority computed over a non-agreed set is not a quorum, and
the comment at `election.ts:263` claiming this prevents two minority views from both
believing they have a majority is the opposite of what the code achieves.

**B8 — `candidate` is a terminal state.**
`runElection` persists `role = "candidate"` (`election.ts:431`) before any network I/O.
`checkMasterLivenessJob` returns early for `role === "candidate"` (`election.ts:509`).
Any unexpected throw between those two points — and the whole function is unguarded —
leaves the node a candidate forever, never calling another election, never adopting a
master.

**B9 — The sync check is a false-positive generator that checks nothing useful.**
`computeDigest` (`digest.ts:26`) hashes exactly two things: the global storage quota and
`SELECT node_id FROM cluster_nodes WHERE active = 1` ∪ self. `active` is a cache of "did
the last heartbeat round-trip succeed" — a per-node liveness observation that legitimately
differs across nodes at any instant. So the digest reliably mismatches whenever any node
is briefly slow, emitting `cluster.sync_mismatch` warnings. Meanwhile it hashes **no
actual replicated data**, so it cannot detect the divergence in B4/B5 that it exists to
catch.

**B10 — Cache-mode nodes can never evict, because bytes are never pushed.**
`cacheEvictionJob` (`cacheEviction.ts:117`) will only delete a blob once a
`replication_mode='full'` peer confirms via HEAD that it holds those exact bytes. But
nothing in the codebase ever *pushes* blob bytes to a peer. `replication.ts` ships
`content_blobs` rows (metadata) only; bytes reach a peer solely via
`fetchBlobFromPeers` — a *pull*, triggered by a read on that peer. So a blob uploaded to a
cache node and never downloaded from elsewhere is never durable elsewhere, therefore never
evictable. A cache node used primarily as an upload target fills its disk and the eviction
pass skips every candidate. `REPLICATION_MODE=cache` does not work as documented.

### 2.2 Design faults

**D1 — The identity scheme is node-local; the protocol is bolted on to paper over it.**
Every replicated table uses SQLite `INTEGER PRIMARY KEY AUTOINCREMENT`. Two nodes
accepting concurrent uploads both mint `files.id = 42`. The "announce-id" protocol detects
this (`/reserve`, `replication.ts:476`) and responds by rebasing from master and returning
`"conflict"` — the file exists locally, is **never replicated**, and every subsequent
attempt conflicts identically. There is no id remapping and no renumbering. This is the
root cause the other replication machinery is built to work around, and it cannot be fixed
without changing the identity scheme.

**D2 — "Last-writer-wins by timestamp" is documented but not implemented.**
`applyRow` (`replication.ts:262`) unconditionally overwrites every non-`id` column with
the incoming values. There is no `updated_at` comparison, no revision counter, no vector
clock. The winner is whoever's HTTP request arrives last. Two nodes editing the same file
concurrently produce an arbitrary result, and a slow peer replaying a stale push
resurrects old state.

**D3 — Leadership exists but buys nothing.**
The master is used for exactly one thing: as the source for `rebaseFromMaster`. Writes are
not routed through it, it does not order anything, and it does not arbitrate conflicts
(see D2). ~650 lines across `election.ts` and the epoch-fencing threaded through
`membership.ts`, `replication.ts`, `digest.ts` and `routes/cluster.ts` exist to elect a
node whose only job is to answer `GET /export` — which any node could answer equally
(in)correctly.

**D4 — Replication is push-only, unordered, and fire-and-forget.**
`void replicateFile(state, id).catch(...)` (`files.ts:551`). If the peer is down, the rows
are lost — there is no queue, no retry, no cursor. The comment says "it will catch up via
heartbeat-triggered sync"; no such sync exists. `heartbeatJob` only updates capacity stats.
The only catch-up path is `rebaseFromMaster`, which fires on join and on conflict, and
which cannot delete (B4).

**D5 — Three competing answers to "who is master", two to "is this node up".**
`settings.nodeRole` (env), `cluster_nodes.is_master` (per-peer cached column),
`cluster_self_state.role` (authoritative). Code reads all three in different places;
`membership.ts:86` and `:401` even derive `role` from `isMaster` and `isMaster` from
`role` in adjacent functions. Similarly `cluster_nodes.active` and
`cluster_nodes.last_heartbeat_at` both encode liveness with different staleness semantics.

**D6 — No blob location registry.**
`fetchBlobFromPeers` (`blobs.ts:37`) walks every active peer sequentially with a 30s
timeout each. For a genuinely missing blob in an N-node cluster, a user's download request
blocks for up to 30N seconds before returning 404. `confirmedElsewhere`
(`cacheEviction.ts:72`) does the same walk per blob — an eviction pass over 10k blobs is
up to 10k×N sequential HTTP round-trips. Neither can answer "how many replicas does this
blob have", so durability is unprovable.

### 2.3 Security

**S1 — One shared static token grants total control.**
`CLUSTER_TOKEN` is a single value shared by every node (`requireClusterToken`,
`routes/cluster.ts:100`). Holding it grants:
- `GET /api/cluster/export` — **every** `users` row including `password_hash`,
  `webauthn_user_handle` and `avatar_data`, plus every `enc_key_blob` / `enc_access_blob`
  in the system. A full credential and key dump behind one bearer token.
- `POST /api/cluster/replicate` — arbitrary upsert into `users`, `permissions`,
  `files`, `links`. Insert yourself with `role = 'master'` and full permissions.
- `POST /api/cluster/join` — the response body includes `peers[].token`
  (`routes/cluster.ts:361`), handing over every peer's credential.

**S2 — Peer tokens are stored in plaintext and fan out.**
`cluster_nodes.token` (`schema.sql:377`) is plaintext, and `enrollWithMaster` writes every
peer's token into it (`membership.ts:219`). Compromising the SQLite file on any single
node yields credentials for every node.

**S3 — Token rotation breaks the cluster.**
`POST /api/cluster/token/rotate` (`routes/cluster.ts:176`) sets `state.clusterToken` and
writes `app.env`. Peers are never told. Every peer's stored token for this node is now
wrong, so all inbound node-to-node calls 401 immediately, and there is no re-enrolment
trigger.

**S4 — Epoch and role are unauthenticated request-body fields** (see B6). Anything holding
the token can demote the master or poison the epoch.

### 2.4 Operability

- **Zero tests**, so none of the above is caught.
- Circular imports worked around with a dynamic `import()` inside a function
  (`membership.ts:252`).
- Node-to-node endpoints and session-authenticated admin endpoints share one router
  (`routes/cluster.ts`), so the two auth models sit interleaved in one 625-line file.
- Comments describe intent that the code does not implement (the quorum comment at
  `election.ts:263`, the "heartbeat-triggered sync" at `replication.ts:493`, the LWW rule
  in the memory notes). Reading the comments actively misleads.
- Every module carries a `Mirrors app/cluster/x.py` header pointing at a deleted file.

---

## Part 3 — Root causes

Strip away the individual bugs and there are three:

1. **Node-local integer primary keys.** Everything in `replication.ts` — the announce
   protocol, the identity hash, the reserve round-trip, the conflict path, the rebase
   sledgehammer — is scaffolding around the fact that two nodes can mint the same id.
   Fix the identity scheme and most of that scaffolding stops being necessary.

2. **Replication is an explicit call someone has to remember to make**, rather than a
   consequence of writing to the database. That is why exactly two of ~40 mutation sites
   replicate (B5), and why every new feature since — media library, OAuth, collaborators,
   torrents — silently isn't clustered.

3. **There is no durable, ordered change log.** Without one there is no resumable
   catch-up, no delete propagation, no conflict ordering, and no way to answer "am I in
   sync". The three mechanisms that try to substitute for it (fire-and-forget push, full
   export rebase, membership digest) each fail at it in a different way (D4, B4, B9).

The leader election is a fourth thing, but it isn't a root cause — it's a symptom.
It was added to arbitrate conflicts that a proper identity scheme wouldn't produce.

---

## Part 4 — Requirements this proposal assumes

Stated explicitly so they can be corrected before anything is built:

1. **Scale:** a handful of nodes (2–10), operator-run, not hostile to each other.
   Not a hundred-node system, not multi-tenant.
2. **Consistency:** eventual consistency is acceptable for metadata. A file uploaded on
   node A appearing on node B a few seconds later is fine. **Deletes and revocations
   converging is not optional** — a revoked link must stop working everywhere.
3. **Availability:** a node must remain fully usable for its own users while partitioned.
   This rules out routing all writes through a leader.
4. **Durability:** the cluster should be able to state a replication factor per blob and
   prove it before deleting anything.
5. **Node loss:** losing one node must not lose data that existed on it, given a
   configured replication factor ≥ 2.

If (3) is actually negotiable — if you'd accept "the cluster is read-only when the leader
is unreachable" — Option C in Part 6 becomes dramatically simpler than anything else here.

---

## Part 5 — Proposed architecture

### 5.1 Globally unique row identity

Add a `uid TEXT` column to every replicated table, unique, populated with a ULID
(lexicographically sortable, embeds creation time, 26 chars). Local `INTEGER PRIMARY KEY`
stays for local joins and FKs — nothing in the existing query surface changes.
**`uid` becomes the replication identity**; `id` is never sent over the wire.

Foreign keys crossing nodes are carried as the parent's `uid` and resolved to the local
`id` on apply. Rows arriving whose parent `uid` is unknown are parked in a pending buffer
and retried when the parent lands, which also removes the need for `collectFileRows`'s
ancestor-chain shipping (`replication.ts:302`).

Backfill fits the project's no-migrations rule: `ensureColumn` adds the column, a one-shot
boot pass fills `uid` for existing rows.

**This deletes:** `/reserve`, `identityHash`, `localIdentity`, the conflict path, and the
entire reason `rebaseFromMaster` exists.

### 5.2 A durable, ordered change log

New table, node-local, append-only:

```
replication_log(
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,   -- this node's monotonic stream
  table_name  TEXT,
  row_uid     TEXT,
  op          TEXT,        -- 'upsert' | 'delete'
  payload     TEXT,        -- JSON row (null for delete)
  rev         INTEGER,     -- see 5.3
  origin_node TEXT,
  ts          TEXT
)
```

Every mutation to a replicated table appends here **inside the same transaction as the
write**. Enforced at the DB adapter layer (`db/sqlite.ts`), not left to call sites — that
is the fix for root cause (2). A write that isn't logged should be impossible rather than
merely discouraged.

Peers pull: `GET /api/cluster/changes?after=<seq>&limit=N`, apply idempotently by `uid`,
and persist a per-source cursor in a `replication_cursors(source_node_id, seq)` table.
Restart-safe, outage-safe, backpressure-free.

**This gives us, for free:** delete propagation, rename/move propagation, permission and
password changes, link revocation, lifecycle transitions, media publishes — every entry in
B5's table, without touching a single route handler. It also gives a real answer to "am I
in sync": compare cursors against each peer's head sequence.

**This deletes:** `replicateFile`, `collectFileRows`, `exportAll`, `applyRows`,
`rebaseFromMaster`, `/replicate`, `/export`, and the `void …catch()` call sites.

### 5.3 Conflict resolution: per-row LWW with an actual revision

Add `rev INTEGER` and `rev_node TEXT` to replicated tables. Every local write bumps
`rev = max(local_rev, seen_rev) + 1` and stamps `rev_node`. Apply rule:

```
accept incoming iff (incoming.rev, incoming.rev_node) > (local.rev, local.rev_node)
```

Deterministic, commutative, order-independent, needs no leader, and converges regardless
of delivery order. `rev_node` breaks ties by lexical node id so all nodes pick the same
winner.

Deletes are **tombstones** — a `delete` log entry with a `rev`, and the row's `uid`
retained in a `tombstones(uid, table_name, rev, ts)` table so a late-arriving stale upsert
can't resurrect it. Tombstones are pruned only after every known peer's cursor has passed
the entry (the same reasoning as `pruneOauth` only deleting rows past `expires_at`).

**This replaces:** the undocumented "whoever pushes last wins" behaviour (D2), and removes
the need for a master to break ties (D3).

### 5.4 Delete the election

With globally-unique ids (5.1), a per-node ordered log (5.2), and deterministic LWW (5.3),
there is nothing left that requires a single writer. Proposal: **remove `election.ts`
entirely**, along with epoch fencing in `membership.ts`, `replication.ts`,
`routes/cluster.ts`, the `cluster_self_state` table, `/vote-request`, `/master-assumed`,
the `cluster_election_liveness` job, and the split-brain cross-check in `digest.ts`.

That is ~700 lines and B6, B7, B8, D3, D5 and S4 removed together.

`MASTER_URL` / `MASTER_TOKEN` survive purely as **bootstrap seed coordinates** — "here is
a node that can introduce you to the cluster" — with no ongoing authority. `NODE_ROLE`
goes away.

The one thing genuinely needing coordination is cluster-wide admin actions (global quota,
bulk deletes). Those are rare, operator-initiated, and can be handled by making them
ordinary replicated rows subject to the same LWW rule rather than by standing up a
consensus protocol.

### 5.5 Blob placement becomes explicit

New replicated table:

```
blob_locations(blob_uid, node_id, state, size_bytes, updated_at)
   state ∈ 'present' | 'wanted' | 'evicted'
```

Because it replicates through the same log, every node knows where every blob is.

- **Read failover** (`blobs.ts`) queries the table instead of walking all peers with a 30s
  timeout each. Fixes D6's worst case.
- **Push replication:** a `blob_replication` job on each node compares
  `count(state='present')` against a configured `REPLICATION_FACTOR` and pushes bytes to
  under-replicated targets, choosing by free disk. **This is the missing capability that
  makes `REPLICATION_MODE=cache` real** — bytes now reach `full` nodes without waiting for
  someone to download them (fixes B10).
- **Eviction** becomes a table lookup plus one confirming HEAD, not an N-peer walk.
- **Node loss** becomes recoverable: rows with `state='present'` on a dead node are
  re-queued for replication elsewhere.
- Archive-only-on-`ARCHIVE_ENABLED`-nodes stays expressible as a placement policy.

### 5.6 Fix the event pipeline

Three changes, small and independent of everything above:

1. Seed `EventBus.seq` from `SELECT MAX(origin_seq) FROM cluster_events WHERE
   origin_node_id = <self>` at startup (fixes B1). Restore the Python `seed_seq` behaviour.
2. Serve `/admin/cluster/events` from the `cluster_events` **table**, ordered ascending by
   `origin_seq`, not from the ring buffer (fixes B2 and B3 together — the table has no
   capacity limit and ascending order is natural). The ring buffer stays for the live
   websocket only.
3. Persist locally-originated events synchronously in the publishing transaction rather
   than via the 250ms drain (`eventStore.ts:63`), so an event can never be published,
   observed by a peer, and then lost on crash.

These are worth doing **first and separately** — they are pure bug fixes, they don't
depend on the redesign, and they're what makes the system observable enough to debug the
rest.

### 5.7 Security

- **Per-node credentials.** Replace the single `CLUSTER_TOKEN` with an enrolment token
  (short-lived, operator-generated, one use) that mints a **per-node-pair** credential.
  Store peer credentials hashed where they're verified, and never return another node's
  token in any response body (fixes S1, S2).
- **Rotation propagates**: a node rotating its credential announces the new one to peers
  over the log before the old one stops being accepted, with an overlap window (fixes S3).
- **`/export` is deleted** (5.2 replaces it), removing the credential-dump endpoint.
  The change-log endpoint is cursor-scoped and carries the same data, but incrementally
  and only to enrolled peers — worth deciding whether `password_hash` and `enc_key_blob`
  should replicate at all, or whether identity should stay node-local like sessions,
  OAuth and play keys already do. **See open question Q3.**
- Node-to-node routes move to their own router file with their own auth, separate from the
  session-authenticated admin surface.

### 5.8 Resulting module shape

```
cluster/
  identity.ts      ULID minting, uid↔id resolution, pending-parent buffer
  changelog.ts     append (in-transaction), read by cursor, apply with LWW + tombstones
  sync.ts          per-peer pull loop, cursor persistence, backpressure
  membership.ts    enrol / heartbeat / peer table  (no election, no epochs)
  placement.ts     blob_locations, replication factor, push targets, eviction policy
  blobs.ts         fetch/serve bytes  (registry-driven, unchanged interface)
  halt.ts          unchanged
  events.ts        eventBus + durable store, merged and fixed (5.6)
routes/
  cluster.ts       session-authenticated admin surface only
  clusterNode.ts   node-to-node surface, separate auth
```

Roughly 3,352 → an estimated ~1,800 lines, with election, the announce protocol, the
rebase path and the digest check all gone.

---

## Part 6 — Alternatives considered

**Option A — the above: log-shipping, leaderless, LWW.** *(recommended)*
Fits the project's constraints: no ORM, no migrations, SQLite per node, nodes independently
usable when partitioned. Trade-off: eventual consistency with LWW means a concurrent edit
to the same row on two nodes silently loses one side. For this workload (files are
uploaded once, rarely edited concurrently by two users on two nodes) that is an acceptable
and honest trade. Largest cost is the `uid` backfill touching every replicated table.

**Option B — real consensus (Raft) over a replicated log.**
Correct in the strong sense, and would make cluster-wide operations trivially safe.
Rejected: implementing Raft properly (log compaction, snapshot transfer, membership
changes, the corner cases that make Raft papers long) is a large multi-week effort, it
requires routing all writes through a leader — violating requirement (3) — and at 2–10
operator-run nodes it is not proportionate. The existing `election.ts` is what a
half-implemented Raft looks like, and that's the thing being replaced.

**Option C — externalize the metadata store.**
Point every node at one shared Postgres; keep only blobs distributed (5.5). This deletes
the entire replication problem — no log, no uid, no LWW, no tombstones, no conflicts.
Nodes become stateless-ish frontends over shared metadata plus local blob caches.
Trade-off: it's a hard operational dependency the project deliberately avoided
(`bun:sqlite`, no migrations, `data/app.db`), it makes a partitioned node read-only or
dead, and it introduces a single point of failure unless you also run Postgres HA.
**Genuinely the simplest correct answer if requirement (3) is negotiable** — worth an
explicit decision rather than dismissal.

**Option D — patch what's there.**
Fix B1–B3 and B6–B8, add delete propagation, add an updated_at comparison. Rejected as a
target state: D1 (colliding integer ids) can't be patched without the `uid` change, and
without D1 the announce/rebase machinery has to stay. You'd spend most of the effort and
keep most of the complexity. The event-pipeline fixes (5.6) *are* worth taking as patches
immediately, which is why they're staged first.

---

## Part 7 — Suggested phasing

Each phase is independently shippable and leaves the system no worse than before.

| Phase | Work | Removes |
|---|---|---|
| **0** | Cluster test harness — multi-node in-memory, extending `tests/harness.ts` | the reason all this shipped green |
| **1** | Event pipeline fixes (5.6) — seed seq, serve from table, ascending slice | B1, B2, B3 |
| **2** | `uid` column + backfill on replicated tables; uid-based apply alongside the existing path | D1 |
| **3** | `replication_log` + in-transaction append at the adapter layer; peer pull loop + cursors. Delete `replicateFile`, `/reserve`, `/replicate`, `/export`, `rebaseFromMaster` | B4, B5, D4, S1 |
| **4** | `rev`/`rev_node` LWW + tombstones | D2 |
| **5** | Delete `election.ts`, epochs, `cluster_self_state`, digest split-brain check | B6, B7, B8, B9, D3, D5, S4 |
| **6** | `blob_locations` + push replication + registry-driven failover and eviction | B10, D6 |
| **7** | Per-node credentials, rotation-with-overlap, router split | S2, S3 |

Phases 1 and 2 are safe to land against the current design. Phase 3 is the one-way door.

---

## Part 8 — Open questions

**Q1 — Is requirement (3) real?** Must a partitioned node keep accepting writes? If not,
Option C (shared Postgres) is far less work than Option A and eliminates this whole
subsystem. This single answer changes everything downstream.

**Q2 — What is the actual deployment?** Number of nodes, same datacenter or geographically
spread, and what a node is expected to survive. The doc assumes 2–10 operator-run nodes.
Geo-distribution would change the sync interval, the replication factor defaults, and
whether pull-based catch-up is fast enough.

**Q3 — Should identity replicate at all?** `users`, `permissions` and `password_hash`
currently replicate, while sessions, OAuth clients/tokens and media play keys deliberately
do not. Replicating credentials is what makes `/export` a credential dump (S1). The
alternative — identity stays node-local, and cross-node access is delegated (the OAuth
model already in the codebase) — is a bigger product change but a much smaller attack
surface. Worth deciding deliberately rather than inheriting.

**Q4 — What replication factor, and is `cache` mode still wanted?** 5.5 makes it work
properly, but it's the most complex part of the proposal. If every node is expected to be
a full replica, `blob_locations` gets much simpler and `cacheEviction.ts` can be deleted
outright.

**Q5 — Is there production data in a live cluster right now?** Determines whether Phase 2's
`uid` backfill needs to be online-safe, and whether the existing node-to-node wire protocol
needs a compatibility window or can be cut over.
