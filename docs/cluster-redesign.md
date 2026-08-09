# Cluster redesign — analysis and proposal

**Status:** **Phases 0–3 are built and green** (see Part 7). Part 4 records the decisions;
Parts 5–7 are built on them. Revised 2026-08-06 — the first draft recommended a **leaderless** design,
and that was overruled in favour of the **auto-tiered master/region topology** in Part 5.
Second revision, same day: credential material now replicates **on demand at login**
(§5.10), the master is **never** a region leader (§5.1), non-quota conflicts are arbitrated
by **timestamp then node id** (§5.8), quota is accounted in **logical quota bytes** with a
**sliding** reservation TTL (§5.9), and Option C is now rejected outright (Part 6).
**Scope:** `server/src/cluster/*` (3,352 lines incl. `routes/cluster.ts` and `ws.ts`), the
`cluster_*` tables in `db/schema.sql`, and the replication call sites in `routes/files.ts`.

Parts 1–3 (what exists, defect inventory, root causes) are unchanged as the case for doing
any of this, but Part 1's module map and Part 2's B1–B5/D1/D4 now describe what was
*replaced* rather than what is there — Phases 0–3 have landed. **If you only read one
section, read Part 4.**

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

**Revised note:** a leader *is* wanted after all (Part 4, D-1/D-8) — but for quota and
write ordering, which are jobs `election.ts` never did. The critique above stands
unchanged: what is being deleted is the *election*, not the leader. §5.3 replaces 536
lines of voting, epochs and quorum with a deterministic function over an agreed membership
snapshot, and §5.5 replaces automatic failover with a human decision, because guessing
whether the master died or you were partitioned is the failure mode, not the fix.

---

## Part 4 — Decisions

These were open questions in the first draft. They are now answered, and the answers
changed the shape of the proposal substantially — most of all by **reinstating a leader**,
which the first draft recommended deleting.

| # | Question | Decision |
|---|---|---|
| D-1 | Partitioned node keeps accepting writes? | **No.** Quota is master-authoritative; no master ⇒ no writes. |
| D-2 | Master loss behaviour | **5-minute restart grace**, requests held not failed; then hard degrade to local-only. **No automatic failover.** |
| D-3 | Region assignment | **Explicit (`NODE_REGION`) with RTT-clustering fallback** when unset. |
| D-4 | Leader score | **Greatest `disk_total_bytes`** (total capacity), ties broken by node id. |
| D-5 | Re-tiering trigger | **Manual, or `trunc(n/3)` status changes, n = whole cluster.** |
| D-6 | Down-replication | **Metadata to every node; bytes on demand**, and a region that pulls bytes **retains them as cache**. |
| D-7 | Cache eviction | **LRU**, with used-bytes surfaced in the UI and a configurable cap. |
| D-8 | Conflict resolution | **Master serializes.** For non-quota edits it picks by **timestamp, then origin node id**; the losing edit is recorded and surfaced in the admin panel. |
| D-9 | Deployment shape | **2–10 nodes, one region today.** Region tier is designed in but dormant. |
| D-10 | Chunk splitting | **Yes — reuse the chunked-upload blobbing.** Chunks are content-addressed like blobs. |
| D-11 | Chunk durability | **Replicate each chunk**, factor configurable. |
| D-12 | Identity replication | **`password_hash` and TOTP seeds replicate on demand**, pulled to a node the first time a user attempts a login there. Never pushed cluster-wide. |
| D-13 | Permission staleness | **Grants lazy, revocations synchronous** to every reachable node. |
| D-14 | Live data | **Single node with real data.** Backfills must be live-safe; no wire-compat window needed. |
| D-15 | Can the master be a region leader? | **No.** A region's leader is its top *non-master* node. A region holding one node — that node is the leader and is the whole region. |
| D-16 | Quota reservation lifetime | **Sliding TTL**, refreshed on chunk activity (keepalive after ~30 s idle) and on a ~10 h tick for transfers with no chunk cadence. |
| D-17 | Quota accounting unit | **Logical quota bytes** (`SUM(size_bytes)` against `quota_bytes`). Every path that creates a file row reserves, dedup or not. |
| D-18 | WebAuthn credentials | **Never replicate.** Per-node domains mean a credential registered on one node is unusable on another. |

### 4.1 What these decisions cost, stated plainly

Three of them buy correctness with availability, and the doc should say so before Part 5
makes them sound free:

- **D-1 + D-2 mean the cluster has no write path while the master is down, and no
  automatic recovery.** Mean time to repair is human-bounded. This is deliberate: a node
  cannot distinguish "the master died" from "I am the one who got cut off", and promoting
  on the second reading is precisely the split brain that `election.ts` spends 536 lines
  failing to prevent (B6, B7, B8). Choosing not to guess is cheaper and safer than
  guessing badly. The mitigation is operational, not algorithmic — a loud alert and a
  one-click promote (§5.5).
- **D-12 means a user cannot log in on a node that cannot reach a holder of their
  credential**, unless that node already pulled it during an earlier login. Existing
  sessions are node-local and unaffected, so this bites *first* logins on a given node
  during an outage only — a user's habitual node holds their material already.
- **D-12 also widens where the hash lives.** It ends up on every node a user has ever
  logged in on, rather than nowhere but its origin. That is the price of degraded-mode
  logins and of not shipping a plaintext password to a peer on every attempt; it is
  bounded by *use*, not by cluster size, and `/export` is gone either way (§5.13).
- **D-18 means passkeys are per node.** A user with `require_passkey` must enrol one on
  each node they intend to use, and usernameless WebAuthn login only works where the
  passkey was registered. TOTP does not have this problem, which is why it rides with
  the password hash instead.
- **D-5 with n = 3 gives a threshold of 1**, so a single flapping node would re-tier the
  whole cluster. §5.4 adds a hold-down window and a floor to stop that.

### 4.2 What is unchanged from the first draft

The identity and change-log work (§5.1 of the old draft, §5.6–5.7 here) survives intact.
Reinstating a master does **not** remove the need for globally unique row ids: two nodes
can still mint `files.id = 42` for two concurrent uploads that the master both approved,
because the master approves *quota*, not primary keys. Root causes (1) and (2) from Part 3
are untouched by the leadership decision.

---

## Part 5 — Target architecture

### 5.1 Topology: three tiers, hierarchical control plane

```
                        ┌──────────────────┐
                        │      MASTER      │   tier 0 — exactly one
                        │  quota authority │   canonical write order
                        │  write ordering  │   full replica, all bytes
                        └────────┬─────────┘
                 ┌───────────────┴───────────────┐
        ┌────────┴────────┐             ┌────────┴────────┐
        │ REGION LEADER A │             │ REGION LEADER B │   tier 1 — one per region
        │ relay + cache   │             │ relay + cache   │
        └────────┬────────┘             └────────┬────────┘
          ┌──────┼──────┐                  ┌─────┴─────┐
        node   node   node                node       node       tier 2 — followers
```

