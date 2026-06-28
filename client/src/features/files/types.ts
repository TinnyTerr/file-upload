export type EncryptionMode = "none" | "server" | "client";

export interface FileLink {
  id: number;
  slug: string;
  max_uses: number | null;
  use_count: number;
  expires_at: string | null;
  active: boolean;
}

/** A loose file as returned by GET /files/ (and /admin/files). */
export interface FileObject {
  id: number;
  owner_id: number;
  original_filename: string;
  source_type: string;
  saved_from_file_id: number | null;
  size_bytes: number;
  stored_size_bytes: number;
  hashes: Record<string, string> | null;
  content_type: string | null;
  encryption_mode: EncryptionMode;
  compressed: boolean;
  archived: boolean;
  lifecycle_state: string | null;
  is_permanent: boolean;
  expires_at: string | null;
  last_downloaded_at: string | null;
  access_key: string | null;
  created_at: string;
  links: FileLink[];
}

export interface Usage {
  used_bytes: number;
  quota_bytes: number;
  max_file_bytes: number;
}

/** Per-file upload options shared by single + chunked + folder uploads. */
export interface UploadOptions {
  encryption_mode: EncryptionMode;
  max_uses?: number | null;
  expires_in_seconds?: number | null;
  compress?: boolean;
  randomize_filename?: boolean;
  // Lifecycle (requires can_manage_lifecycle)
  is_permanent?: boolean;
  temp_days?: number | null;
  delete_if_idle_days?: number | null;
  archive_after_idle_days?: number | null;
  directory_id?: number | null;
}

/** Response from any successful upload (single, chunked, remote). */
export interface UploadResult {
  file_id: number;
  slug: string;
  url: string;
  raw_url: string;
  access_key: string | null;
  encryption_mode: EncryptionMode;
  max_uses: number | null;
  expires_at: string | null;
  compressed: boolean;
  source_type: string;
  saved_from_file_id: number | null;
}

export interface MintLinkResult {
  slug: string;
  url: string;
  raw_url: string;
  encryption_mode: EncryptionMode;
  access_key: string | null;
}
