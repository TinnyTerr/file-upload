/** Shared row shapes for schema.sql tables (SQLite: booleans are 0/1 ints,
 * timestamps ISO8601 UTC strings). Only tables used by multiple route files
 * live here; single-use shapes stay local to their route. */

export interface UserRow {
	id: number;
	/** Cluster-wide identity (cluster/identity.ts). NULL only on a row that
	 * predates the boot backfill. */
	uid: string | null;
	username: string;
	password_hash: string;
	role: string;
	must_change_credentials: number;
	avatar_data: Uint8Array | null;
	avatar_content_type: string | null;
	mfa_required: number;
	webauthn_user_handle: string | null;
	created_at: string;
}

export interface CredentialRow {
	id: number;
	user_id: number;
	kind: string;
	secret_blob: Uint8Array | null;
	webauthn_id: string | null;
	webauthn_public_key: Uint8Array | null;
	sign_count: number;
	label: string | null;
	transports: string | null;
	created_at: string;
	updated_at: string | null;
}

export interface PermissionRow {
	id: number;
	/** Cluster-wide identity (cluster/identity.ts). NULL only on a row that
	 * predates the boot backfill. */
	uid: string | null;
	user_id: number;
	can_upload: number;
	can_upload_client_encrypted: number;
	can_delete: number;
	can_regenerate_links: number;
	can_delete_links: number;
	can_create_directories: number;
	can_manage_lifecycle: number;
	can_use_api_keys: number;
	can_view_admin: number;
	can_manage_users: number;
	can_manage_storage: number;
	can_manage_api_keys: number;
	can_manage_cluster: number;
	can_use_torrents: number;
	can_watch_media: number;
	require_mfa: number;
	require_passkey: number;
	quota_bytes: number;
	max_file_bytes: number;
	archive_after_idle_days: number;
	created_at: string;
}

export interface ContentBlobRow {
	id: number;
	/** Cluster-wide identity (cluster/identity.ts). NULL only on a row that
	 * predates the boot backfill. */
	uid: string | null;
	storage_path: string;
	content_type: string;
	size_bytes: number;
	stored_size_bytes: number;
	sha256: string;
	sha1: string;
	md5: string;
	blake2b: string;
	stored_sha256: string;
	transform_key: string;
	ref_count: number;
	archived: number;
	media_width: number | null;
	media_height: number | null;
	media_duration_seconds: number | null;
	created_at: string;
}

export interface FileRow {
	id: number;
	/** Cluster-wide identity (cluster/identity.ts). NULL only on a row that
	 * predates the boot backfill. */
	uid: string | null;
	owner_id: number;
	blob_id: number | null;
	directory_id: number | null;
	storage_path: string;
	original_filename: string;
	source_type: string;
	saved_from_file_id: number | null;
	saved_from_directory_id: number | null;
	size_bytes: number;
	stored_size_bytes: number;
	content_type: string;
	encryption_mode: string;
	enc_key_blob: Uint8Array | null;
	enc_access_blob: Uint8Array | null;
	access_is_password: number;
	seal_salt: Uint8Array | null;
	encryption_overridden: number;
	compressed: number;
	archived: number;
	archive_codec: string | null;
	archive_original_stored_size_bytes: number;
	archive_saved_bytes: number;
	archive_after_idle_days: number | null;
	lifecycle_state: string;
	is_permanent: number;
	expires_at: string | null;
	delete_if_idle_days: number | null;
	auto_unarchive_on_download: number;
	created_at: string;
	last_downloaded_at: string | null;
}