- **Control plane is strictly hierarchical.** A follower talks to its region leader; a
  region leader talks to the master. This is what "replicated up until it reaches the
  master, then replicates down" means concretely.
- **Data plane is not.** Chunk transfer may go node-to-node directly, chosen by the
  location registry (§5.11) and measured RTT. Forcing bytes through the hierarchy would
  make the region leader a bandwidth bottleneck for no correctness benefit.
- **A follower may reach the master directly** when its region leader is down. The region
  leader is a relay and a cache, not an authority — losing it degrades latency, not
  capability.
- **The master is never a region leader (D-15).** It is excluded from region-leader
  eligibility entirely, so tier 0 and tier 1 are always different nodes. A master that
  also relayed for its own region would be doing both jobs on one box — the tier that is
  supposed to absorb fan-out would be the tier already serialising every write.
- **A region holding exactly one node:** that node is its own region leader, and it is the
  entire region. It talks to the master directly, which is what a region leader does
  anyway — no special case in the code, just a member list of length 1.
- **A region holding only the master** has no leader and needs none: there is nothing to
  relay to, and the master's own control-plane path to itself is not a network hop.
- **Single-region case (D-9, today):** master + region leader + followers, all in one
  region. Tier 1 does **not** collapse — the region leader is the largest non-master node.
  At n = 2 that leaves a master and a leader with no followers, which is fine.

### 5.2 Region assignment

New columns on `cluster_nodes` (all via `ensureColumn`, per the no-migrations rule):

```
region          TEXT                     -- region name, e.g. 'eu-west'
region_source   TEXT DEFAULT 'inferred'  -- 'configured' | 'inferred'
rtt_ms          INTEGER                  -- median heartbeat round-trip to this peer
throughput_bps  INTEGER                  -- observed bytes/sec from chunk transfers
```

- `NODE_REGION` (env or admin panel) sets `region` with `region_source = 'configured'`
  and always wins.
- Unset ⇒ inferred by clustering the RTT matrix: nodes within a threshold of each other
  (default 30 ms median, configurable) form a region. `heartbeatJob` already round-trips
  every peer, so the measurement is free — it just isn't recorded today.
- `throughput_bps` is sampled from real chunk transfers rather than a synthetic probe. It
  feeds **placement and read source selection** (§5.11), not leader choice — D-4 made
  capacity the leader score outright.
- **Inference runs only at a re-tiering event, never continuously.** Otherwise region
  membership flaps with network weather, and everything downstream flaps with it.

### 5.3 Leader selection is a pure function, not an election

```
master          = argmax over all eligible nodes            of (disk_total_bytes, then node_id ASC)
regionLeader(r) = argmax over eligible nodes in r, MINUS the master
                                                            of (disk_total_bytes, then node_id ASC)
```

The master is computed **first**, over the whole cluster, and is then struck out of every
region's candidate set (D-15). So the master's own region is led by its second-largest
node; a region whose only member is the master has no leader; a region with one non-master
node has that node as leader by definition.

`disk_total_bytes` is already a `cluster_nodes` column, populated by `heartbeatJob`.
Ineligible: `REPLICATION_MODE=cache` nodes, nodes an operator has flagged ineligible, and
nodes outside the liveness window. An explicit operator pin overrides the computation
entirely.

Ties break lexically on `node_id` so every node computes the same winner from the same
input. **That is the whole trick:** the thing needing agreement is no longer *who leads*
but *what the membership snapshot is*. So the snapshot becomes the replicated artefact:

```sql
CREATE TABLE IF NOT EXISTS cluster_tiering (
  generation     INTEGER PRIMARY KEY,   -- monotonic, minted by the master only
  computed_at    TEXT NOT NULL,
  reason         TEXT NOT NULL,         -- 'manual' | 'drift' | 'promotion'
  master_node_id TEXT NOT NULL,
  snapshot       TEXT NOT NULL,         -- JSON: nodes, regions, capacities, rtt matrix
  regions        TEXT NOT NULL          -- JSON: region -> {leader, members[]}
);
```

A node applies the highest `generation` it has seen and derives its own role from it.
Only the master mints a generation; during a master outage none can be minted, which is
exactly the degraded mode in §5.5 rather than a separate failure to handle.

**This deletes:** `election.ts` in full (536 lines) — `runElection`, `handleVoteRequest`,
`/vote-request`, `/master-assumed`, `lastAppliedVector`, `vectorAtLeast`,
`knownClusterPeers`, `adoptEpochIfHigher`, the `epoch` and `voted_for`/`voted_epoch`
columns, `cluster_self_state`, and the `cluster_election_liveness` job. With them go
**B6, B7, B8, D3, D5 and S4** — there is no epoch to poison, no quorum computed over a
disagreed set, no terminal `candidate` state, and no unauthenticated role field, because
role is derived rather than asserted.

### 5.4 When tiering changes

Exactly three triggers.

**1. Manual.** An operator re-tiers from the admin panel or `POST /api/cluster/retier`.
Always available, always wins.

**2. Structural drift.** The master counts node status changes since the current
generation's snapshot. When the count reaches the threshold it mints a new generation.

- A *status change* is: joined, left, became unreachable, became reachable again, or
  changed capacity class. A node leaving and being replaced is **2** changes, as specified.
- Threshold is `max(2, trunc(n/3))` over the **whole cluster** (D-5). The floor matters:
  at n = 3, `trunc(3/3) = 1`, so without it a single node bouncing re-tiers everything.
- A change only counts once the node has **held** its new status for a hold-down window
  (default 5 minutes, same as the master grace). A restart is not drift.

**3. Master promotion**, which is manual by construction — see below.

**Region-leader loss is drift like anything else.** It counts toward the threshold and does
not by itself trigger a re-tier, because its followers can reach the master directly in the
meantime (§5.1).

### 5.5 Master loss: grace, then degrade

**There is no automatic failover.** This is the single most consequential decision in the
document (D-2) and it is deliberate — see §4.1.

| Time | Behaviour |
|---|---|
| t+0 | Master unreachable. Requests needing it are **held**, not failed: quota reservations, tiering, permission revocations. |
| t+0 → t+5min | Restart grace. A master returning inside the window drains the held requests; the only user-visible effect is latency. |
| t+5min | Grace expires. Held requests fail with a distinct error naming the cause. Cluster enters **degraded mode**. |

Degraded mode, per node, working from local information only:

| Still works | Refused |
|---|---|
| All reads — listings, downloads, previews, thumbnails | Uploads (browser, API, dropbox, remote, torrent) — quota unverifiable |
| Public share links and folder links | Renames, moves, deletes — no ordering authority |
| Media streaming and play keys (node-local already) | Permission and quota changes |
| Existing sessions (node-local, 24 h) | First-ever logins for users this node has never pulled credentials for (§5.10) |
| Logins for any user who has logged in on this node before (§5.10) | Passkey enrolment for a user who has none here (§5.10) |
| Cached and locally-held chunk serving | New link creation, encryption changes, sealing |

