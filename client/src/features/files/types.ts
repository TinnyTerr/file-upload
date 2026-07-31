/** `sealed` is Seal & Forget: encrypted server-side under a key the server
 * threw away, so it reads exactly like `client` from here on -- the key rides
 * in the URL fragment and no `?ek=` check applies. */
export type EncryptionMode = "none" | "server" | "client" | "sealed";

/** The two modes the server cannot decrypt on its own. */
export function isKeyHeldByUser(mode: EncryptionMode): boolean {
	return mode === "client" || mode === "sealed";
}

export interface FileLink {
	id: number;
	slug: string;
	max_uses: number | null;
	use_count: number;
	expires_at: string | null;
	active: boolean;
	hide_uploader: boolean;
}

/** A loose file as returned by GET /files/ (and /admin/files). */
export interface FileObject {
	id: number;
	owner_id: number;
	owner_username?: string;
	/** Containing folder, or null for a loose file at the root of the drive. */
	directory_id: number | null;
	/** Titles from the root down to the containing folder. Only the admin
	 * listing sends it — everywhere else the surrounding UI already says where
	 * you are. */
	directory_path?: string[];
	original_filename: string;
	source_type: string;
	saved_from_file_id: number | null;
	size_bytes: number;
	stored_size_bytes: number;
	hashes: Record<string, string> | null;
	content_type: string | null;
	/** *Effective* mode: for an inheriting file this is the folder's, not the
	 * file's own column. `encryption_overridden` says which of the two it is. */
	encryption_mode: EncryptionMode;
	encryption_overridden: boolean;
	/** The folder whose key actually protects this file, when it inherits. */
	inherited_from_directory_id: number | null;
	/** The `?ek=` secret is a human password, so guesses are rate-limited. */
	password_locked: boolean;
	/** Seal & Forget with a password: the salt and derivation parameters needed
	 * to rebuild the key in the browser. Both null for a random seal. */
	seal_salt: string | null;
	seal_kdf: string | null;
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
