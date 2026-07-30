/** Mirrors the payloads in server/src/routes/media.ts. */

export type MediaVisibility = "public" | "restricted";
export type MediaKind = "movie" | "series";

export interface MediaEntry {
	file_id: number;
	title: string;
	content_type: string;
	size_bytes: number;
	kind: "video" | "audio";
	duration_seconds: number | null;
	width: number | null;
	height: number | null;
	/** E2E-encrypted: only the browser holding the key can play it, never mpv. */
	client_encrypted: boolean;
	/** False for encrypted/compressed/archived titles — those stream from byte
	 * zero only, so the player can't seek. */
	seekable: boolean;
	archived: boolean;
}

export interface MediaCollection {
	slug: string;
	directory_id: number;
	title: string;
	overview: string | null;
	kind: MediaKind;
	visibility: MediaVisibility;
	entry_count: number;
	total_duration_seconds: number | null;
	published_at: string | null;
	uploader: { username: string } | null;
	has_poster: boolean;
	can_curate: boolean;
	entries?: MediaEntry[];
}

export interface MediaLibrary {
	collections: MediaCollection[];
	viewer: { username: string; can_watch_media: boolean } | null;
}

export interface PlayKey {
	id: number;
	label: string | null;
	file_id: number | null;
	directory_id: number | null;
	scope: "file" | "collection";
	bound_ip: string | null;
	expires_at: string;
	created_at: string;
	last_used_at: string | null;
}

/** The mint response — `key`/`url` are shown once and never retrievable again. */
export interface MintedPlayKey {
	id: number;
	scope: "file" | "collection";
	file_id: number | null;
	directory_id: number | null;
	label: string | null;
	bound_ip: string | null;
	expires_at: string;
	key: string;
	url: string;
	mpv_command: string;
}

export interface MintPlayKeyInput {
	file_id?: number;
	directory_id?: number;
	ttl_seconds?: number;
	label?: string;
	/** Pin the key to the requesting address. */
	bind_ip?: boolean;
}

export interface PublishInput {
	visibility?: MediaVisibility;
	kind?: MediaKind;
	overview?: string | null;
	poster_file_id?: number | null;
}
