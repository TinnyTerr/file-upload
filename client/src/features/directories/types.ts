import type { EncryptionMode } from "@/features/files/types";

export interface DirectoryLink {
	id: number;
	directory_id: number;
	slug: string;
	max_uses: number | null;
	use_count: number;
	expires_at: string | null;
	active: boolean;
	hide_uploader: boolean;
	created_at: string;
	url: string;
}

export interface Directory {
	id: number;
	owner_id: number;
	slug: string;
	title: string;
	url: string;
	/** Containing folder, or null for a root-level folder. */
	parent_directory_id: number | null;
	subdirectory_count: number;
	/** *Effective* mode -- see FileObject.encryption_mode. */
	encryption_mode: EncryptionMode;
	encryption_overridden: boolean;
	inherited_from_directory_id: number | null;
	password_locked: boolean;
	key_check_blob: string | null;
	access_key: string | null;
	file_count: number;
	total_bytes: number;
	expires_at: string | null;
	created_at: string;
	role: "owner" | "editor" | null;
	/** Published into the media library — see features/media. */
	is_library: boolean;
	library_visibility: "public" | "restricted";
	library_kind: "movie" | "series";
	library_overview: string | null;
	/** Render the public page (/d/:slug) as a gallery instead of a file list. */
	gallery_view: boolean;
	/** Titles from the root down to the *containing* folder. Admin listing only. */
	directory_path?: string[];
}

export interface DirectoryMember {
	id: number;
	slug: string | null;
	filename: string;
	size_bytes: number;
	content_type: string | null;
	encryption_mode: EncryptionMode;
	created_at: string;
}

export interface CreateDirectoryResult {
	id: number;
	slug: string;
	url: string;
	parent_directory_id: number | null;
	encryption_mode: EncryptionMode;
	encryption_overridden: boolean;
	inherited_from_directory_id: number | null;
	password_locked: boolean;
	key_check_blob: string | null;
	access_key: string | null;
}