Recovery is either the master returning, or an operator promoting a node — a typed
confirmation in the admin panel, which mints generation *g+1* with `reason='promotion'`.
The panel shows a persistent banner naming the reason, the elapsed time, and which nodes
are reachable, because promotion is a judgement only a human with out-of-band knowledge of
the network can make safely.

### 5.6 Globally unique row identity

Unchanged from the first draft, and still required (§4.2). `uid TEXT` ULID on every
replicated table, unique; local `INTEGER PRIMARY KEY` stays for joins and FKs. `uid` is the
replication identity and `id` is never sent over the wire. Cross-node foreign keys travel
as the parent's `uid`, resolved on apply; rows whose parent `uid` hasn't landed park in a
pending buffer.

Backfill is `ensureColumn` plus a one-shot boot pass. D-14 (live data on one node) means
that pass must be safe on a populated database but needs no protocol compatibility window.

**This deletes:** `/reserve`, `identityHash`, `localIdentity`, the conflict path, and the
reason `rebaseFromMaster` exists — removing **D1**.

### 5.7 The change log, shipped hierarchically

```sql
CREATE TABLE IF NOT EXISTS replication_log (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,  -- this node's local stream
  master_seq  INTEGER,                            -- assigned when the master commits it
  table_name  TEXT NOT NULL,
  row_uid     TEXT NOT NULL,
  op          TEXT NOT NULL,                      -- 'upsert' | 'delete'
  payload     TEXT,                               -- JSON row; NULL for delete
  base_master_seq INTEGER,                        -- what the writer last saw (§5.8)
  origin_node TEXT NOT NULL,
  ts          TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS replication_cursors (
  peer_node_id TEXT NOT NULL,
  direction    TEXT NOT NULL,   -- 'up' | 'down'
  seq          INTEGER NOT NULL,
  PRIMARY KEY (peer_node_id, direction)
);
```

Every mutation to a replicated table appends here **inside the same transaction as the
write**, enforced at the DB adapter layer (`db/sqlite.ts`) rather than at call sites. That
is the fix for root cause (2): a write that isn't logged should be impossible, not merely
discouraged.

**Up:** follower → region leader → master, via `GET /api/cluster/changes?after=<seq>`.
Each hop forwards entries it has not yet forwarded, preserving origin.
**Down:** master → region leaders → followers, the same endpoint in the other direction.
The master's stream is canonical order; `master_seq` is assigned on commit there.

A locally-written row is **provisional** until it comes back down carrying a `master_seq`.
The UI need not show that distinction for ordinary work, but it is what lets §5.8 detect
conflicts and what makes "am I in sync" answerable: compare cursors against each peer's
head.

**Delay is expected and acceptable.** Budget one pull interval per hop — default 1 s
intra-region, 5 s cross-region, so a cross-region follower-to-follower propagation is
~4 intervals worst case.

**This gives, without touching a single route handler:** delete propagation, rename and
move propagation, permission and password changes, link revocation, lifecycle transitions,
media publishes — the entire B5 table. **It deletes:** `replicateFile`, `collectFileRows`,
`exportAll`, `applyRows`, `rebaseFromMaster`, `/replicate`, `/export`, and the
`void …catch()` call sites, removing **B4, B5, D4**.

### 5.8 Conflicts: the master serializes, and losers are visible

The master gates *quota*, not every mutation. A rename, a move, a permission edit and a
link revocation consume no quota, so two nodes can still both accept an edit to the same
row. Detection is optimistic concurrency control keyed on `master_seq`; **arbitration is by
timestamp, then origin node id** (D-8).

On apply at the master, for an incoming entry on row `uid`:

- `incoming.base_master_seq == row.master_seq` → **accept**, assign the next `master_seq`,
  ship down. No arbitration needed; nothing else touched the row.
- otherwise the two edits are concurrent, and the master picks a winner:
  1. **Later `ts` wins.**
  2. **Tie on `ts` → higher `origin_node` wins** (lexical on the node id).

Every log entry already carries `origin_node` and `ts` (§5.7), so both inputs are on the
wire for free. Notes on why it is shaped this way:

- **Only the master runs the rule**, so it is evaluated once against one clock's view of
  arrival, not independently on each node against its own. Two nodes cannot reach opposite
  verdicts, which is the failure LWW-at-every-node has and this does not.
- **The node id tiebreak is not decoration.** ISO8601-second (or even millisecond)
  timestamps collide in practice on scripted or bulk edits, and a rule that is undefined on
  a tie is a rule that diverges on a tie.
- **Clock skew is bounded, not trusted.** An entry whose `ts` is ahead of the master's own
  clock by more than the skew allowance is clamped to master receipt time before the
  comparison — otherwise a node with a fast clock silently wins every conflict it enters.
- **The winner may be the row already committed**, in which case the incoming entry loses
  and nothing changes except a conflict record. Either way the loser is written:

```sql
CREATE TABLE IF NOT EXISTS replication_conflicts (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  table_name     TEXT NOT NULL,
  row_uid        TEXT NOT NULL,
  losing_payload TEXT NOT NULL,
  losing_ts      TEXT NOT NULL,
  winning_master_seq INTEGER NOT NULL,
  winning_ts     TEXT NOT NULL,
  origin_node    TEXT NOT NULL,   -- who wrote the losing edit
  winner_node    TEXT NOT NULL,   -- who wrote the winning one
  detected_at    TEXT NOT NULL,
  dismissed_at   TEXT
);
```

`losing_payload` holds whichever edit lost — the incoming one, or the one already committed
when the timestamp rule went the other way. The conflict row ships down like any other row,
so the node whose edit lost learns about it. Followers apply the master's stream
unconditionally — the losing row is overwritten on the way back down.

The admin panel gets a **Conflicts** view: what was attempted, what won, on which node,
with *dismiss* and *re-apply* (re-apply = a fresh edit on top of the winner, not a replay).
No round-trip on the write path, and nothing is silently lost — which is the difference
between this and today's undocumented "whoever pushed last wins" (**D2**).

### 5.9 Quota is synchronous; permissions are not

Two different rules for two different risks.

**Quota — master-authoritative, on the write path (D-1).**

```
POST /api/cluster/quota/reserve   { user_uid, bytes }  →  { reservation_uid, expires_at }
POST /api/cluster/quota/renew     { reservation_uid }  →  { expires_at }
POST /api/cluster/quota/commit    { reservation_uid, actual_bytes }
POST /api/cluster/quota/release   { reservation_uid }
```

**The unit is logical quota bytes, everywhere (D-17).** `quota_bytes` versus
`SUM(files.size_bytes)` is the number that decides whether a user may write, so it is the
number the master reserves against — and every path that creates a `files` row reserves,
with no exemptions:

