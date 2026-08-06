/** `pending` is waiting for one of the owner's concurrency slots — accepted,
 * but not handed to any backend yet. `fetching` is the Real-Debrid-only leg
 * where the torrent is finished on Real-Debrid's side and this server is
 * pulling the files over HTTPS. `seeding` is qBittorrent-only and comes
 * *after* the files are imported: the download is done and in the user's
 * storage, the torrent is just still uploading. */
export type TorrentStatus =
	| "pending"
	| "queued"
	| "downloading"
	| "fetching"
	| "importing"
	| "seeding"
	| "completed"
	| "failed";

export type TorrentProvider = "debrid" | "qbittorrent";

export interface TorrentJob {
	id: number;
	name: string;
	status: TorrentStatus;
	/** Which backend is handling this job. Null while `pending` — nothing has
	 * been dispatched, so the choice hasn't been made. */
	provider: TorrentProvider | null;
	/** 1-based place in this owner's queue, or null when not `pending`. */
	queue_position: number | null;
	/** Share ratio and seconds seeded, mirrored from qBittorrent while seeding. */
	seed_ratio: number | null;
	seed_seconds: number | null;
	/** When the job reached a backend; null while queued. */
	started_at: string | null;
	/** Raw Real-Debrid status ("magnet_conversion", "downloaded", …), debrid only. */
	debrid_status: string | null;
	/** Set when Real-Debrid was configured but the job ran on qBittorrent anyway. */
	fallback_reason: string | null;
	/** 0..1. Covers the torrent download, then the transfer to this server. */
	progress: number;
	size_bytes: number;
	downloaded_bytes: number;
	dl_speed: number;
	eta_seconds: number | null;
	info_hash: string | null;
	/** Where the import landed. */
	directory_id: number | null;
	/** Where it was asked to land. */
	target_directory_id: number | null;
	imported_file_count: number;
	error: string | null;
	created_at: string;
	updated_at: string;
	completed_at: string | null;
}

export interface TorrentConfig {
	/** True when *any* backend is available (Real-Debrid or qBittorrent). */
	configured: boolean;
	/** True when Real-Debrid holds a valid-looking token and is switched on. */
	debrid_enabled: boolean;
	qbittorrent_configured: boolean;
	save_path: string;
	/** Concurrent downloads per user. Beyond this, submissions queue. */
	max_active_per_user: number;
	/** How deep that queue may get before a submission is actually refused. */
	max_queued_per_user: number;
	/** Whether finished qBittorrent torrents keep seeding. */
	seeding: boolean;
	/** Retirement limits; 0 means that limit is off. */
	seed_ratio: number;
	seed_minutes: number;
}

/** The `seeding` block of GET /admin/torrents/status. */
export interface SeedingStatus {
	enabled: boolean;
	/** Enabled *and* qBittorrent is configured — i.e. anything can actually seed. */
	active: boolean;
	ratio: number;
	minutes: number;
	seeding_count: number;
}

/** PUT /admin/torrents/seeding — omit a field to leave it unchanged. */
export interface SeedingSettingsInput {
	enabled?: boolean;
	/** 0 disables the ratio limit. */
	ratio?: number;
	/** 0 disables the time limit. */
	minutes?: number;
}

export interface AdminTorrentJob extends TorrentJob {
	owner_id: number;
	owner_username: string;
}

/** The `debrid` block of GET /admin/torrents/status. */
export interface DebridStatus {
	/** A token is installed (regardless of the enable toggle). */
	configured: boolean;
	enabled: boolean;
	/** Installed *and* enabled — i.e. debrid is the live backend. */
	active: boolean;
	api_key_hint: string | null;
	connected?: boolean;
	invalid_key?: boolean;
	username?: string;
	account_type?: string;
	premium_seconds?: number;
	expiration?: string | null;
	points?: number | null;
	warning?: string | null;
	detail?: string;
}

/** GET /admin/torrents/status — backend reachability for both providers. */
export interface TorrentHostStatus {
	configured: boolean;
	connected?: boolean;
	version?: string;
	url?: string;
	save_path?: string;
	content_path?: string;
	detail?: string;
	debrid: DebridStatus;
	seeding: SeedingStatus;
}

export interface AddTorrentInput {
	magnet?: string;
	/** Base64-encoded .torrent metainfo file. */
	torrent_file_b64?: string;
	filename?: string;
	/** Destination folder. A multi-file torrent still gets its own folder,
	 * created underneath this one. Omitted = the root. */
	directory_id?: number | null;
}

/** PUT /admin/torrents/debrid — omit a field to leave it unchanged. */
export interface DebridSettingsInput {
	/** Empty string clears the installed token. */
	api_key?: string;
	enabled?: boolean;
}
