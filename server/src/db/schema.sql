-- Full schema for the Bun+Express rewrite, mirroring app/models/*.py.
-- All timestamps stored as ISO8601 UTC strings (equivalent to UTCDateTime).
-- No migration framework -- additive changes only (CLAUDE.md convention).

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Cluster-wide row identity (ULID, cluster/identity.ts). Replication ships
  -- `uid`; `id` is node-local and never goes on the wire. NULL only until the
  -- boot backfill has run over a database created before this column existed.
  uid TEXT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  must_change_credentials INTEGER NOT NULL DEFAULT 0,
  avatar_data BLOB,
  avatar_content_type TEXT,
  mfa_required INTEGER NOT NULL DEFAULT 0,
  webauthn_user_handle TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS permissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Cluster-wide row identity (ULID, cluster/identity.ts). Replication ships
  -- `uid`; `id` is node-local and never goes on the wire. NULL only until the
  -- boot backfill has run over a database created before this column existed.
  uid TEXT,
  user_id INTEGER NOT NULL UNIQUE REFERENCES users(id),
  can_upload INTEGER NOT NULL DEFAULT 1,
  can_upload_client_encrypted INTEGER NOT NULL DEFAULT 0,
  can_delete INTEGER NOT NULL DEFAULT 1,
  can_regenerate_links INTEGER NOT NULL DEFAULT 1,
  can_delete_links INTEGER NOT NULL DEFAULT 1,
  can_create_directories INTEGER NOT NULL DEFAULT 1,
  can_manage_lifecycle INTEGER NOT NULL DEFAULT 1,
  can_use_api_keys INTEGER NOT NULL DEFAULT 0,
  can_view_admin INTEGER NOT NULL DEFAULT 0,
  can_manage_users INTEGER NOT NULL DEFAULT 0,
  can_manage_storage INTEGER NOT NULL DEFAULT 0,
  can_manage_api_keys INTEGER NOT NULL DEFAULT 0,
  can_manage_cluster INTEGER NOT NULL DEFAULT 0,
  can_use_torrents INTEGER NOT NULL DEFAULT 0,
  can_watch_media INTEGER NOT NULL DEFAULT 0,
  -- Account-hardening requirements. `require_mfa` demands any second factor at
  -- login; `require_passkey` narrows that to WebAuthn specifically (and implies
  -- require_mfa). Either one blocks the account everywhere except MFA
  -- enrollment until the matching credential exists.
  require_mfa INTEGER NOT NULL DEFAULT 0,
  require_passkey INTEGER NOT NULL DEFAULT 0,
  quota_bytes INTEGER NOT NULL DEFAULT 107374182400,
  max_file_bytes INTEGER NOT NULL DEFAULT 10737418240,
  archive_after_idle_days INTEGER NOT NULL DEFAULT 5,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  csrf_token TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  -- Cloudflare CF-IPCountry: ISO 3166-1 alpha-2, or Cloudflare's specials
  -- XX (no country data) / T1 (Tor). NULL when not behind Cloudflare.
  country_code TEXT
);
CREATE INDEX IF NOT EXISTS ix_sessions_user_id ON sessions(user_id);

CREATE TABLE IF NOT EXISTS login_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  identifier TEXT NOT NULL,
  identifier_type TEXT NOT NULL,
  failed_count INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE(identifier, identifier_type)
);

CREATE TABLE IF NOT EXISTS content_blobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Cluster-wide row identity (ULID, cluster/identity.ts). Replication ships
  -- `uid`; `id` is node-local and never goes on the wire. NULL only until the
  -- boot backfill has run over a database created before this column existed.
  uid TEXT,
  storage_path TEXT NOT NULL UNIQUE,
  content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  size_bytes INTEGER NOT NULL DEFAULT 0,
  stored_size_bytes INTEGER NOT NULL DEFAULT 0,
  sha256 TEXT NOT NULL,
  sha1 TEXT NOT NULL DEFAULT '',
  md5 TEXT NOT NULL DEFAULT '',
  blake2b TEXT NOT NULL DEFAULT '',
  stored_sha256 TEXT NOT NULL DEFAULT '',
  transform_key TEXT NOT NULL DEFAULT 'plain',
  ref_count INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  media_width INTEGER,
  media_height INTEGER,
  media_duration_seconds INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_content_blobs_sha256 ON content_blobs(sha256);

CREATE TABLE IF NOT EXISTS directories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Cluster-wide row identity (ULID, cluster/identity.ts). Replication ships
  -- `uid`; `id` is node-local and never goes on the wire. NULL only until the
  -- boot backfill has run over a database created before this column existed.
  uid TEXT,
  owner_id INTEGER NOT NULL REFERENCES users(id),
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL DEFAULT 'Untitled folder',
  -- Self-referential tree. NULL = a root-level folder (the only shape that
  -- existed before nesting). At most MAX_DEPTH (10) ancestors, enforced in
  -- directoryTree.ts on create and move.
  parent_directory_id INTEGER REFERENCES directories(id),
  encryption_mode TEXT NOT NULL DEFAULT 'none',
  enc_key_blob BLOB,
  enc_access_blob BLOB,
  -- 1 = the `?ek=` secret sealed in enc_access_blob is a human-chosen password
  -- rather than a random token, so public verification of it has to be rate
  -- limited per slug (security/lockout.ts).
  access_is_password INTEGER NOT NULL DEFAULT 0,
  -- 1 = this folder defines its own key (a "break point"); 0 = it inherits the
  -- nearest overridden ancestor's. A root-level folder is always 1 -- there is
  -- nothing above it to inherit from.
  encryption_overridden INTEGER NOT NULL DEFAULT 1,
  key_check_blob TEXT,
  total_bytes INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT,
  hide_uploader INTEGER NOT NULL DEFAULT 0,
  saved_from_directory_id INTEGER,
  -- Media library ("watch") publication. A folder flagged is_library becomes a
  -- browsable collection whose video/audio children are its playable entries;
  -- a single-video folder published as library_kind='movie' renders as one
  -- title rather than an episode list.
  is_library INTEGER NOT NULL DEFAULT 0,
  -- 'public' (anyone, no login) or 'restricted' (an account holding
  -- can_watch_media, the owner, or a master).
  library_visibility TEXT NOT NULL DEFAULT 'restricted',
  library_kind TEXT NOT NULL DEFAULT 'series',
  library_overview TEXT,
  -- A file in this folder used as cover art; NULL falls back to the first
  -- playable entry's generated thumbnail.
  library_poster_file_id INTEGER,
  library_published_at TEXT,
  -- Presentation of the *public* folder page (/d/:slug) for links pointing at
  -- this folder: 0 = the plain list, 1 = the gallery (poster tiles, inline
  -- players). Purely cosmetic -- it gates nothing, and every read path ignores
  -- it. Unrelated to is_library, which is the global /watch catalog.
  gallery_view INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_directories_slug ON directories(slug);
CREATE INDEX IF NOT EXISTS ix_directories_parent_directory_id ON directories(parent_directory_id);
CREATE INDEX IF NOT EXISTS ix_directories_is_library ON directories(is_library);
CREATE INDEX IF NOT EXISTS ix_directories_owner_id ON directories(owner_id);

CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Cluster-wide row identity (ULID, cluster/identity.ts). Replication ships
  -- `uid`; `id` is node-local and never goes on the wire. NULL only until the
  -- boot backfill has run over a database created before this column existed.
  uid TEXT,
  owner_id INTEGER NOT NULL REFERENCES users(id),
  blob_id INTEGER REFERENCES content_blobs(id),
  directory_id INTEGER REFERENCES directories(id),
  storage_path TEXT NOT NULL,
  original_filename TEXT NOT NULL,
  source_type TEXT NOT NULL DEFAULT 'upload',
  saved_from_file_id INTEGER REFERENCES files(id) ON DELETE SET NULL,
  saved_from_directory_id INTEGER,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  stored_size_bytes INTEGER NOT NULL DEFAULT 0,
  content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  encryption_mode TEXT NOT NULL DEFAULT 'none',
  enc_key_blob BLOB,
  enc_access_blob BLOB,
  -- Same meaning as on directories.
  access_is_password INTEGER NOT NULL DEFAULT 0,
  -- Seal & Forget only: the public PBKDF2 salt for a sealed file whose key was
  -- derived from a chosen password. NULL for a randomly keyed seal. Never a
  -- secret -- the whole point is that the server keeps nothing that opens the
  -- file (crypto/passwordKey.ts).
  seal_salt BLOB,
  -- Same meaning as on directories: 1 = this file holds its own key, 0 = it
  -- inherits its containing folder's chain. 'client' and 'sealed' files are
  -- always 1 -- those keys are never inheritable.
  encryption_overridden INTEGER NOT NULL DEFAULT 1,
  compressed INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  archive_codec TEXT,
  archive_original_stored_size_bytes INTEGER NOT NULL DEFAULT 0,
  archive_saved_bytes INTEGER NOT NULL DEFAULT 0,
  archive_after_idle_days INTEGER,
  lifecycle_state TEXT NOT NULL DEFAULT 'active',
  is_permanent INTEGER NOT NULL DEFAULT 1,
  expires_at TEXT,
  delete_if_idle_days INTEGER,
  auto_unarchive_on_download INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  last_downloaded_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_files_blob_id ON files(blob_id);
CREATE INDEX IF NOT EXISTS ix_files_directory_id ON files(directory_id);
CREATE INDEX IF NOT EXISTS ix_files_owner_id ON files(owner_id);

CREATE TABLE IF NOT EXISTS links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Cluster-wide row identity (ULID, cluster/identity.ts). Replication ships
  -- `uid`; `id` is node-local and never goes on the wire. NULL only until the
  -- boot backfill has run over a database created before this column existed.
  uid TEXT,
  file_id INTEGER NOT NULL REFERENCES files(id),
  slug TEXT NOT NULL UNIQUE,
  max_uses INTEGER,
  use_count INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  hide_uploader INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_links_slug ON links(slug);
CREATE INDEX IF NOT EXISTS ix_links_file_id ON links(file_id);

CREATE TABLE IF NOT EXISTS directory_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Cluster-wide row identity (ULID, cluster/identity.ts). Replication ships
  -- `uid`; `id` is node-local and never goes on the wire. NULL only until the
  -- boot backfill has run over a database created before this column existed.
  uid TEXT,
  directory_id INTEGER NOT NULL REFERENCES directories(id),
  slug TEXT NOT NULL UNIQUE,
  max_uses INTEGER,
  use_count INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  hide_uploader INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_directory_links_slug ON directory_links(slug);
CREATE INDEX IF NOT EXISTS ix_directory_links_directory_id ON directory_links(directory_id);

CREATE TABLE IF NOT EXISTS api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER NOT NULL REFERENCES users(id),
  user_key_number INTEGER NOT NULL DEFAULT 1,
  key_hash TEXT NOT NULL UNIQUE,
  bound_ip TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_api_keys_key_hash ON api_keys(key_hash);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  ip TEXT,
  created_at TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  entry_hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_audit_log_created_at ON audit_log(created_at);

CREATE TABLE IF NOT EXISTS credentials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL,
  secret_blob BLOB,
  webauthn_id TEXT,
  webauthn_public_key BLOB,
  sign_count INTEGER NOT NULL DEFAULT 0,
  label TEXT,
  transports TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_credentials_user_id ON credentials(user_id);

CREATE TABLE IF NOT EXISTS storage_settings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  global_storage_quota_bytes INTEGER NOT NULL DEFAULT 536870912000,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS directory_collaborators (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  directory_id INTEGER NOT NULL REFERENCES directories(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  invited_by_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  role TEXT NOT NULL DEFAULT 'editor',
  created_at TEXT NOT NULL,
  UNIQUE(directory_id, user_id)
);
CREATE INDEX IF NOT EXISTS ix_directory_collaborators_directory_id ON directory_collaborators(directory_id);
CREATE INDEX IF NOT EXISTS ix_directory_collaborators_user_id ON directory_collaborators(user_id);

CREATE TABLE IF NOT EXISTS remote_upload_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER NOT NULL REFERENCES users(id),
  file_id INTEGER REFERENCES files(id) ON DELETE SET NULL,
  url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  error TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_remote_upload_jobs_owner_id ON remote_upload_jobs(owner_id);

CREATE TABLE IF NOT EXISTS torrent_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER NOT NULL REFERENCES users(id),
  -- Where the import *landed*: the folder created for a multi-file torrent.
  directory_id INTEGER REFERENCES directories(id) ON DELETE SET NULL,
  -- Where the requester asked for it to land. A multi-file torrent still gets
  -- its own folder, created underneath this one; a single-file torrent becomes
  -- a plain file inside it. NULL = the root, the original behavior.
  target_directory_id INTEGER REFERENCES directories(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  source TEXT NOT NULL,
  info_hash TEXT,
  tag TEXT NOT NULL UNIQUE,
  save_path TEXT NOT NULL,
  -- 'debrid' (Real-Debrid) or 'qbittorrent' (the fallback backend).
  provider TEXT NOT NULL DEFAULT 'qbittorrent',
  -- Real-Debrid torrent id, when provider = 'debrid'.
  debrid_id TEXT,
  -- Last raw Real-Debrid status string, surfaced in the UI for diagnosis.
  debrid_status TEXT,
  -- Why this job is on qBittorrent despite Real-Debrid being configured.
  fallback_reason TEXT,
  -- 'pending' (accepted, waiting for one of the owner's MAX_ACTIVE_PER_USER
  -- slots -- nothing has been sent to a backend yet) | 'queued' (dispatched,
  -- backend has not reported progress yet) | 'downloading' | 'fetching'
  -- (Real-Debrid transfer leg) | 'importing' | 'seeding' (files imported, the
  -- qBittorrent torrent is still uploading) | 'completed' | 'failed'.
  status TEXT NOT NULL DEFAULT 'queued',
  progress REAL NOT NULL DEFAULT 0,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  downloaded_bytes INTEGER NOT NULL DEFAULT 0,
  dl_speed INTEGER NOT NULL DEFAULT 0,
  eta_seconds INTEGER,
  imported_file_count INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL,
  -- When the job was actually handed to a backend, which is later than
  -- `created_at` for anything that waited in the queue. The poller's
  -- "qBittorrent has never heard of this tag" grace period runs from here --
  -- measured from created_at, an hour in the queue would blow the 3-minute
  -- grace the instant the job started. NULL while pending.
  started_at TEXT,
  -- Live seeding counters, mirrored from qBittorrent while status = 'seeding'
  -- so the UI can show progress toward the retirement limits.
  seed_ratio REAL,
  seed_seconds INTEGER,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_torrent_jobs_owner_id ON torrent_jobs(owner_id);
CREATE INDEX IF NOT EXISTS ix_torrent_jobs_status ON torrent_jobs(status);

CREATE TABLE IF NOT EXISTS dropbox_upload_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER NOT NULL REFERENCES users(id),
  target_directory_id INTEGER REFERENCES directories(id),
  token_hash TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1,
  expires_at TEXT,
  used_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_dropbox_upload_links_owner_id ON dropbox_upload_links(owner_id);
CREATE INDEX IF NOT EXISTS ix_dropbox_upload_links_target_directory_id ON dropbox_upload_links(target_directory_id);
CREATE INDEX IF NOT EXISTS ix_dropbox_upload_links_token_hash ON dropbox_upload_links(token_hash);

-- Playback keys for account-restricted media. The credential the client holds
-- is a *sealed token* (crypto/secretbox.ts, AES-256-GCM under MASTER_KEY_B64)
-- carrying jti/scope/user/expiry/node, so the stream endpoint validates it
-- cryptographically without a lookup. This table is the revocation list that
-- makes an already-issued token killable, plus the record the UI lists.
--
-- Lookup is strict: an unknown jti is rejected. That is what lets the prune
-- job delete rows -- it only ever deletes rows whose `expires_at` has passed,
-- by which point the sealed token is refused on expiry anyway, so a pruned
-- revocation can never resurrect a working key.
--
-- Deliberately NOT replicated (like `sessions`): a key is minted by, used
-- against, and revoked on one node. `node_id` records the minting node so a
-- token presented elsewhere gets a "wrong node" error instead of a bare 401.
CREATE TABLE IF NOT EXISTS media_play_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  jti TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  -- Exactly one of these is set: a key scoped to one file, or to every
  -- playable entry of one published collection.
  file_id INTEGER REFERENCES files(id) ON DELETE CASCADE,
  directory_id INTEGER REFERENCES directories(id) ON DELETE CASCADE,
  label TEXT,
  node_id TEXT NOT NULL DEFAULT '',
  bound_ip TEXT,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_media_play_keys_jti ON media_play_keys(jti);
CREATE INDEX IF NOT EXISTS ix_media_play_keys_user_id ON media_play_keys(user_id);
CREATE INDEX IF NOT EXISTS ix_media_play_keys_expires_at ON media_play_keys(expires_at);

CREATE TABLE IF NOT EXISTS cluster_nodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  token TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  node_id TEXT,
  is_master INTEGER NOT NULL DEFAULT 0,
  archive_enabled INTEGER NOT NULL DEFAULT 1,
  replication_mode TEXT NOT NULL DEFAULT 'full',
  disk_total_bytes INTEGER NOT NULL DEFAULT 0,
  disk_free_bytes INTEGER NOT NULL DEFAULT 0,
  used_bytes INTEGER NOT NULL DEFAULT 0,
  created_by_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL,
  last_seen_at TEXT,
  last_heartbeat_at TEXT,
  -- Derived from the tiering snapshot, not asserted by the peer itself
  -- (S4): 'master' | 'leader' | 'follower'. `epoch` is vestigial -- elections
  -- are gone and nothing reads it; the column survives because SQLite cannot
  -- drop one in place.
  role TEXT NOT NULL DEFAULT 'follower',
  epoch INTEGER NOT NULL DEFAULT 0,
  -- Region membership (§5.2). `region_source` is 'configured' when NODE_REGION
  -- or an operator set it -- which always wins -- and 'inferred' when it came
  -- from RTT clustering.
  region TEXT,
  region_source TEXT NOT NULL DEFAULT 'inferred',
  -- Median heartbeat round-trip to this peer, and observed transfer rate.
  -- rtt_ms feeds region inference; throughput_bps feeds placement and read
  -- source selection (§5.11), never leader choice -- capacity is the leader
  -- score outright (D-4).
  rtt_ms INTEGER,
  throughput_bps INTEGER,
  -- Operator switches. `ineligible` removes a node from leader candidacy
  -- without unlinking it; `pinned_master` overrides the computation entirely.
  ineligible INTEGER NOT NULL DEFAULT 0,
  pinned_master INTEGER NOT NULL DEFAULT 0
);

-- ── tiering (cluster/tiering.ts, redesign §5.3-5.4) ────────────────────────
--
-- `cluster_self_state` used to live here: this node's elected role, its epoch,
-- and the durable one-vote-per-epoch record. All of it is gone. Leadership is
-- no longer voted on; it is a pure function of the membership snapshot below,
-- so every node computes the same answer from the same input and there is no
-- epoch to poison, no quorum over a disagreed set, and no self-asserted role
-- for a peer to lie about. An upgraded database keeps the old table -- SQLite
-- cannot drop it in place and nothing reads it.

CREATE TABLE IF NOT EXISTS cluster_tiering (
  -- Monotonic, and minted by the MASTER only. During a master outage none can
  -- be minted, which is the degraded mode of §5.5 rather than a separate
  -- failure mode to handle.
  generation     INTEGER PRIMARY KEY,
  computed_at    TEXT NOT NULL,
  reason         TEXT NOT NULL,   -- 'bootstrap' | 'manual' | 'drift' | 'promotion'
  master_node_id TEXT NOT NULL,
  snapshot       TEXT NOT NULL,   -- JSON: the node list the computation ran over
  regions        TEXT NOT NULL    -- JSON: region -> { leader, members[] }
);

-- The drift counter (§5.4). One row per node the master has an opinion about,
-- holding what it currently observes and what was last folded into a
-- generation. A re-tier happens when enough of those disagree -- but only
-- after the new status has been HELD for the hold-down window, because a
-- restart is not drift.
CREATE TABLE IF NOT EXISTS cluster_drift (
  node_id                TEXT PRIMARY KEY,
  -- '<up|down|absent>:<master|leader|follower>'. The role half is R-3's answer
  -- to "what counts as a capacity class change": raw disk_total_bytes moves on
  -- every write, so only a capacity change that would alter who leads shows up
  -- as a status change at all.
  status                 TEXT NOT NULL,
  observed_at            TEXT NOT NULL,   -- when this status was first seen (hold-down clock)
  -- What the current generation was computed against. NULL means this node has
  -- never been in a snapshot, which counts as a change immediately -- a join is
  -- not flapping, and an unadmitted node has no upstream.
  settled_status         TEXT,
  settled_at             TEXT
);

-- Local-only cache bookkeeping for REPLICATION_MODE=cache nodes. Deliberately
-- NOT in cluster/replication.ts's REPLICATED_TABLES -- content_blobs rows
-- (the metadata) are replicated everywhere, but whether THIS node physically
-- holds a given blob's bytes right now, and when it last served them, is a
-- per-node fact. Every locally-present blob is tracked here, not just
-- peer-fetched ones -- on a cache-mode node, even a blob that landed here via
-- a direct upload is just the newest cache entry, evictable like any other.
CREATE TABLE IF NOT EXISTS local_blob_cache (
  blob_id INTEGER PRIMARY KEY REFERENCES content_blobs(id) ON DELETE CASCADE,
  last_accessed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cluster_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  origin_node_id TEXT NOT NULL,
  origin_seq INTEGER NOT NULL,
  origin_node_name TEXT,
  ts TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'audit',
  action TEXT NOT NULL,
  actor TEXT NOT NULL,
  target TEXT,
  ip TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(origin_node_id, origin_seq)
);
CREATE INDEX IF NOT EXISTS ix_cluster_events_ts ON cluster_events(ts);
CREATE INDEX IF NOT EXISTS ix_cluster_events_origin_node_id ON cluster_events(origin_node_id);

-- ── the replication change log (cluster/changelog.ts, redesign §5.7) ────────
--
-- Every mutation to a replicated table appends one row here, from a trigger,
-- inside the same transaction as the write itself. That is the whole point: a
-- write that isn't logged has to be impossible rather than merely discouraged,
-- and no call site can forget because no call site is involved.

CREATE TABLE IF NOT EXISTS replication_log (
  -- This node's local stream. Peers cursor on it, and it is also the order
  -- entries are applied in -- see cluster/changelog.ts::applyChanges for why
  -- that ordering is what removes the need for a pending-parent buffer.
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Assigned where the entry lands in the master's log, and only there; NULL
  -- means "this node has written it but the master has not yet ordered it"
  -- (§5.7's provisional state).
  master_seq INTEGER,
  table_name TEXT NOT NULL,
  -- The row's cluster identity (ULID). Never its local `id`.
  row_uid TEXT NOT NULL,
  op TEXT NOT NULL,                 -- 'upsert' | 'delete'
  -- JSON of the replicated columns, `id` excluded. Foreign keys travel as the
  -- parent's uid and BLOBs as uppercase hex; cluster/changelog.ts holds both
  -- maps and is the only thing that reads this.
  payload TEXT,
  -- The master_seq this row was at when the writer changed it. Phase 6 turns
  -- this into optimistic concurrency control; recorded from the start so the
  -- log written before then is still arbitrable.
  base_master_seq INTEGER,
  -- Preserved across every forwarding hop -- an entry relayed by a region
  -- leader still names the node that made the change.
  origin_node TEXT NOT NULL,
  -- The origin's own `seq` for this entry. Filled in by trigger for locally
  -- written rows; carried verbatim for forwarded ones, which is what makes the
  -- UNIQUE below a cluster-wide dedup key rather than a local one.
  origin_seq INTEGER,
  ts TEXT NOT NULL,
  UNIQUE(origin_node, origin_seq)
);
-- base_master_seq's lookup ("what master_seq is this row at?") and the
-- conflict scan Phase 6 adds.
CREATE INDEX IF NOT EXISTS ix_replication_log_row ON replication_log(table_name, row_uid, master_seq);
CREATE INDEX IF NOT EXISTS ix_replication_log_master_seq ON replication_log(master_seq);

-- ── conflict records (cluster/conflicts.ts, redesign §5.8) ─────────────────
--
-- Written by the master alone, because the master alone arbitrates: an edit
-- that arrives with a stale `base_master_seq` is concurrent with one already
-- committed, and the later timestamp wins (node id breaking the tie). The
-- loser is never silently dropped -- it is written here, with enough of the
-- attempt to re-apply it by hand.
--
-- `origin_node`/`origin_seq` identify the *losing* edit and are UNIQUE
-- together: an entry re-delivered because a peer's cursor slipped must not
-- record the same conflict twice, and that dedup is also what stops the
-- master restating the winner on every redelivery.
CREATE TABLE IF NOT EXISTS replication_conflicts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  table_name TEXT NOT NULL,
  row_uid TEXT NOT NULL,
  -- 'upsert' | 'delete' -- a delete carries no payload, and an admin looking
  -- at the row still needs to know that is what lost.
  losing_op TEXT NOT NULL DEFAULT 'upsert',
  losing_payload TEXT NOT NULL,
  losing_ts TEXT NOT NULL,
  winning_master_seq INTEGER NOT NULL,
  winning_ts TEXT NOT NULL,
  origin_node TEXT NOT NULL,        -- who wrote the losing edit
  winner_node TEXT NOT NULL,        -- who wrote the winning one
  -- The losing entry's seq in its own origin's log. Whichever edit lost, it
  -- was a real log entry somewhere, so this identifies it either way.
  origin_seq INTEGER,
  detected_at TEXT NOT NULL,
  dismissed_at TEXT,
  UNIQUE(origin_node, origin_seq)
);
CREATE INDEX IF NOT EXISTS ix_replication_conflicts_open
  ON replication_conflicts(dismissed_at, id);

CREATE TABLE IF NOT EXISTS replication_cursors (
  peer_node_id TEXT NOT NULL,
  direction    TEXT NOT NULL,       -- 'up' (from a child) | 'down' (from the parent)
  seq          INTEGER NOT NULL,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (peer_node_id, direction)
);

-- One row, read by every changelog trigger.
--
-- `node_id` is this node's identity, needed inside a trigger where no
-- application state is reachable. It stays empty until createAppState sets it,
-- and the triggers refuse to log while it is -- which is deliberate: the uid
-- backfill runs during database open, before the node has an identity, and
-- minting a uid is not a change worth replicating.
--
-- `suppressed` is raised while applying a peer's entries, so an applied change
-- is not re-logged as if this node had originated it, and lowered again
-- immediately. It is also raised for the uid mint inside the insert trigger,
-- because a trigger's own statements do fire other triggers (SQLite's
-- recursive_triggers pragma governs self-recursion only).
CREATE TABLE IF NOT EXISTS replication_control (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  node_id TEXT NOT NULL DEFAULT '',
  suppressed INTEGER NOT NULL DEFAULT 0,
  -- Whether this node is the master, mirrored here by cluster/tiering.ts on
  -- every generation change. It lives in this table rather than being looked
  -- up because the log-fixup trigger needs it, and a trigger cannot reach
  -- application state -- only other tables.
  is_master INTEGER NOT NULL DEFAULT 0
);

-- ── quota reservations (cluster/quota.ts, redesign §5.9) ───────────────────
--
-- The master's ledger of writes that have been ADMITTED but whose file rows do
-- not exist yet. Without it, two nodes each read SUM(files.size_bytes) = 0,
-- each admit a 10 GB upload against a 15 GB quota, and the change log honestly
-- converges on 20 GB: quota is the one number that cannot be reconciled after
-- the fact, which is why D-1 makes it master-authoritative and synchronous.
--
-- The unit is LOGICAL quota bytes (D-17) -- SUM(files.size_bytes) against
-- permissions.quota_bytes -- so every path that creates a files row reserves,
-- including the ones that create no new bytes at all (save, copy). Dedup
-- savings are the system's, not the user's.
--
-- `user_uid`, not a local user id: ids are node-local and never cross the wire.
--
-- Node-local and deliberately absent from CHANGELOG_TABLES. It is the master's
-- own working state, not cluster state -- a follower has no use for it, and
-- replicating it would put a write on the master's hot path for every
-- reservation. The cost is that a leadership handover drops whatever is
-- outstanding, so the new master can over-admit by at most the in-flight set
-- for one window; a handover is a deliberate, rare, operator-visible act and
-- that is a better trade than replicating a table that changes this often.
CREATE TABLE IF NOT EXISTS quota_reservations (
  uid            TEXT PRIMARY KEY,
  user_uid       TEXT NOT NULL,
  bytes          INTEGER NOT NULL,
  -- Which node asked, for the admin view and for releasing a dead node's
  -- reservations wholesale.
  node_id        TEXT NOT NULL,
  kind           TEXT NOT NULL,   -- 'upload' | 'save' | 'copy' | 'torrent' | 'remote'
  state          TEXT NOT NULL,   -- 'open' | 'committed' | 'released' | 'expired'
  created_at     TEXT NOT NULL,
  -- The sliding-TTL clock (D-16). `expires_at` is an INACTIVITY window, not a
  -- ceiling on how long a transfer may take: a chunk commit, the idle
  -- keepalive, or the periodic tick all push it forward. Expiry therefore means
  -- "nobody has touched this for a full window", which is the only condition
  -- under which releasing the bytes is safe.
  renewed_at     TEXT NOT NULL,
  expires_at     TEXT NOT NULL,
  committed_bytes INTEGER
);
CREATE INDEX IF NOT EXISTS ix_quota_reservations_user
  ON quota_reservations(user_uid, state);
CREATE INDEX IF NOT EXISTS ix_quota_reservations_expiry
  ON quota_reservations(state, expires_at);

-- OAuth 2.0 authorization-server tables (security/oauth.ts, routes/oauth.ts).
-- Deliberately absent from cluster/replication.ts's REPLICATED_TABLES: like
-- sessions and media_play_keys, an issued token is a node-local credential and
-- a registered app is node-local config. Registering an app on one node does
-- not make it usable against a peer.
CREATE TABLE IF NOT EXISTS oauth_clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id TEXT NOT NULL UNIQUE,
  -- NULL = public client; those MUST use PKCE (there is no secret to prove with).
  client_secret_hash TEXT,
  name TEXT NOT NULL,
  owner_id INTEGER NOT NULL REFERENCES users(id),
  -- Newline-separated, compared by exact string match -- never by prefix.
  redirect_uris TEXT NOT NULL,
  -- Space-separated ceiling: the most this app may ever be granted.
  scopes TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_oauth_clients_client_id ON oauth_clients(client_id);
CREATE INDEX IF NOT EXISTS ix_oauth_clients_owner_id ON oauth_clients(owner_id);

CREATE TABLE IF NOT EXISTS oauth_auth_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code_hash TEXT NOT NULL UNIQUE,
  client_id TEXT NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id),
  redirect_uri TEXT NOT NULL,
  scope TEXT NOT NULL,
  code_challenge TEXT,
  code_challenge_method TEXT,
  -- Ties the code to the tokens minted from it, so replaying a consumed code
  -- can revoke the whole grant rather than just failing.
  grant_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_oauth_auth_codes_code_hash ON oauth_auth_codes(code_hash);
CREATE INDEX IF NOT EXISTS ix_oauth_auth_codes_expires_at ON oauth_auth_codes(expires_at);

CREATE TABLE IF NOT EXISTS oauth_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  client_id TEXT NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id),
  scope TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_oauth_tokens_token_hash ON oauth_tokens(token_hash);
CREATE INDEX IF NOT EXISTS ix_oauth_tokens_grant_id ON oauth_tokens(grant_id);
CREATE INDEX IF NOT EXISTS ix_oauth_tokens_user_id ON oauth_tokens(user_id);

-- Cluster-wide row identity (cluster/identity.ts, redesign §5.6). UNIQUE and
-- nullable together: SQLite permits any number of NULLs in a unique index, so
-- these are safe to create before the boot backfill has minted uids for a
-- database that predates the column -- while still making a duplicate uid
-- impossible from the moment it exists.
CREATE UNIQUE INDEX IF NOT EXISTS ux_users_uid ON users(uid);
CREATE UNIQUE INDEX IF NOT EXISTS ux_permissions_uid ON permissions(uid);
CREATE UNIQUE INDEX IF NOT EXISTS ux_content_blobs_uid ON content_blobs(uid);
CREATE UNIQUE INDEX IF NOT EXISTS ux_directories_uid ON directories(uid);
CREATE UNIQUE INDEX IF NOT EXISTS ux_directory_links_uid ON directory_links(uid);
CREATE UNIQUE INDEX IF NOT EXISTS ux_files_uid ON files(uid);
CREATE UNIQUE INDEX IF NOT EXISTS ux_links_uid ON links(uid);