- Uploads: `POST /files/init`, chunked-upload init, dropbox upload, remote-upload submit,
  torrent add — i.e. before bytes are accepted, not after.
- Paths that create a row **without new bytes**: `POST /d/:slug/save` (R-5) and file copy.
  They attach an existing blob, so physical bytes may not grow at all — but logical bytes
  do, and logical bytes are the quota. Skipping the reservation there would let a user
  clone their way past `quota_bytes` for free.
- Dedup savings never reduce a reservation. That is already the rule locally
  (`usedStorageBytesForUser`) and it is the rule the master enforces cluster-wide.

The **global storage cap** and the **free-disk check** (`storage/accounting.ts`) ride the
same call and stay on post-dedup `SUM(stored_size_bytes)` — they are about disk, not
entitlement. They are cluster-wide facts now rather than local ones, but they are a
secondary gate: a reservation that passes the cap and fails quota is refused, and the
message names quota, because that is the one a user can do something about.

**Reservations are durable and their TTL slides (D-16).** They live in a master-side table
so an in-flight upload counts against quota before its bytes exist. Committed at
`finalizeStoredFile`, released on abort, expired by a sweep. The TTL is **not** a ceiling on
how long a transfer may take — a 12 h absolute cap would kill a legitimate multi-day torrent
import — it is an inactivity window:

- **Every chunk commit renews it.** For a chunked upload that is the natural heartbeat.
- **An idle keepalive renews it** when chunks stop arriving: ~30 s after the last chunk
  finished, the uploading node renews on the session's behalf, and keeps doing so while the
  session is alive. A stalled-but-live transfer holds its reservation; a client that walked
  away stops renewing.
- **A ~10 h periodic tick renews long transfers with no chunk cadence** — torrent imports
  and remote uploads, which are one opaque stream from the quota system's point of view.
- Expiry therefore means "nobody has touched this for a full window", which is the only
  condition under which releasing the bytes is safe. `CHUNK_SESSION_TTL` (12 h) remains the
  window length, so a resumable session still can't outlive its reservation.

**Permissions — local read, asymmetric write (D-13).**

- **Read path always uses the local `permissions` row.** Zero round-trips, so `requirePermission`
  stays as cheap as it is today.
- **Grants are lazy** — they flow down the log like any other row and take effect within
  replication lag.
- **Revocations are synchronous.** Removing a boolean flag, lowering a quota, disabling an
  account, deleting an API key, revoking a share link: the admin call does not return until
  every *reachable* node has acknowledged. The response names any node that lagged.
- Unreachable nodes pick it up from the log on reconnect. Residual exposure is a stale
  grant on a **read** only — such a node cannot reach the master, so it cannot accept
  writes anyway (§5.5).

The asymmetry is the point: a stale grant is a security hole, a stale denial is an
inconvenience. It is also why `POST /files/:id/seal`, link revocation and encryption
changes ride the revocation path rather than the ordinary one.

### 5.10 Identity: credential material replicates on demand, at login

**Replicated to every node, eagerly:** `users` (minus the credential columns),
`permissions`, avatar, `webauthn_user_handle`, MFA flags. Every node can therefore
*authorize* every user without a round-trip, which is what §5.9's local permission read
depends on.

**Replicated lazily, on first login attempt (D-12):** `password_hash` and TOTP seeds. They
are never pushed cluster-wide. A node that has never seen a given user holds nothing for
them; the first time someone attempts to log in as that user there, the node pulls the
material up the tier:

```
POST /api/cluster/identity/fetch  { username }
     → { password_hash, totp_secret_enc, must_change, mfa_required, methods, hash_version }
```

and stores it locally. Verification is then **local Argon2id**, on that node, exactly as it
is today — and stays local for every subsequent login there.

Why on-demand rather than never:

- **Degraded mode keeps working where it is used.** A node that can't reach the master can
  still log in every user who has logged in there before, which in practice is that node's
  entire population. Verify-at-a-holder cannot do that: it needs the holder, every time,
  forever.
- **The candidate password never leaves the node the user typed it into.** The alternative
  ships a plaintext password to a peer on every single login. Moving the hash once is a
  smaller exposure than moving the plaintext repeatedly.
- **Login latency is one round-trip, once per user per node**, not per login.

What it costs, stated plainly: the hash ends up on every node a user has actually used.
That set grows with use, not with cluster size, and a node holding it is already a node
that could mint that user's session. `/export` is deleted regardless (§5.13), so the
bulk-dump surface in **S1** is gone either way.

**Invalidation.** A password change, a TOTP re-enrolment, or an account disable publishes an
invalidation down the log; every node holding cached material drops it and re-fetches on the
next attempt. A node that was unreachable drops it when it reconnects and reads the log —
and until then it cannot accept writes anyway (§5.5). The fetch is rate-limited per
(node, username) so it cannot be used to enumerate accounts, and it is subject to
`security/lockout.ts` on the requesting node exactly as a local login is.

**TOTP seeds ride with the password hash** (D-12). Same table, same fetch, same
invalidation: a second factor that is unavailable on the node you are logging into is not a
second factor, it is an outage.

**WebAuthn credentials never replicate (D-18).** The relying-party id and origin are derived
from the node's own hostname (`security/webauthn.ts`, gated by `ALLOWED_HOSTS`), so a
credential registered against node A's domain cannot be asserted against node B's — sending
it would be shipping something unusable. Consequences to design around rather than paper
over:

- A passkey works on the node it was enrolled on. Usernameless WebAuthn login likewise.
- `require_passkey` replicates as a flag, so a user carrying it must enrol a passkey on each
  node they use; the enrolment endpoints stay reachable for exactly that reason.
- `webauthn_user_handle` **does** replicate — it is an identifier, not a credential, and
  keeping it stable is what makes the same user recognisable when they enrol on a second
  node.
- If shared passkeys are ever wanted, the fix is one cluster-wide domain in front of every
  node, not credential replication. That is a deployment decision, out of scope here.

### 5.11 Blobs: chunking, placement, and the region cache

**Chunking reuses the upload path's blobbing (D-10).** Every stored blob becomes a manifest
over N content-addressed chunks. Chunk size is `chunkUploadSize()` — 16 MiB, overridable
via `FILEUPLOAD_CHUNK_SIZE` (`routes/files.ts:95`) — which is already a whole multiple of
the AEAD container's 2 MiB plaintext frame (`crypto/aead.ts:14`), so **a chunk boundary
never bisects a GCM frame**. Chunking is over the **stored** bytes (post-transform), since
that is what is on disk and what `attachBlob` keys on.

