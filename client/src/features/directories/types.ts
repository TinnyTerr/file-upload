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
	encryption_mode: EncryptionMode;
	key_check_blob: string | null;
	access_key: string | null;
	file_count: number;
	total_bytes: number;
	expires_at: string | null;
	created_at: string;
	role: "owner" | "editor" | null;
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
	encryption_mode: EncryptionMode;
	key_check_blob: string | null;
	access_key: string | null;
}
