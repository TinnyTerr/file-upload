import { api } from "@/config/api";
import type { AdminApiKey, ApiKey, NewApiKey } from "../types";

export const keysService = {
	list: () => api.get<{ keys: ApiKey[] }>("/keys/").then((r) => r.keys),

	create: () => api.post<NewApiKey>("/keys/"),

	delete: (keyId: number) => api.delete(`/keys/${keyId}`),

	resetIp: (keyId: number, password: string) =>
		api.post(`/keys/${keyId}/reset-ip`, { json: { password } }),

	// Admin: all users' keys
	adminList: () =>
		api.get<{ keys: AdminApiKey[] }>("/admin/keys").then((r) => r.keys),
};