```sql
CREATE TABLE IF NOT EXISTS blob_chunks (
  blob_uid     TEXT NOT NULL,
  idx          INTEGER NOT NULL,
  chunk_sha256 TEXT NOT NULL,
  size_bytes   INTEGER NOT NULL,
  PRIMARY KEY (blob_uid, idx)
);
CREATE TABLE IF NOT EXISTS chunk_locations (
  chunk_sha256 TEXT NOT NULL,
  node_id      TEXT NOT NULL,
  state        TEXT NOT NULL,   -- 'present' | 'wanted' | 'evicted'
  size_bytes   INTEGER NOT NULL,
  pinned       INTEGER NOT NULL DEFAULT 0,
  last_read_at TEXT,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (chunk_sha256, node_id)
);
```

Both replicate through the log, so **every node knows where every chunk is** — replacing
`fetchBlobFromPeers`' sequential 30-s-per-peer walk and its 30N-second worst case (**D6**).

**Limited-drive-space nodes.** This is the point of chunking, not a side effect. A 40 GiB
file is 2,560 chunks, and any node with 16 MiB free can hold one — so a small node
contributes real capacity toward files far larger than its disk, instead of being unable to
participate at all. Chunk-level accounting also means a node's contribution degrades
smoothly as it fills rather than falling off a cliff at "largest file it can hold".

Dedup improves as a side effect: chunks are keyed on their own `stored_sha256` and
ref-counted exactly like blobs today, so two files sharing a prefix share chunks.

**Placement (D-11).**

- `REPLICATION_FACTOR` (default 2) chunk copies cluster-wide. A `chunk_replication` job on
  each node finds under-replicated chunks it holds and pushes to the emptiest eligible
  target, preferring high `throughput_bps` and, for the second copy, a *different region*.
- **The master always holds a full copy.** It is the largest node by construction (§5.3),
  and this is what makes "everything replicates up to the master" true of bytes as well as
  rows. It also gives the durability check a node that is always a valid witness.
- Node loss becomes recoverable: `state='present'` rows for a dead node are re-queued for
  replication elsewhere, per chunk rather than per file.

**Region cache (D-6, D-7).**

- A node reading a chunk it doesn't hold picks a source from `chunk_locations`,
  nearest-first by measured RTT, and **retains** it (`state='present'`, `pinned=0`).
- Eviction is **LRU on `last_read_at`**. `pinned=1` chunks — the durability copies placed
  by the replication factor — are exempt: they are not cache and must never be evicted to
  make room for cache.
- `CACHE_MAX_BYTES` caps the **unpinned** bytes only; `0`/unset = uncapped.
- **The admin panel must show cache usage and let it be capped.** Per node: pinned bytes
  (durability), cached bytes (opportunistic), the cap, and headroom — as distinct numbers.
  Today's UI conflates the two, which is part of why `REPLICATION_MODE=cache` is hard to
  reason about.
- A chunk is evicted only once `chunk_locations` shows ≥ `REPLICATION_FACTOR` other
  `present` copies, verified with **one** confirming HEAD rather than an N-peer walk.

Together with push replication this is what finally makes cache mode work: bytes now reach
durable nodes without waiting for someone to download them (**B10**), and the eviction pass
is a table lookup rather than 10k×N sequential round-trips (**D6**).

**Read path.** `storage/streaming.ts` gathers chunks — local first, then nearest peer, in
parallel with a small look-ahead. For an untransformed file a Range request maps directly
onto a chunk range, so `Accept-Ranges: bytes` and seeking are preserved. Encrypted,
compressed and archived files still reproduce from byte zero and stream 200-only, exactly
as documented today; `entries[].seekable` keeps meaning what it means.

### 5.12 Event pipeline fixes

Unchanged from the first draft, and still the thing to do **first** — they are pure bug
fixes, independent of everything above, and they are what makes the rest debuggable.

1. Seed `EventBus.seq` from `SELECT MAX(origin_seq) FROM cluster_events WHERE
   origin_node_id = <self>` at startup (**B1**).
2. Serve `/admin/cluster/events` from the `cluster_events` **table**, ascending by
   `origin_seq`, not from the 5,000-entry ring buffer (**B2** and **B3**). The buffer stays
   for the live websocket only.
3. Persist locally-originated events synchronously in the publishing transaction rather
   than via the 250 ms drain, so an event cannot be published, observed by a peer, and then
   lost to a crash.

### 5.13 Security

- **Per-node credentials.** Replace the single shared `CLUSTER_TOKEN` with a short-lived,
  one-use, operator-generated enrolment token that mints a **per-node-pair** credential.
  Peer credentials are stored hashed where they are verified, and no response body ever
  contains another node's token (fixes **S1**, **S2**).
- **Rotation propagates.** A node announces its new credential over the log before the old
  one stops being accepted, with an overlap window (fixes **S3**).
- **`/export` is deleted** by §5.7, so the bulk credential dump in **S1** is gone rather
  than merely gated. What replaces it is deliberately narrow: `/cluster/identity/fetch`
  returns material for **one named user at a time**, rate-limited per (node, username),
  logged as an audit event on the holder, and answerable only over the per-node-pair
  credential above. "One user, on request, recorded" is a different surface from "every
  row in `users`, unlogged, to anything holding a shared static token".
- **Role and tiering are derived, not asserted.** With `election.ts` gone there is no
  `epoch` or `role` field in a request body to forge; a node's tier comes from the
  master-minted `cluster_tiering` generation, and only the master can mint one (fixes
  **S4**).
- **Node-to-node routes move to their own router** with their own auth, separate from the
  session-authenticated admin surface — ending the two-auth-models-in-one-625-line-file
  problem.

### 5.14 Resulting module shape

```
cluster/
  identity.ts      ULID minting, uid↔id resolution, pending-parent buffer
  changelog.ts     append (in-transaction), read by cursor, apply, conflict detection
  sync.ts          up/down pull loops per peer, cursor persistence, backpressure
  tiering.ts       membership snapshot, region inference, deterministic leader function,
                   generation minting, drift counter + hold-down
  membership.ts    enrol / heartbeat / peer table, RTT + throughput sampling
                   (no election, no epochs, no votes)
  quota.ts         master-side reservations on logical bytes; client side of
                   reserve/renew/commit/release + the idle keepalive
  credentials.ts   on-demand password-hash / TOTP-seed fetch, local cache,
                   invalidation on password or MFA change
  degraded.ts      master-reachability state machine, 5-min grace, held-request queue
  placement.ts     blob_chunks, chunk_locations, replication factor, push targets,
                   LRU eviction with pinned exemption and cache caps
  blobs.ts         fetch/serve chunk bytes (registry-driven)
  halt.ts          unchanged
  events.ts        eventBus + durable store, merged and fixed (§5.12)
routes/
  cluster.ts       session-authenticated admin surface only
  clusterNode.ts   node-to-node surface, separate auth
```

`election.ts`, `replication.ts` and `digest.ts` are gone. The line count is roughly flat
against today's 3,352 rather than the ~1,800 the first draft projected — chunking (§5.11),
quota reservations (§5.9) and degraded mode (§5.5) are new capability, not just
replacement. The complexity that *leaves* is the load-bearing kind: epochs, quorum, vote
grants, the announce protocol and the rebase sledgehammer.

