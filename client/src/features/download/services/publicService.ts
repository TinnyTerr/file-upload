import { api, apiPath } from "@/config/api";
import type { EncryptionMode } from "@/features/files/types";
import {
	CHUNKED_DOWNLOAD_THRESHOLD,
	type DownloadProgress,
	downloadErrorMessage,
	rangedDownload,
} from "../lib/downloadCore";

export interface UploaderInfo {
	username: string;
	has_avatar: boolean;
	user_id: number;
}

export interface PublicFileInfo {
	filename: string;
	size_bytes: number;
	content_type: string | null;
	encryption_mode: EncryptionMode;
	compressed: boolean;
	archived: boolean;
	lifecycle_state: string | null;
	max_uses: number | null;
	use_count: number;
	expires_at: string | null;
	hashes: Record<string, string> | null;
	uploader: UploaderInfo | null;
	already_saved: boolean;
	/** The `?ek=` secret is a chosen password, so guesses are throttled. */
	password_locked: boolean;
	/** Seal & Forget with a password: the salt and the derivation parameters
	 * needed to rebuild the key in the browser. Null for a random seal. */
	seal_salt: string | null;
	seal_kdf: string | null;
}

export const publicService = {
	fileInfo: (slug: string) => api.get<PublicFileInfo>(`/file/${slug}/info`),

	/**
	 * Fetch raw (possibly ciphertext) bytes as a Blob.
	 *
	 * Anything big enough to be worth it goes through the ranged chunk pool
	 * (`lib/downloadCore.ts`), which degrades to a single stream by itself when
	 * the server answers 200 instead of 206 — so this needs no knowledge of the
	 * link's use budget or the blob's storage form. `sizeBytes` is only the hint
	 * that decides whether to try; the real length comes off `Content-Range`.
	 */
	fetchRawChunked: (
		slug: string,
		opts: {
			sizeBytes?: number;
			onProgress?: (p: DownloadProgress) => void;
			signal?: AbortSignal;
		} = {},
	): Promise<Blob> => {
		if ((opts.sizeBytes ?? 0) < CHUNKED_DOWNLOAD_THRESHOLD) {
			return publicService.fetchRaw(slug, (loaded, total) =>
				opts.onProgress?.({
					loaded,
					total,
					percent: total ? Math.round((loaded / total) * 100) : 0,
				}),
			);
		}
		return rangedDownload(apiPath(`/file/${slug}/raw`), {
			onProgress: opts.onProgress,
			signal: opts.signal,
		});
	},

	/** Fetch raw bytes over a single connection, with progress. */
	fetchRaw: async (
		slug: string,
		onProgress?: (loaded: number, total: number) => void,
	): Promise<Blob> => {
		const res = await fetch(apiPath(`/file/${slug}/raw`), {
			credentials: "same-origin",
		});
		if (!res.ok) throw new Error(downloadErrorMessage(res.status));
		const total = Number(res.headers.get("Content-Length") ?? 0);
		if (!res.body || !onProgress) return res.blob();

		const reader = res.body.getReader();
		const chunks: Uint8Array[] = [];
		let loaded = 0;
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			chunks.push(value);
			loaded += value.length;
			onProgress(loaded, total);
		}
		return new Blob(chunks as BlobPart[]);
	},
};

export const rawPath = (slug: string, accessKey?: string | null) =>
	apiPath(
		accessKey
			? `/file/${slug}/raw?ek=${encodeURIComponent(accessKey)}`
			: `/file/${slug}/raw`,
	);

/** Inline bytes for an unlimited-use link. `accessKey` is the folder's/file's
 * `?ek=` — required for server-encrypted members, ignored otherwise. */
export const previewPath = (slug: string, accessKey?: string | null) =>
	apiPath(
		accessKey
			? `/file/${slug}/preview?ek=${encodeURIComponent(accessKey)}`
			: `/file/${slug}/preview`,
	);

export const thumbnailPath = (slug: string) =>
	apiPath(`/file/${slug}/thumbnail`);
