export type TorrentStatus = "queued" | "downloading" | "importing" | "completed" | "failed";

export interface TorrentJob {
  id: number;
  name: string;
  status: TorrentStatus;
  /** 0..1 as reported by qBittorrent. */
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
  configured: boolean;
  save_path: string;
  max_active_per_user: number;
}

export interface AdminTorrentJob extends TorrentJob {
  owner_id: number;
  owner_username: string;
}

/** GET /admin/torrents/status — host qBittorrent reachability. */
export interface TorrentHostStatus {
  configured: boolean;
  connected?: boolean;
  version?: string;
  url?: string;
  save_path?: string;
  content_path?: string;
  detail?: string;
}

export interface AddTorrentInput {
  magnet?: string;
  /** Base64-encoded .torrent metainfo file. */
  torrent_file_b64?: string;
  filename?: string;
}
