export interface ClusterNode {
  id: number;
  name: string;
  base_url: string;
  /** Masked form of the remote token, e.g. ••••a1b2. The full token is never returned. */
  token_preview: string;
  active: boolean;
  created_at: string | null;
  last_seen_at: string | null;
}

export interface NewClusterNode {
  name: string;
  base_url: string;
  token: string;
}