---

## Part 6 — Alternatives, revisited

**Option A — leaderless log-shipping with LWW.** *(was recommended; now rejected)*
Rejected by D-1 and D-8: quota must be exact, which needs one authority, and a lost edit
must be attributable, which LWW cannot do. Its machinery survives — the uid scheme and the
change log are §5.6 and §5.7 — but its leaderless conclusion does not.

**Option B — real consensus (Raft).** Still rejected, and worth naming why the proposal is
not simply a worse Raft. What §5.3–5.5 describe is *single-writer without the consensus
machinery*: correctness comes from having exactly one authority, and the price is that
electing a replacement is a human decision rather than an automatic one. Raft's entire
value is automating that one step, at the cost of log compaction, snapshot transfer,
joint-consensus membership changes and the corner cases that make the papers long. At 2–10
operator-run nodes (D-9) with a human on call, that trade is not worth taking. The existing
`election.ts` is what a half-implemented Raft looks like, and it is the thing being deleted.

**Option C — externalize the metadata store (shared Postgres).** *(rejected)*
It would delete the log, the uid scheme, conflicts and cursors outright, and the first
revision kept it as a named fallback. **That is withdrawn: cross-region network timings
rule it out.** Postgres makes *every* metadata read a network call. A cross-region node is
tens to hundreds of milliseconds from the store, and the read path here is not one query —
listing a folder, walking an ancestor chain, resolving effective encryption, checking a
link, serving a range request all multiply out. At 150 ms RTT a page that costs a dozen
sequential round-trips is unusable, and no amount of pooling or caching fixes a design
whose base case is remote reads.

This design inverts that: **every read is local**, and only the small authoritative
decisions — quota reservation, write ordering, revocation — pay a round-trip, once. Those
are the operations where a delay is acceptable and correctness is not. Option C also adds
the hard operational dependency the project deliberately avoided. It is no longer the
fallback; if the master-gated write path proves too costly the answer is to narrow what the
master gates, not to move every read off-box.

**Option D — patch what's there.** Unchanged: D1's colliding integer ids can't be patched
without the uid change, and without that the announce/rebase machinery has to stay. The
event-pipeline fixes (§5.12) *are* worth taking as patches immediately, which is why they
are staged first.

---

## Part 7 — Phasing

Each phase is independently shippable and leaves the system no worse than before. D-14
(real data, single node) means every backfill must be live-safe, but no phase needs a
wire-protocol compatibility window.

| Phase | Work | Removes / adds |
|---|---|---|
| **0** | Cluster test harness — multi-node in-memory, extending `tests/harness.ts` | the reason all of this shipped green |
| **1** | Event pipeline fixes (§5.12) | B1, B2, B3 |
| **2** | `uid` column + live-safe backfill on replicated tables | D1 |
| **3** | `replication_log` + in-transaction append at the adapter layer; hierarchical up/down pull + cursors. Delete `replicateFile`, `/reserve`, `/replicate`, `/export`, `rebaseFromMaster` | B4, B5, D4, S1 |
| **4** | `cluster_tiering`, region columns, RTT sampling, deterministic leader function, drift counter. **Delete `election.ts`**, epochs, `cluster_self_state`, `digest.ts`'s split-brain check | B6, B7, B8, B9, D3, D5, S4 |
| **5** | Master-gated quota reservations on logical quota bytes, sliding TTL + renew/keepalive; degraded mode + 5-minute grace + held-request queue; admin promote + banner | D-1, D-2, D-16, D-17 |
| **6** | `replication_conflicts` + timestamp/node-id arbitration + admin Conflicts view; synchronous revocation path | D2, D-8, D-13 |
| **7** | Identity split — on-demand `/cluster/identity/fetch` for hash + TOTP seed, invalidation down the log, WebAuthn stays node-local | D-12, D-18, closes S1 fully |
| **8** | Chunking: `blob_chunks`, `chunk_locations`, replication factor, push replication, LRU + pinned exemption, cache caps and admin UI | B10, D6, D-10, D-11 |
| **9** | Per-node credentials, rotation with overlap, node-to-node router split | S2, S3 |

Phases 1 and 2 are safe against the current design. **Phase 3 is the one-way door.**
Phase 4 is the point at which the topology in this document actually exists. Phase 8 is
separable and can slip without blocking anything above it — chunking is capability, not
correctness.

### Built so far (2026-08-09)

Phases **0 through 8** are implemented and green — the door is walked through, the
topology in this document actually exists, nothing is overwritten silently any more,
credential material no longer travels to nodes that have no use for it, and a blob is no
longer an object a node either holds whole or not at all.

| Phase | Landed as |
|---|---|
| 0 | `server/tests/clusterHarness.ts` — `makeCluster({size})`, N real nodes on real ports |
| 1 | `eventBus.seedSeq` + front-truncated `recent()`; `/admin/cluster/events` serves the durable table; local events persist synchronously |
| 2 | `cluster/identity.ts` — ULID `uid` on every replicated table (seven then, nine after Phase 8), unique, backfilled at database open |
| 3 | `cluster/changelog.ts` (triggers + apply + cursors + seed), `cluster/replication.ts` rewritten as the pull, `GET /api/cluster/changes`, `cluster_replication_pull` job |
| 4 | `cluster/tiering.ts` — `cluster_tiering` + `cluster_drift`, the deterministic leader function, region inference, generation minting and the hold-down drift counter. **`cluster/election.ts` deleted in full**, with epochs, votes, `cluster_self_state`, `/vote-request`, `/master-assumed`, `cluster_election_liveness` and `digest.ts`'s split-brain check |
| 5 | `cluster/quota.ts` — the `quota_reservations` ledger, `/cluster/quota/{reserve,renew,commit,release}`, sliding TTL + sweep. `cluster/degraded.ts` + `middleware/degradedMode.ts` — reachability state machine, 5-minute grace, held-request queue, write gate. `promoteSelf` + `POST /cluster/promote` + the admin banner |
| 6 | `cluster/conflicts.ts` — `replication_conflicts`, the total timestamp/node-id rule and the skew clamp, arbitrated inside `applyChanges` on the master alone; `/cluster/conflicts` + dismiss + re-apply, and the admin **Conflicts** tab. `cluster/revocation.ts` — `revocationMark`/`pushRevocation` + `POST /cluster/revocations`, wired into permission edits, user updates and deletion, share- and folder-link edits and deletes, and sealing |
| 7 | `cluster/identityFetch.ts` — `password_hash` out of `TABLE_COLUMNS`, `users.credential_version` (replicated) + `credential_version_local` (not), `POST /cluster/identity/{fetch,publish}`, the login-time fetch, and the publish-to-master on every credential write. WebAuthn untouched, because it was already node-local |
| 8 | `cluster/placement.ts` — `blob_chunks` + `chunk_locations` (both replicated, both in `UID_TABLES`), the manifest computed in the hash pass `finalizeStoredFile` already made, `GET/HEAD/POST /cluster/chunks/:sha`, registry-driven read-time fetch in `cluster/blobs.ts`, the `cluster_chunk_replication` push job, and `cacheEviction.ts` rewritten as LRU over *unpinned* chunks with the durability check as a table read plus one HEAD. `PUT /cluster/cache-cap` and the dashboard's pinned/cached/headroom line |

