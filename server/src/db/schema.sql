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
  status TEXT NOT NULL DEFAULT 'queued',
  progress REAL NOT NULL DEFAULT 0,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  downloaded_bytes INTEGER NOT NULL DEFAULT 0,
  dl_speed INTEGER NOT NULL DEFAULT 0,
  eta_seconds INTEGER,
  imported_file_count INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL,
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
  role TEXT NOT NULL DEFAULT 'follower',
  epoch INTEGER NOT NULL DEFAULT 0
);

-- Singleton row (id=1) holding THIS node's own election state: elected,
-- epoch-versioned leadership layered under the existing full-mesh
-- reserve/replicate/export protocol. `role`/`epoch` are this node's live
-- view of itself; `voted_epoch`/`voted_for` enforce "one vote per epoch"
-- durably (must survive a crash between granting a vote and a restart, or a
-- rejoin could double-vote and produce two masters at the same epoch).
CREATE TABLE IF NOT EXISTS cluster_self_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  role TEXT NOT NULL DEFAULT 'follower',
  epoch INTEGER NOT NULL DEFAULT 0,
  voted_epoch INTEGER NOT NULL DEFAULT 0,
  voted_for TEXT,
  current_master_id TEXT,
  current_master_url TEXT,
  last_master_contact_at TEXT,
  updated_at TEXT NOT NULL
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
  suppressed INTEGER NOT NULL DEFAULT 0
);

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
