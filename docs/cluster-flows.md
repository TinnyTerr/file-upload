# Cluster flows — what a node does, and who it talks to

What the code does **today** (`server/src/cluster/*`, `routes/cluster.ts`, `jobs/scheduler.ts`). The
target design is in `cluster-redesign.md`; this is not it. Diagrams are Mermaid and render on GitHub.

All node-to-node HTTP is `Authorization: Bearer <cluster token>` via `cluster/http.ts`, except the
websocket firehose, which is token-authed at upgrade in `ws.ts`.

> Live version of all this: **Cluster → Activity** in the UI. It traces only while the tab is open and
> Live is on (`cluster/activity.ts`).

## 1. One node, everything running

```mermaid
flowchart LR
  subgraph clients[Clients]
    B[Browser / API key]
    PW[Peer node]
  end

  subgraph node[This node: one Bun process, one app.listen]
    direction TB
    EX[Express]
    WS[ws.ts upgrade handler]
    BUS[(eventBus<br/>in-memory, origin_seq)]
    STORE[(cluster_events<br/>UNIQUE origin_node_id, origin_seq)]
    DB[(SQLite)]
    BLOB[(data/storage)]
    HALT[haltRegistry<br/>TTL map]
    SCH{{scheduler.ts<br/>setInterval jobs}}
    FH[ClusterFirehoseConsumer<br/>one poller per peer]
  end

  B -->|/api/*| EX
  B -->|/api/ws/events<br/>session cookie| WS
  PW -->|/api/cluster/* cluster token| EX
  PW -->|/api/admin/cluster/firehose| WS

  EX --> DB
  EX --> BLOB
  EX -->|publish| BUS
  BUS --> STORE
  BUS --> WS
  BUS -. upload.halt .-> HALT

  SCH -->|60s heartbeatJob| PW
  SCH -->|15s checkMasterLivenessJob| PW
  SCH -->|5m syncCheckJob| PW
  SCH -->|10m cacheEvictionJob| PW
  FH -->|1s GET /api/admin/cluster/events?after=cursor| PW
  FH -->|submit| STORE
  FH -. upload.halt / resume .-> HALT
```

## 2. Scheduled jobs (cluster ones)

| Job | Every | Talks to | Does |
|---|---|---|---|
| `cluster_heartbeat` | 60 s | `POST /heartbeat` on every known peer | refresh disk/role/epoch, mark unreachable `active=0`, learn higher epochs, reset master-silence timer |
| `cluster_election_liveness` | 15 s | nobody, unless it calls an election | if follower and silent > 90 s: jitter 0–1.5 s, re-check, `runElection` |
| `cluster_sync_check` | 5 min | `GET /digest` on active peers | compare hashes → `cluster.sync_mismatch`; two masters at one epoch → `cluster.split_brain_detected` |
| `cluster_cache_eviction` | 10 min | `confirmedElsewhere` against a `full` peer | `REPLICATION_MODE=cache` only: LRU-delete blobs over `CACHE_MAX_BYTES`, never the only copy |
| firehose reconcile | 5 s | — | start/stop one poller per active peer; each polls every 1 s, backs off ×2 up to 30 s |

## 3. Joining

```mermaid
sequenceDiagram
  participant N as New node
  participant M as Master (MASTER_URL)
  participant P as Other peers
  N->>M: POST /api/cluster/join {node_id, base_url, token, role, epoch, disk...}
  M->>M: upsertPeer, recordAudit cluster.node_joined
  M-->>N: {self, peers[]} (every other active node)
  N->>N: upsertPeer for master + each peer
  Note over N,P: Full mesh. From here heartbeat (60s) reaches every peer directly
  N->>M: rebaseFromMaster: GET /api/cluster/export
  M-->>N: every replicated row
  N->>N: applyRows
```

## 4. A file upload replicating (announce-id protocol)

Runs after `finalizeStoredFile` on the node that took the upload. Best-effort; a no-op with no peers.

```mermaid
sequenceDiagram
  participant U as Uploader node
  participant P1 as Peer 1
  participant P2 as Peer 2
  participant M as Master
  Note over U: collectFileRows (file + ancestor dirs + blob + links)
  loop each peer: phase 1, reserve the id
    U->>P1: POST /reserve {table, id, identity, epoch}
    alt requester epoch < peer epoch
      P1-->>U: {stale_epoch, current_epoch}
      U->>U: adoptEpochIfHigher, retry once
    else peer already holds a different row at that id
      P1-->>U: {ok:false, conflict:true}
      U->>M: GET /export
      M-->>U: canonical rows
      U->>U: applyRows (local divergence overwritten)
      Note over U: returns "conflict", upload not replicated
    else free or identical
      P1-->>U: {ok:true}
    end
    Note over U,P2: unreachable peer: skipped, heartbeat marks it stale
  end
  loop each peer: phase 2, push
    U->>P1: POST /replicate {rows}
    P1->>P1: applyRows, last writer wins by timestamp
    U->>P2: POST /replicate {rows}
  end
  Note over P1,P2: Blob BYTES are not pushed. Peers pull them on first read (section 5)
```