export interface DirectoryRow {
	id: number;
	/** Cluster-wide identity (cluster/identity.ts). NULL only on a row that
	 * predates the boot backfill. */
	uid: string | null;
	owner_id: number;
	slug: string;
	title: string;
	parent_directory_id: number | null;
	encryption_mode: string;
	enc_key_blob: Uint8Array | null;
	enc_access_blob: Uint8Array | null;
	access_is_password: number;
	encryption_overridden: number;
	key_check_blob: string | null;
	total_bytes: number;
	expires_at: string | null;
	hide_uploader: number;
	saved_from_directory_id: number | null;
	is_library: number;
	library_visibility: string;
	library_kind: string;
	library_overview: string | null;
	library_poster_file_id: number | null;
	library_published_at: string | null;
	gallery_view: number;
	created_at: string;
}

export interface MediaPlayKeyRow {
	id: number;
	jti: string;
	user_id: number;
	file_id: number | null;
	directory_id: number | null;
	label: string | null;
	node_id: string;
	bound_ip: string | null;
	expires_at: string;
	revoked_at: string | null;
	created_at: string;
	last_used_at: string | null;
}

export interface LinkRow {
	id: number;
	/** Cluster-wide identity (cluster/identity.ts). NULL only on a row that
	 * predates the boot backfill. */
	uid: string | null;
	file_id: number;
	slug: string;
	max_uses: number | null;
	use_count: number;
	expires_at: string | null;
	active: number;
	hide_uploader: number;
	created_at: string;
}

export interface DirectoryLinkRow {
	id: number;
	/** Cluster-wide identity (cluster/identity.ts). NULL only on a row that
	 * predates the boot backfill. */
	uid: string | null;
	directory_id: number;
	slug: string;
	max_uses: number | null;
	use_count: number;
	expires_at: string | null;
	active: number;
	hide_uploader: number;
	created_at: string;
}

export interface ApiKeyRow {
	id: number;
	owner_id: number;
	user_key_number: number;
	key_hash: string;
	bound_ip: string | null;
	active: number;
	created_at: string;
	last_used_at: string | null;
}

export interface OauthClientRow {
	id: number;
	client_id: string;
	/** NULL for public clients, which must use PKCE instead. */
	client_secret_hash: string | null;
	name: string;
	owner_id: number;
	/** Newline-separated; matched exactly, never by prefix. */
	redirect_uris: string;
	/** Space-separated ceiling on what this app may be granted. */
	scopes: string;
	active: number;
	created_at: string;
}

export interface OauthAuthCodeRow {
	id: number;
	code_hash: string;
	client_id: string;
	user_id: number;
	redirect_uri: string;
	scope: string;
	code_challenge: string | null;
	code_challenge_method: string | null;
	grant_id: string;
	expires_at: string;
	consumed_at: string | null;
	created_at: string;
}

export interface OauthTokenRow {
	id: number;
	token_hash: string;
	kind: "access" | "refresh";
	client_id: string;
	user_id: number;
	scope: string;
	grant_id: string;
	expires_at: string;
	revoked_at: string | null;
	created_at: string;
	last_used_at: string | null;
}

export interface DropboxLinkRow {
	id: number;
	owner_id: number;
	target_directory_id: number | null;
	token_hash: string;
	active: number;
	expires_at: string | null;
	used_at: string | null;
	created_at: string;
}

export interface AuditLogRow {
	id: number;
	actor: string;
	action: string;
	target: string | null;
	ip: string | null;
	created_at: string;
	prev_hash: string;
	entry_hash: string;
}

export interface StorageSettingsRow {
	id: number;
	global_storage_quota_bytes: number;
	created_at: string;
	updated_at: string;
}

export interface RemoteUploadJobRow {
	id: number;
	owner_id: number;
	file_id: number | null;
	url: string;
	status: string;
	error: string | null;
	created_at: string;
	completed_at: string | null;
}

