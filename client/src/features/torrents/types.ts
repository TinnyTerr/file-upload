/** `fetching` is the Real-Debrid-only leg where the torrent is finished on
 * Real-Debrid's side and this server is pulling the files over HTTPS. */
export type TorrentStatus = "queued" | "downloading" | "fetching" | "importing" | "completed" | "failed";

export type TorrentProvider = "debrid" | "qbittorrent";

export interface TorrentJob {
  id: number;
  name: string;
  status: TorrentStatus;
  /** Which backend is handling this job. */
  provider: TorrentProvider;
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
  directory_id: number | null;
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
  max_active_per_user: number;
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
}

export interface AddTorrentInput {
  magnet?: string;
  /** Base64-encoded .torrent metainfo file. */
  torrent_file_b64?: string;
  filename?: string;
}

/** PUT /admin/torrents/debrid — omit a field to leave it unchanged. */
export interface DebridSettingsInput {
  /** Empty string clears the installed token. */
  api_key?: string;
  enabled?: boolean;
}
