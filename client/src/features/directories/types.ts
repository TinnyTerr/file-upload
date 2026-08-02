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
	parent_directory_id: number | null;
	url: string;
	encryption_mode: EncryptionMode;
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
}

/** A Directory as it appears inside a browse() listing -- carries whether it
 * needs its own key relative to the folder context it's listed under (see
 * isEncLocked on the backend). Not present on the flat Directory shape since
 * that has no single "current folder" to compare against. */
export interface BrowseFolder extends Directory {
	locked: boolean;
}

export interface BrowseCrumb {
	id: number;
	title: string;
}

export interface BrowseResult {
	folder: Directory | null;
	breadcrumb: BrowseCrumb[];
	folders: BrowseFolder[];
	files: BrowseFile[];
}

/** Re-declared here (not imported from features/files/types) to avoid a
 * directories -> files -> directories import cycle; kept structurally
 * identical to FileObject plus the two browse-only fields. */
export interface BrowseFile {
	id: number;
	owner_id: number;
	owner_username?: string;
	original_filename: string;
	source_type: string;
	saved_from_file_id: number | null;
	size_bytes: number;
	stored_size_bytes: number;
	hashes: Record<string, string> | null;
	content_type: string | null;
	encryption_mode: EncryptionMode;
	compressed: boolean;
	archived: boolean;
	lifecycle_state: string | null;
	is_permanent: boolean;
	expires_at: string | null;
	last_downloaded_at: string | null;
	access_key: string | null;
	created_at: string;
	links: Array<{
		id: number;
		slug: string;
		max_uses: number | null;
		use_count: number;
		expires_at: string | null;
		active: boolean;
		hide_uploader: boolean;
	}>;
	directory_id: number | null;
	locked: boolean;
}

export interface CreateDirectoryResult {
	id: number;
	slug: string;
	url: string;
	encryption_mode: EncryptionMode;
	key_check_blob: string | null;
	access_key: string | null;
}