## 5. A download on a node that lacks the bytes

`routes/public.ts` raw/preview → `storage/streaming.ts` → `fetchBlobFromPeers`.

```mermaid
sequenceDiagram
  participant V as Visitor
  participant A as Node A (no local blob)
  participant P1 as Peer 1
  participant P2 as Peer 2
  V->>A: GET /file/:slug/raw
  A->>A: resolve link, row replicated so it exists
  A->>A: blob file missing on disk
  loop active peers, in order
    A->>P1: GET /api/cluster/blobs/:storedSha256?transform=
    alt peer has it
      P1-->>A: stream
      A->>A: write .peer.tmp, rename, touchBlobAccess (LRU clock starts)
    else 404 / error
      Note over A,P2: next peer
      A->>P2: GET /api/cluster/blobs/...
    end
  end
  A-->>V: plaintext stream (decrypt/decompress composed)
  Note over A: no peer has it: request fails
```

## 6. Leader election

Epoch-versioned; every write is fenced on epoch. Leadership traffic deliberately does **not** go over
the firehose.

```mermaid
sequenceDiagram
  participant F as Follower (silent master > 90s)
  participant P1 as Peer 1
  participant P2 as Peer 2
  Note over F: checkMasterLivenessJob, jitter, re-check
  F->>F: role=candidate, epoch+1, vote for self
  par
    F->>P1: POST /vote-request {candidate_id, epoch, vector}
    F->>P2: POST /vote-request {candidate_id, epoch, vector}
  end
  Note over P1,P2: refuse if stale_epoch or candidate_behind (applied vector), idempotent if already voted
  P1->>P1: persist vote BEFORE replying, demote self if master
  P1-->>F: {granted}
  P2-->>F: {granted}
  alt grants >= floor((peers+1)/2)+1
    F->>F: role=master, publish cluster.master_elected
    F->>P1: POST /master-assumed {node_id, node_url, epoch}
    F->>P2: POST /master-assumed
  else
    F->>F: back to follower at new epoch, next 15s tick retries
  end
```

Node role state:

```mermaid
stateDiagram-v2
  [*] --> follower: first boot, NODE_ROLE != master
  [*] --> master: first boot, NODE_ROLE = master
  follower --> candidate: master silent > 90s
  candidate --> master: majority of votes
  candidate --> follower: lost / split vote
  master --> follower: saw higher epoch (vote-request, heartbeat, reserve)
  follower --> follower: heartbeat from master resets timer
```

## 7. Events and halts (the firehose)

```mermaid
sequenceDiagram
  participant A as Node A
  participant B as Node B
  participant AdminB as Admin browser on B
  A->>A: eventBus.publish(action) assigns origin_seq
  A->>A: eventWriter, cluster_events row
  loop every 1s per peer
    B->>A: GET /api/admin/cluster/events?after=cursor&limit=500
    A-->>B: events, last_id
    B->>B: eventWriter.submit (dedup by origin_node_id, origin_seq)
    opt upload.halt / upload.resume
      B->>B: applyHaltEvent to haltRegistry
    end
  end
  AdminB->>B: WS /api/ws/events
  B-->>AdminB: live events from every node
  Note over B: peer unreachable: cursor kept, backoff 1s to 30s, resume where it left off
```

`broadcastHalt` is how "stop uploads" spreads: set locally with a TTL (default 300 s), publish a
`control` event, peers apply it on their next poll. Worst-case spread is about 1 s plus poll latency.

## 8. Which endpoint is which

| Endpoint (`/api/cluster`) | Caller | Part of |
|---|---|---|
| `POST /join` | new node → master | join |
| `POST /heartbeat`, `GET /ping` | scheduler | liveness, epoch gossip |
| `GET /digest` | scheduler | drift and split-brain check |
| `POST /reserve`, `POST /replicate` | uploader | announce-id replication |
| `GET /export` | any node that diverged or joined | rebase from master |
| `GET /blobs/:sha` | any node that missed a read | blob fetch-on-miss, cache confirm |
| `POST /vote-request`, `POST /master-assumed` | candidate | election |
| `GET /api/admin/cluster/events`, `WS /firehose`, `GET /node-logs` | peers, admin UI | events, remote logs |
