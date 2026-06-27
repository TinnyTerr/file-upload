import type { EncMode } from "../../lib/keys";

export interface LinkObj {
  id: number;
  slug: string;
  active: boolean;
  max_uses: number | null;
  use_count: number;
  expires_at: string | null;
}

export interface FileObj {
  id: number;
  original_filename: string;
  content_type: string;
  size_bytes: number;
  created_at: string;
  encryption_mode: EncMode;
  access_key?: string;
  compressed?: boolean;
  owner_id?: number;
  links: LinkObj[];
}

export interface DirObj {
  id: number;
  title: string;
  url: string;
  slug?: string;
  file_count: number;
  total_bytes: number;
  encryption_mode: EncMode;
  access_key?: string;
  owner_id?: number;
}

export interface DirMember {
  id: number;
  filename: string;
  size_bytes: number;
}

export interface Permissions {
  canRegenerateLinks: boolean;
  canUseApiKeys: boolean;
  canDeleteFiles: boolean;
  canDeleteLinks: boolean;
  canCreateDirectories: boolean;
  canUploadClientEncrypted: boolean;
}

export interface ApiKeyObj {
  id: number;
  user_key_number?: number;
  bound_ip?: string | null;
  active: boolean;
  created_at: string;
  last_used_at?: string | null;
}
