export interface ClusterNode {
  id: number;
  /** Stable cluster identity of the remote node (null until it has joined). */
  node_id: string | null;
  name: string;
  base_url: string;
  /** Masked form of the remote token, e.g. ••••a1b2. The full token is never returned. */
  token_preview: string;
  active: boolean;
  is_master: boolean;
  archive_enabled: boolean;
  replication_mode: string;
  disk_total_bytes: number;
  disk_free_bytes: number;
  used_bytes: number;
  created_at: string | null;
  last_seen_at: string | null;
  last_heartbeat_at: string | null;
}

export interface NewClusterNode {
  name: string;
  base_url: string;
  token: string;
}

export interface ClusterHalt {
  scope: string;
  until: number;
}

export interface ClusterSelf {
  node_id: string;
  name: string;
  role: string;
  node_url: string;
  is_master: boolean;
  archive_enabled: boolean;
  replication_mode: string;
  disk_total_bytes: number;
  disk_free_bytes: number;
  used_bytes: number;
  halts: ClusterHalt[];
}
