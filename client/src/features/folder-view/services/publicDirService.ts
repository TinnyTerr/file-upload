import { api, apiPath } from "@/config/api";
import type { UploaderInfo } from "@/features/download/services/publicService";
import type { EncryptionMode } from "@/features/files/types";

export interface PublicDirMember {
	slug: string;
	filename: string;
	size_bytes: number;
	content_type: string | null;
}

/** An immediate subfolder, linking to its own public /d/{slug} page. Clicking
 * one is a normal navigation -- that page resolves (and gates encryption)
 * independently, which is what makes a "nested encrypted" subfolder (one
 * with its own key, different from this folder's) work automatically: the
 * link is visible here, but opening it requires whatever `?ek=`/`#ek=` that
 * subfolder's own share link carries, not this folder's. */
export interface PublicSubfolder {
	slug: string;
	title: string;
	encryption_mode: EncryptionMode;
	locked: boolean;
}

export interface PublicDirInfo {
	title: string;
	encryption_mode: EncryptionMode;
	file_count: number;
	total_bytes: number;
	files: PublicDirMember[];
	folders: PublicSubfolder[];
	uploader: UploaderInfo | null;
	already_saved: boolean;
}

export const publicDirService = {
	info: (slug: string) => api.get<PublicDirInfo>(`/d/${slug}/info`),
};

export const dirZipPath = (slug: string, accessKey?: string | null) =>
	apiPath(
		accessKey
			? `/d/${slug}/zip?ek=${encodeURIComponent(accessKey)}`
			: `/d/${slug}/zip`,
	);