export interface TorrentJobRow {
	id: number;
	owner_id: number;
	/** Where the import landed (the folder created for a multi-file torrent). */
	directory_id: number | null;
	/** Where the requester asked for it to land. NULL = the root. */
	target_directory_id: number | null;
	name: string;
	source: string;
	info_hash: string | null;
	/** Per-job tag ("fu-<random>"). How a qBittorrent job finds its torrent
	 * again, and the per-job download directory name for both providers. */
	tag: string;
	save_path: string;
	/** 'debrid' (Real-Debrid) | 'qbittorrent' (fallback). */
	provider: string;
	/** Real-Debrid torrent id, when provider = 'debrid'. */
	debrid_id: string | null;
	/** Last raw Real-Debrid status ("magnet_conversion", "downloaded", ...). */
	debrid_status: string | null;
	/** Why the job landed on qBittorrent while Real-Debrid was configured. */
	fallback_reason: string | null;
	/** pending | queued | downloading | fetching | importing | seeding |
	 * completed | failed. `pending` has not been sent to any backend yet;
	 * `seeding` has already imported and is only still uploading. */
	status: string;
	progress: number;
	size_bytes: number;
	downloaded_bytes: number;
	dl_speed: number;
	eta_seconds: number | null;
	imported_file_count: number;
	error: string | null;
	created_at: string;
	/** When the job reached a backend. NULL while pending, and NULL on rows
	 * that predate the queue (they were dispatched at creation). */
	started_at: string | null;
	/** Mirrored from qBittorrent while seeding. */
	seed_ratio: number | null;
	seed_seconds: number | null;
	updated_at: string;
	completed_at: string | null;
}

export interface ClusterNodeRow {
	id: number;
	name: string;
	base_url: string;
	token: string;
	active: number;
	node_id: string | null;
	is_master: number;
	archive_enabled: number;
	replication_mode: string;
	disk_total_bytes: number;
	disk_free_bytes: number;
	used_bytes: number;
	created_by_id: number | null;
	created_at: string;
	last_seen_at: string | null;
	last_heartbeat_at: string | null;
	/** Derived from the tiering snapshot (cluster/tiering.ts), never asserted by
	 * the peer itself: 'master' | 'leader' | 'follower'. */
	role: string;
	/** Vestigial -- elections are gone and nothing reads it. SQLite cannot drop
	 * a column in place, so it stays at its default. */
	epoch: number;
	region: string | null;
	region_source: string;
	rtt_ms: number | null;
	throughput_bps: number | null;
	ineligible: number;
	pinned_master: number;
}

export interface ClusterTieringRow {
	generation: number;
	computed_at: string;
	reason: string;
	master_node_id: string;
	/** JSON `TieringMember[]`. */
	snapshot: string;
	/** JSON `Record<string, RegionPlan>`. */
	regions: string;
}

export interface QuotaReservationRow {
	uid: string;
	user_uid: string;
	bytes: number;
	node_id: string;
	kind: string;
	state: string;
	created_at: string;
	renewed_at: string;
	expires_at: string;
	committed_bytes: number | null;
}

/** One arbitrated edit that lost (§5.8). Written on the master only. */
export interface ReplicationConflictRow {
	id: number;
	table_name: string;
	row_uid: string;
	losing_op: string;
	/** JSON of the losing edit's replicated columns; `"null"` for a delete. */
	losing_payload: string;
	losing_ts: string;
	winning_master_seq: number;
	winning_ts: string;
	origin_node: string;
	winner_node: string;
	origin_seq: number | null;
	detected_at: string;
	dismissed_at: string | null;
}

export interface ClusterDriftRow {
	node_id: string;
	/** `'<up|down|absent>:<master|leader|follower>'` -- see
	 * cluster/tiering.ts::observedStatus. */
	status: string;
	observed_at: string;
	settled_status: string | null;
	settled_at: string | null;
}

export interface ClusterEventRow {
	id: number;
	origin_node_id: string;
	origin_seq: number;
	origin_node_name: string | null;
	ts: string;
	kind: string;
	action: string;
	actor: string;
	target: string | null;
	ip: string | null;
	created_at: string;
}

export function nowIso(): string {
	return new Date().toISOString();
}
