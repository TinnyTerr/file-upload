import { api } from "@/config/api";
import type { EncryptionMode } from "@/features/files/types";
import type {
	CreateDirectoryResult,
	Directory,
	DirectoryLink,
	DirectoryMember,
} from "../types";

export const dirService = {
	list: () =>
		api
			.get<{ directories: Directory[] }>("/directories/")
			.then((r) => r.directories),

	create: (body: {
		title: string;
		/** Omitted for a nested folder: a child always inherits its parent's
		 * encryption, and the backend rejects an explicit mode there. */
		encryption_mode?: EncryptionMode;
		parent_directory_id?: number | null;
		expires_in_seconds?: number | null;
		key_check_blob?: string | null;
		password?: string | null;
	}) => api.post<CreateDirectoryResult>("/directories", { json: body }),

	rename: (dirId: number, title: string) =>
		api.patch<Directory>(`/directories/${dirId}`, { json: { title } }),

	setGalleryView: (dirId: number, galleryView: boolean) =>
		api.patch<Directory>(`/directories/${dirId}`, {
			json: { gallery_view: galleryView },
		}),

	move: (dirId: number, parentDirectoryId: number | null) =>
		api.patch<Directory>(`/directories/${dirId}/move`, {
			json: { parent_directory_id: parentDirectoryId },
		}),

	members: (dirId: number) =>
		api
			.get<{ files: DirectoryMember[] }>(`/directories/${dirId}/files`)
			.then((r) => r.files),

	removeMember: (dirId: number, fileId: number) =>
		api.delete(`/directories/${dirId}/files/${fileId}`),

	addCollaborator: (dirId: number, username: string) =>
		api.post(`/directories/${dirId}/collaborators`, { json: { username } }),

	removeCollaborator: (dirId: number, userId: number) =>
		api.delete(`/directories/${dirId}/collaborators/${userId}`),

	remove: (dirId: number) => api.delete(`/directories/${dirId}`),

	// Directory links
	listLinks: (dirId: number) =>
		api
			.get<{ links: DirectoryLink[] }>(`/directories/${dirId}/links`)
			.then((r) => r.links),

	createLink: (
		dirId: number,
		body: {
			max_uses?: number | null;
			expires_in_seconds?: number | null;
			hide_uploader?: boolean;
		},
	) => api.post<DirectoryLink>(`/directories/${dirId}/links`, { json: body }),

	updateLink: (
		dirId: number,
		linkId: number,
		body: {
			max_uses?: number | null;
			active?: boolean;
			hide_uploader?: boolean;
		},
	) =>
		api.patch<DirectoryLink>(`/directories/${dirId}/links/${linkId}`, {
			json: body,
		}),

	deleteLink: (dirId: number, linkId: number) =>
		api.delete(`/directories/${dirId}/links/${linkId}`),
};
