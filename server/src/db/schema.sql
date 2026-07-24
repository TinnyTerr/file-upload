-- Full schema for the Bun+Express rewrite, mirroring app/models/*.py.
-- All timestamps stored as ISO8601 UTC strings (equivalent to UTCDateTime).
-- No migration framework -- additive changes only (CLAUDE.md convention).

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
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
  user_agent TEXT
);

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
  owner_id INTEGER NOT NULL REFERENCES users(id),
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL DEFAULT 'Untitled folder',
  encryption_mode TEXT NOT NULL DEFAULT 'none',
  enc_key_blob BLOB,
  enc_access_blob BLOB,
  key_check_blob TEXT,
  total_bytes INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT,
  hide_uploader INTEGER NOT NULL DEFAULT 0,
  saved_from_directory_id INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_directories_slug ON directories(slug);

CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
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

CREATE TABLE IF NOT EXISTS links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
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

CREATE TABLE IF NOT EXISTS directory_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
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
