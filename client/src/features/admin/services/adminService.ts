import { api } from "@/config/api";
import type { FileObject } from "@/features/files/types";
import type { Directory } from "@/features/directories/types";
import type { AdminApiKey } from "@/features/apikeys/types";
import type {
  DiskStats,
  StorageDetails,
  AdminUser,
  AuditResponse,
  ClusterAuditResponse,
  BackendLogsResponse,
  BulkPreview,
  BulkAction,
  LifecycleJob,
  UserPermissions,
} from "../types";

export const adminService = {
  diskStats: () => api.get<DiskStats>("/files/disk-stats"),
  storage: () => api.get<StorageDetails>("/admin/storage"),
  setStorageCap: (bytes: number) =>
    api.patch("/admin/storage", { json: { global_storage_quota_bytes: bytes } }),

  // Files
  files: () => api.get<{ files: FileObject[] }>("/admin/files").then((r) => r.files),
  directories: () => api.get<{ directories: Directory[] }>("/admin/directories").then((r) => r.directories),
  archiveFile: (id: number) => api.post(`/admin/files/${id}/archive`),
  unarchiveFile: (id: number) => api.post(`/admin/files/${id}/unarchive`),

  // Users
  users: () => api.get<{ users: AdminUser[] }>("/users/").then((r) => r.users),
  createUser: (body: { username: string; password: string; role: string; can_upload: boolean }) =>
    api.post("/users/", { json: body }),
  updateUser: (id: number, body: { username?: string; password?: string; role?: string }) =>
    api.patch(`/users/${id}`, { json: body }),
  deleteUser: (id: number) => api.delete(`/users/${id}`),
  setPermissions: (id: number, body: Partial<UserPermissions>) =>
    api.post(`/users/${id}/permissions`, { json: body }),

  // Keys (endpoint wraps the list as { keys: [...] })
  keys: () => api.get<{ keys: AdminApiKey[] }>("/admin/keys").then((r) => r.keys),

  // Audit
  audit: (params: { limit?: number; offset?: number; q?: string; action?: string }) =>
    api.get<AuditResponse>("/audit/", { query: params }),

  // Cluster-wide event log (aggregated from every node; server-filterable).
  clusterAudit: (params: {
    limit?: number; offset?: number; q?: string; action?: string; kind?: string; server?: string;
  }) => api.get<ClusterAuditResponse>("/audit/cluster", { query: params }),

  // Backend
  backendLogs: (params: { limit?: number; q?: string; level?: string; server?: string }) =>
    api.get<BackendLogsResponse>("/admin/backend/logs", { query: params }),
  restartWorkers: () => api.post<{ status: string; jobs: string[] }>("/admin/backend/restart-workers"),

  // Lifecycle
  runLifecycle: (job: LifecycleJob) => api.post<{ processed: number }>(`/admin/lifecycle/${job}`),

  // Bulk
  bulkPreview: (action: BulkAction, ids: number[]) =>
    api.post<BulkPreview>("/admin/bulk/preview", { json: { action, ids } }),
  bulkRun: (action: BulkAction, ids: number[], confirm: string) =>
    api.post<{ action: string; processed_count: number; affected_count: number }>("/admin/bulk/run", {
      json: { action, ids, confirm },
    }),
};
