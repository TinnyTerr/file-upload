import type { EncMode } from "../../lib/keys";

export interface AdminUser {
  id: number;
  username: string;
  role: string;
  created_at: string;
  must_change_credentials?: boolean;
  permissions?: Record<string, boolean | number | null>;
}

export interface AdminLink {
  id: number;
  slug: string;
  active: boolean;
  max_uses: number | null;
  use_count: number;
  expires_at: string | null;
}

export interface AdminFile {
  id: number;
  owner_id: number;
  original_filename: string;
  content_type: string;
  size_bytes: number;
  stored_size_bytes?: number;
  created_at: string;
  encryption_mode: EncMode;
  access_key?: string;
  compressed?: boolean;
  archived?: boolean;
  last_downloaded_at?: string | null;
  links: AdminLink[];
}

export interface AdminDir {
  id: number;
  owner_id: number;
  title: string;
  slug?: string;
  url?: string;
  file_count: number;
  total_bytes: number;
  created_at: string;
  encryption_mode: EncMode;
  access_key?: string;
}

export interface AdminKey {
  id: number;
  owner_id: number;
  owner_username?: string;
  user_key_number?: number;
  bound_ip?: string | null;
  active: boolean;
  created_at: string;
  last_used_at?: string | null;
}

export interface AuditEntry {
  id: number;
  actor: string;
  action: string;
  target?: string | null;
  ip?: string | null;
  created_at: string;
}

export interface BackendLogEntry {
  level?: string;
  logger?: string;
  module?: string;
  function?: string;
  line?: number;
  message?: string;
  created_at: string;
}

export interface Selection {
  files: Set<number>;
  directories: Set<number>;
  keys: Set<number>;
}