Tests: `clusterEvents`, `clusterIdentity`, `clusterChangelog`, `clusterReplication`,
`clusterTiering`, `clusterQuota`, `clusterConflicts`, `clusterRevocation`,
`clusterTopology`, `clusterIdentityFetch`, `clusterChunks`.

Three implementation decisions worth recording, because the text above does not predict
them:

- **The append is a SQLite trigger, not a wrapper around `db.run()`.** Detecting writes by
  parsing SQL at the adapter would be guesswork; a trigger sees the committed row. It also
  means the mint moved into the trigger, so §5.6's "minted where the row is created" is
  now literally true rather than aspirational. `replication_control` carries the node
  identity and a suppression flag the triggers read, because a trigger cannot reach
  application state.
- **No pending-parent buffer.** §5.7 allows for one; it turned out to be unnecessary.
  Entries apply in `seq` order and a forwarding hop re-appends in the order it applied, so
  seq order *is* dependency order. Apply halts at the first entry it cannot write and
  leaves the cursor before it, which retries rather than drops.
- **`/cluster/export` was deleted with nothing replacing it.** `seedChangeLog` writes an
  `upsert` entry per existing row the first time a populated database meets an empty log,
  so a joining node gets the whole corpus from cursor 0 through the ordinary pull. One
  mechanism for state transfer instead of two that can disagree.

And five more from Phase 4:

- **The generation rides on the handshakes that already exist.** §5.3 says the snapshot
  becomes the replicated artefact but not how it travels. It travels whole, on every
  `/join` and `/heartbeat` payload in both directions, and is adopted on strictly-higher
  generation. At 2–10 nodes (D-9) the record is small enough that membership gossip needs
  no protocol of its own — a peer either learns nothing new or adopts a newer generation
  in a round-trip it was already making. `GET /api/cluster/tiering` exists for a node that
  wants it sooner.
- **Enrolling adopts by force, not by height.** Joining a cluster means taking its answer:
  a standalone node that bootstrapped itself as master at generation 1 must not keep
  believing that afterwards, and both sides start at generation 1 so a
  highest-wins rule would never fire. That is the one adoption that is not
  monotonic, and it is the same shape as the old `learnMasterPointer` bootstrap problem.
- **A join re-tiers immediately; everything else waits out the hold-down.** §5.4's
  hold-down exists so a restart is not drift, but applying it to a *new* node id would
  leave that node with no upstream — and therefore replicating with nobody — for five
  minutes. A node the current generation has never seen (`settled_status IS NULL`) counts
  as a change straight away, which is what makes `/join` usable in seconds.
- **The drift status is a composite, `<liveness>:<role-it-would-get>`.** That is R-3's
  answer wired in rather than left as a recommendation: raw `disk_total_bytes` moves on
  every write, so folding the *prospective* role into the status is what makes "a capacity
  change that would alter the computed leader" the only capacity change that counts —
  and it gets the same hold-down as any other.
- **Liveness is read from two places on purpose.** The snapshot's `active` flag is the
  master's view at mint time, which is the right input to the leader computation. Whether
  a node can talk to its leader *right now* is its own observation, and that is what
  `pullTargets` passes into `upstreamOf` so a follower cut off from its relay falls back
  to the master (§5.1) without waiting for a generation that is not coming.

And four from Phase 5:

- **`finalizeStoredFile` reserves for itself when the caller didn't.** §5.9 lists the
  paths that must reserve; enumerating them in code would mean every future upload path
  has to remember, which is exactly how the pre-Phase-3 replication scheme shipped two of
  forty call sites. Instead the one funnel every write already passes through takes a
  reservation if none was handed down, so "every path that creates a `files` row reserves"
  holds by construction. Callers that can reserve *earlier* still do — refusing a 40 GB
  upload after 40 GB have crossed the wire is not much of a refusal.
- **You cannot reserve against a size you do not know.** §5.9 lists torrent add and
  remote-upload submit among the reserve-up-front paths. Neither can be: a magnet is a
  promise, and a remote URL may send no `Content-Length` or lie about one. Both reserve at
  the moment their true size first exists — the importer, and `finalizeStoredFile`
  respectively — and `debrid.ts` keeps a *local, explicitly advisory* pre-check so a user
  who obviously cannot fit the torrent hears about it in seconds. The chunked-upload path
  is the one that genuinely declares its size up front, so it is the one that holds a
  reservation across the transfer and renews it from chunk commits.
- **Degraded mode gates by method with an allowlist, not by enumerating write routes.**
  It fails closed: a route added later is refused while degraded unless someone
  deliberately allowlists it. The allowlist is five prefixes and each has a reason
  recorded next to it — most importantly `/api/cluster`, without which promotion (the only
  way out) would itself be gated and degraded mode would be unrecoverable.
- **Free disk stayed local while the global cap moved to the master.** They look like the
  same check and are not: the cap is a cluster-wide budget, but free space is a fact about
  the node that will physically hold the bytes, and the master's spare gigabytes say
  nothing about a follower's. Moving both would have made a full follower accept writes it
  cannot store.

And four from Phase 6:

- **A losing entry never enters the master's log.** §5.8 says the loser is recorded; it
  does not say where the loser must *not* go. It must not go into `replication_log`,
  because the log is what ships down — a loser with a `master_seq` would be applied by
  every follower after the winner and the cluster would converge on the edit the master
  rejected. So the loser goes to `replication_conflicts` only, and the master appends a
  **restatement** of the winning row, which is what carries the verdict back to the node
  that lost.
- **Conflicts are read through to the master, not replicated.** The doc says the conflict
  row "ships down like any other row". Making that literally true would mean adding an
  another table to `UID_TABLES` — with a `uid`, triggers and a boot backfill — for rows only
  the master ever writes. The panel on a non-master proxies to the master instead: one
  writer, one record, and no second thing that can disagree about a verdict.
- **Arbitration is idempotent by construction.** A peer whose cursor slips re-delivers
  entries the master has already judged. An entry already in the log with a `master_seq`,
  or already recorded as a loser, is skipped outright — re-applying an accepted entry
  would clobber whatever later edit has since won the row, which is a worse outcome than
  the redelivery it was meant to tolerate.
- **The revocation push is delivery *earlier*, not delivery *differently*.** What it sends
  is the `replication_log` entries the write already produced, applied through the same
  `applyChanges`; the ordinary pull re-delivers them afterwards and dedups to nothing. If
  the push fails entirely the cluster still converges at pull speed, so a peer being down
  degrades latency rather than correctness — which is what lets the admin call report a
  lagging node instead of failing.

