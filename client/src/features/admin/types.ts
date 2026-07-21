import type { PermissionFlag } from "@/config/permissions";
import type { Role } from "@/features/account/types";

export interface DiskStats {
  total_bytes: number;
  total_files: number;
  total_links: number;
  total_users: number;
}

export interface StorageUserRow {
  id: number;
  username: string;
  role: Role;
  used_bytes: number;
  quota_bytes: number | null;
  quota_percent: number | null;
  file_count: number;
  link_count: number;
  api_key_count: number;
}

export interface StorageDetails {
  global_storage_quota_bytes: number;
  used_bytes: number;
  allocated_quota_bytes: number;
  storage_summary: {
    used_percent: number;
    allocated_percent: number;
    free_under_cap_bytes: number;
    unallocated_quota_bytes: number;
  };
  disk: { total_bytes: number; used_bytes: number; free_bytes: number };
  total_files: number;
  total_links: number;
  active_links: number;
  total_api_keys: number;
  users: StorageUserRow[];
  lifecycle_counts: Record<string, number>;
  content_type_counts: { content_type: string; count: number; stored_bytes: number; size_bytes: number }[];
  link_status_counts: Record<string, number>;
  api_key_status_counts: Record<string, number>;
  recent_audit_counts: { action: string; count: number }[];
  fun_stats: {
    dedup_saved_bytes: number;
    archive_saved_bytes: number;
    top_downloaded_files: { id: number; filename: string; owner_id: number; downloads: number }[];
    biggest_files: { id: number; filename: string; owner_id: number; size_bytes: number; stored_size_bytes: number }[];
    top_storage_users: StorageUserRow[];
    source_type_counts: Record<string, number>;
    file_type_counts: Record<string, { count: number; bytes: number; stored_bytes: number }>;
    remote_upload_counts: Record<string, number>;
    dropbox_upload_count: number;
    remote_upload_count: number;
    collaborator_count: number;
    busiest_directories: { id: number; title: string; owner_id: number; file_count: number; total_bytes: number }[];
  };
}

export type UserPermissions = Record<PermissionFlag, boolean> & {
  quota_bytes: number;
  max_file_bytes: number;
};

export interface AdminUser {
  id: number;
  username: string;
  role: Role;
  has_avatar: boolean;
  must_change_credentials: boolean;
  mfa_required: boolean;
  mfa_enrolled: boolean;
  created_at: string;
  permissions: UserPermissions | null;
}

export interface AuditEntry {
  id: number;
  actor: string;
  action: string;
  target: string | null;
  ip: string | null;
  created_at: string;
}

export interface AuditResponse {
  entries: AuditEntry[];
  chain_ok: boolean;
  actions: string[];
  total_count: number;
  filtered_count: number;
  limit: number;
  offset: number;
}

export interface ClusterServer {
  node_id: string;
  node_name: string | null;
}

export interface ClusterAuditEntry {
  id: number;
  node_id: string;
  node_name: string | null;
  kind: string;
  actor: string;
  action: string;
  target: string | null;
  ip: string | null;
  ts: string | null;
}

export interface ClusterAuditResponse {
  entries: ClusterAuditEntry[];
  actions: string[];
  servers: ClusterServer[];
  total_count: number;
  filtered_count: number;
  limit: number;
  offset: number;
}

export interface BackendLog {
  level: string;
  logger: string;
  module: string;
  function: string;
  line: number;
  message: string;
  created_at: string;
}

export interface BackendLogsResponse {
  entries: BackendLog[];
  filtered_count: number;
  total_count: number;
  servers?: ClusterServer[];
  server?: string;
}

export interface BulkPreview {
  action: string;
  affected_count: number;
  confirmation_phrase: string;
  items: { id: number; label: string }[];
}

export type BulkAction =
  | "delete_inactive_links"
  | "delete_api_keys"
  | "reset_api_key_ips"
  | "archive_files"
  | "unarchive_files"
  | "delete_files"
  | "delete_directories"
  | "run_cleanup_jobs";

export type LifecycleJob = "temp-expiry" | "link-expiry" | "archive-idle" | "reconcile";
