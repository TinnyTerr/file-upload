import { api, apiPath } from "@/config/api";
import type { CurrentUser } from "../types";

export const accountService = {
	me: () => api.get<CurrentUser>("/account/me"),

	changeCredentials: (body: {
		current_password: string;
		new_username: string;
		new_password: string;
	}) =>
		api.post<{ status: string }>("/account/change-credentials", { json: body }),

	uploadAvatar: (blob: Blob) => {
		const form = new FormData();
		form.append("file", blob, "avatar.jpg");
		return api.post<{ status: string }>("/account/avatar", { body: form });
	},

	deleteAvatar: () => api.delete<{ status: string }>("/account/avatar"),

	resetAccount: (current_password: string) =>
		api.post<{ status: string }>("/account/reset", {
			json: { current_password },
		}),

	deleteAccount: (current_password: string) =>
		api.delete<{ status: string }>("/account", { json: { current_password } }),

	/** URL to serve the avatar for a given user id. Cache-busted by version param. */
	avatarUrl: (userId: number, v?: number) =>
		apiPath(`/account/avatar/${userId}${v !== undefined ? `?v=${v}` : ""}`),
};
