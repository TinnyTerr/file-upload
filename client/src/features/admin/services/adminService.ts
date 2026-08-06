import { api } from "@/config/api";
import type { AdminApiKey } from "@/features/apikeys/types";
import type { Directory } from "@/features/directories/types";
import type { FileObject } from "@/features/files/types";
import type {
	AdminTorrentJob,
	DebridSettingsInput,
	DebridStatus,
	SeedingSettingsInput,
	SeedingStatus,
	TorrentHostStatus,
} from "@/features/torrents/types";
import type {
	AdminUser,
	AuditResponse,
	BackendLogsResponse,
	BulkAction,
	BulkPreview,
	ClusterAuditResponse,
	DiskStats,
	LifecycleJob,
	StorageDetails,
	UserPermissions,
} from "../types";

export const adminService = {
	diskStats: () => api.get<DiskStats>("/files/disk-stats"),
	storage: () => api.get<StorageDetails>("/admin/storage"),
	setStorageCap: (bytes: number) =>
		api.patch("/admin/storage", {
			json: { global_storage_quota_bytes: bytes },
		}),

	// Files
	files: () =>
		api.get<{ files: FileObject[] }>("/admin/files").then((r) => r.files),
	directories: () =>
		api
			.get<{ directories: Directory[] }>("/admin/directories")
			.then((r) => r.directories),
	archiveFile: (id: number) => api.post(`/admin/files/${id}/archive`),
	unarchiveFile: (id: number) => api.post(`/admin/files/${id}/unarchive`),

	// Users
	users: () => api.get<{ users: AdminUser[] }>("/users/").then((r) => r.users),
	createUser: (body: {
		username: string;
		password: string;
		role: string;
		can_upload: boolean;
	}) => api.post("/users/", { json: body }),
	updateUser: (
		id: number,
		body: {
			username?: string;
			password?: string;
			role?: string;
			mfa_required?: boolean;
		},
	) => api.patch(`/users/${id}`, { json: body }),
	deleteUser: (id: number) => api.delete(`/users/${id}`),
	setPermissions: (id: number, body: Partial<UserPermissions>) =>
		api.post(`/users/${id}/permissions`, { json: body }),

	// Keys (endpoint wraps the list as { keys: [...] })
	keys: () =>
		api.get<{ keys: AdminApiKey[] }>("/admin/keys").then((r) => r.keys),

	// Audit. verify=true asks the server to also recompute the hash chain
	// (chain_ok stays null otherwise -- see server/src/routes/audit.ts).
	audit: (params: {
		limit?: number;
		offset?: number;
		q?: string;
		action?: string;
		verify?: boolean;
	}) =>
		api.get<AuditResponse>("/audit/", {
			query: { ...params, verify: params.verify ? "1" : undefined },
		}),

	// Cluster-wide event log (aggregated from every node; server-filterable).
	clusterAudit: (params: {
		limit?: number;
		offset?: number;
		q?: string;
		action?: string;
		kind?: string;
		server?: string;
	}) => api.get<ClusterAuditResponse>("/audit/cluster", { query: params }),

	// Backend
	backendLogs: (params: {
		limit?: number;
		q?: string;
		level?: string;
		server?: string;
	}) => api.get<BackendLogsResponse>("/admin/backend/logs", { query: params }),
	restartWorkers: () =>
		api.post<{ status: string; jobs: string[] }>(
			"/admin/backend/restart-workers",
		),

	// Lifecycle
	runLifecycle: (job: LifecycleJob) =>
		api.post<{ processed: number }>(`/admin/lifecycle/${job}`),

	// Torrents (Real-Debrid + host qBittorrent connectivity, and every user's jobs)
	torrentStatus: () => api.get<TorrentHostStatus>("/admin/torrents/status"),
	torrents: () =>
		api
			.get<{ torrents: AdminTorrentJob[] }>("/admin/torrents")
			.then((r) => r.torrents),
	// The server validates a non-empty api_key against Real-Debrid before it
	// persists it, so a rejected token surfaces here as a 400.
	setDebrid: (body: DebridSettingsInput) =>
		api.put<DebridStatus>("/admin/torrents/debrid", { json: body }),
	// Seeding policy for finished qBittorrent torrents. Node-local config, like
	// the Real-Debrid token -- it is not replicated to peers.
	setSeeding: (body: SeedingSettingsInput) =>
		api.put<SeedingStatus>("/admin/torrents/seeding", { json: body }),

	// Bulk
	bulkPreview: (action: BulkAction, ids: number[]) =>
		api.post<BulkPreview>("/admin/bulk/preview", { json: { action, ids } }),
	bulkRun: (action: BulkAction, ids: number[], confirm: string) =>
		api.post<{
			action: string;
			processed_count: number;
			affected_count: number;
		}>("/admin/bulk/run", {
			json: { action, ids, confirm },
		}),
};
