import { api, apiPath } from "@/config/api";
import type { Directory } from "@/features/directories/types";
import type { EncryptionMode, FileObject } from "@/features/files/types";

/** `mode` makes the node its own break point; `adopt_parent` drops its key and
 * follows the chain above it again. Exactly one of the two. */
export type EncryptionChange =
	| { mode: "none" | "server"; password?: string | null }
	| { adopt_parent: true };

export interface AccessSecretResult {
	id: number;
	access_key: string;
	password_locked: boolean;
}

export interface SealResult extends FileObject {
	/** Shown once. There is no second copy anywhere on the server. */
	key: string;
	key_is_password: boolean;
	seal_salt: string | null;
	seal_kdf: string | null;
}

export const encryptionService = {
	setDirectory: (dirId: number, body: EncryptionChange) =>
		api.patch<
			Directory & { access_key: string | null; files_reencrypted: number }
		>(`/directories/${dirId}/encryption`, { json: body }),

	setFile: (fileId: number, body: EncryptionChange) =>
		api.patch<FileObject & { access_key: string | null }>(
			`/files/${fileId}/encryption`,
			{ json: body },
		),

	/** Swap the `?ek=` secret without re-encrypting anything. An empty body
	 * mints a fresh random token; `{password}` locks it behind a password. */
	setDirectoryAccess: (dirId: number, password?: string) =>
		api.put<AccessSecretResult>(`/directories/${dirId}/access`, {
			json: password ? { password } : {},
		}),

	setFileAccess: (fileId: number, password?: string) =>
		api.put<AccessSecretResult>(`/files/${fileId}/access`, {
			json: password ? { password } : {},
		}),

	seal: (fileId: number, password?: string) =>
		api.post<SealResult>(`/files/${fileId}/seal`, {
			json: password ? { password } : {},
		}),

	/** Records that a browser-side conversion happened and destroys the file it
	 * replaced. Call only after the replacement upload has succeeded. */
	commitConversion: (newFileId: number, replacedFileId: number) =>
		api.post<
			FileObject & {
				replaced_file_id: number;
				previous_encryption_mode: EncryptionMode;
			}
		>(`/files/${newFileId}/e2e-conversion`, {
			json: { replaced_file_id: replacedFileId },
		}),

	/** The owner's own read of a file's bytes — no link, no use consumed.
	 * Plaintext for `none`/`server`, the raw container for `client`/`sealed`. */
	content: async (fileId: number): Promise<Blob> => {
		const res = await fetch(apiPath(`/files/${fileId}/content`), {
			credentials: "same-origin",
		});
		if (!res.ok) {
			let detail = `Download failed (${res.status})`;
			try {
				detail = (await res.json()).detail ?? detail;
			} catch {
				/* non-JSON error body */
			}
			throw new Error(detail);
		}
		return res.blob();
	},
};
