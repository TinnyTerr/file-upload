import { api, apiPath } from "@/config/api";
import type { UploaderInfo } from "@/features/download/services/publicService";
import type { EncryptionMode } from "@/features/files/types";

/**
 * `key_scope` names *which* secret opens a node — `dir:12` or `file:34`.
 *
 * A folder link now covers a subtree, and that subtree can contain break
 * points with keys of their own. "The folder's key" is no longer a single
 * meaningful thing, so every node says which key it wants and the page keeps a
 * map of the ones the visitor has actually proved.
 */
export interface PublicDirMember {
	slug: string;
	filename: string;
	size_bytes: number;
	content_type: string | null;
	encryption_mode: EncryptionMode;
	password_locked: boolean;
	key_scope: string;
	/** The server's own answer to "would /preview serve this?" — it is the only
	 * side that knows which storage transforms the blob is under. */
	previewable: boolean;
}

export interface PublicDirNode {
	id: number;
	title: string;
	file_count: number;
	subdirectory_count: number;
	total_bytes: number;
	encryption_mode: EncryptionMode;
	password_locked: boolean;
	key_check_blob: string | null;
	key_scope: string;
}

export interface PublicDirCrumb {
	id: number;
	title: string;
}

export interface PublicDirInfo {
	id: number;
	/** The folder the link points at — the root of what was shared. */
	entry_id: number;
	title: string;
	breadcrumbs: PublicDirCrumb[];
	encryption_mode: EncryptionMode;
	password_locked: boolean;
	key_check_blob: string | null;
	key_scope: string;
	/** The shared folder asked to be rendered as a gallery rather than a list. */
	gallery_view: boolean;
	directories: PublicDirNode[];
	file_count: number;
	total_bytes: number;
	files: PublicDirMember[];
	uploader: UploaderInfo | null;
	already_saved: boolean;
	/** The *link's* own expiry, not any node inside the tree it shares. */
	expires_at: string | null;
}

export const publicDirService = {
	info: (slug: string, dir?: number | null) =>
		api.get<PublicDirInfo>(`/d/${slug}/info`, {
			query: dir ? { dir } : undefined,
		}),

	/** Prove a key or password for one node without starting a download.
	 * Throttled server-side for password-locked nodes. */
	unlock: (slug: string, dir: number | null, ek: string) =>
		api.post<{ ok: true; key_scope: string }>(`/d/${slug}/unlock`, {
			json: { dir: dir ?? undefined, ek },
		}),
};

export const dirZipPath = (
	slug: string,
	opts: { dir?: number | null; accessKey?: string | null } = {},
) => {
	const params = new URLSearchParams();
	if (opts.dir) params.set("dir", String(opts.dir));
	if (opts.accessKey) params.set("ek", opts.accessKey);
	const query = params.toString();
	return apiPath(`/d/${slug}/zip${query ? `?${query}` : ""}`);
};