And four from Phase 7:

- **Invalidation is a replicated counter, not a message.** §5.10 says a password change
  "publishes an invalidation down the log", which reads as a new kind of entry. It is not
  one: `users.credential_version` is an ordinary replicated column, bumped by every
  credential write, and `credential_version_local` — which does *not* replicate — records
  which version this node's copy matches. A node whose local number is behind knows its
  material is stale, and it knows it from a row it was going to receive anyway. Because
  the counter is monotonic, a node that was offline, a node that cached nothing and a node
  that received the bump out of order all behave identically, with no delivery guarantee
  needed for correctness. The revocation push rides on top purely for speed: a stale
  password hash is a stale *grant*, which is the case §5.9 refuses to leave to the pull.
- **The master is the holder of record, so a fetch always terminates.** §5.10 says a node
  "pulls the material up the tier" without saying who is guaranteed to have it. Nothing is,
  unless credential writes put it somewhere known — so every write publishes to the master
  synchronously (`POST /cluster/identity/publish`) *after* pushing its log entries, since
  the master needs the `users` row before it can hold material for it. Fetch then walks up
  and stops at the master. Nothing walks down or sideways; a node asking a sibling is how
  two halves of a partition end up authenticating against two different passwords.
- **A relay forwards without keeping a copy.** A follower's fetch passes through its region
  leader, and the obvious optimisation is for the leader to cache what it relays. It does
  not, deliberately: §5.10's stated cost is that the hash ends up on every node *the user
  has actually used*, and a caching relay would quietly widen that to every node on every
  path. The bound is worth more than the round-trip.
- **Storing fetched material is suppressed, exactly as applying an entry is.** Writing a
  fetched hash into `users` fires the change-log trigger, which would append a `users`
  upsert carrying no new replicated state — and that spurious entry could go on to *win*
  an arbitration against a real concurrent edit and discard it. Material learned from a
  peer is not this node's own write, so `replication_control.suppressed` is raised around
  it, on the same reasoning that raises it inside `applyChanges`.

And five from Phase 8:

- **A chunk is a byte range of the blob's file, not an object in a chunk store.** §5.11
  describes chunks as if they were separately stored things. Storing them separately would
  either double the disk of every complete blob or force every existing read path —
  `routes/public.ts`, `storage/zip.ts`, `thumbnail.ts`, `rekey.ts`, ffprobe — through an
  assembly layer. Instead the manifest *describes* the file that is already there:
  `content_blobs.storage_path` replicates, so every node agrees on the path, and a node
  holding a subset holds a sparse file with the ranges it has. A node holding all of them
  holds exactly what every read path opens today, so chunking became an addition to the
  read path rather than a rewrite of it.
- **The registry decides partial holdings; the file decides complete ones.** A sparse
  file's length reaches the end of the highest chunk written, so `existsSync` and even a
  size check cannot distinguish a whole blob from one with holes. The rule is: believe a
  location row whenever one exists, and with no rows at all believe a file of exactly
  `stored_size_bytes` — which is every blob written before this phase, and every blob on a
  node that has never evicted. That is also what keeps the read path's fast case one stat
  and one indexed lookup instead of a walk over a 2,560-entry manifest.
- **`last_read_at` is node-local, and neither natural key is UNIQUE.** The LRU clock moved
  out of `chunk_locations` into `local_chunk_cache`, because a column that changes on every
  read would append a change-log entry — and ship it cluster-wide — every time somebody
  watched a video. And neither `(blob_id, idx)` nor `(chunk_sha256, node_id)` carries a
  constraint: a UNIQUE violation raised while applying a peer's entry halts the whole
  replication batch, so uniqueness is held by having one writer per row (the creating node
  for a manifest, the owning node for a location) and by counting `DISTINCT node_id`
  rather than rows.
- **Legacy blobs are seeded as one whole-file chunk, by the master alone.** R-2's
  recommendation, with the detail R-2 does not state: the seed is *free*, because a legacy
  blob's single chunk hash is its `stored_sha256` and nothing has to be read — and it must
  run on one node only, or two nodes would mint two manifests for the same blob and ship
  both.
- **An eviction that frees nothing is not recorded as one.** Evicting a chunk out of the
  middle of a file that has to stay needs a hole punched in it, which no portable API
  exposes; `fallocate --punch-hole` is attempted and its failure is an ordinary answer.
  When it fails the chunk stays `present` and the pass moves on, because a cache that
  believed it was under its cap while the disk said otherwise would evict its way down to
  nothing.

---

## Part 8 — Residual questions

None of these block Phase 0–3. Each carries a recommendation, so silence is a valid answer.
R-1, R-4 and R-5 are now **answered** and folded into Parts 4–5; they are kept here with
their resolutions so the reasoning isn't lost.

**R-1 — WebAuthn credentials and TOTP seeds.** ~~Recommend replicating WebAuthn public
keys.~~ **Resolved (D-18): WebAuthn credentials do not replicate at all.** The recommendation
was wrong on the deployment reality — nodes serve different domains, so the rpID/origin a
credential was registered against doesn't exist on a peer and the credential is unusable
there no matter what is replicated. **TOTP seeds replicate with the password hash** (D-12),
on demand at login, because a second factor that only works on one node is an outage rather
than a factor. §5.10 has the detail.

**R-2 — Legacy blobs at the chunking cutover.** Rechunk existing blobs in place, or record
them as single-chunk manifests and only chunk new writes? *Recommend:* single-chunk
manifests, with an optional background rechunk job — it makes Phase 8 non-disruptive.

**R-3 — What counts as a "capacity class change"** for the drift counter (§5.4)? Any change
to `disk_total_bytes` would make routine disk growth look like churn. *Recommend:* only a
change that would alter the computed leader, plus crossing an eligibility boundary.

**R-4 — Quota reservation TTL.** **Resolved (D-16): it is not a ceiling, it is an
inactivity window.** 12 h stays as the window length, but it *slides* — renewed on every
chunk commit, by a keepalive ~30 s after the last chunk finished while the session is still
alive, and by a ~10 h periodic tick for transfers with no chunk cadence (torrent imports,
remote uploads). A multi-day import therefore holds its reservation for as long as it is
making or attempting progress, and expiry only ever means the uploader is genuinely gone.
§5.9 has the shape.

**R-5 — Does `POST /d/:slug/save` need a quota reservation?** **Resolved (D-17): yes, and
the general rule is that quota bytes are what matter.** Every path that creates a `files`
row reserves against logical `SUM(size_bytes)` — saves, copies, uploads, imports alike —
because `quota_bytes` is the entitlement being enforced and physical dedup savings are the
system's, not the user's. The global cap and free-disk check keep using post-dedup bytes,
but they are the secondary gate. §5.9 has the list.
