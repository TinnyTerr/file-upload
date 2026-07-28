import { api } from "@/config/api";

export interface DropboxLink {
	id: number;
	token: string;
	url: string;
	upload_url: string;
	target_directory_id: number | null;
	expires_at: string;
}

export interface DropboxInfo {
	status: string;
	target_directory_id: number | null;
	expires_at: string | null;
}

interface DropboxChunkedInit {
	upload_id: string;
	chunk_size: number;
	num_chunks: number;
	total: number;
	received: number[];
}

export interface DropboxUploadProgress {
	phase: "uploading" | "finalizing";
	percent: number;
}

const CHUNKED_THRESHOLD = 80 * 1024 * 1024;
const MAX_CONCURRENT_CHUNKS = 2;
const CHUNK_RETRIES = 3;

/**
 * The recipient-facing share URL. The backend's own `/dropbox/{token}` returns
 * JSON and there is no SPA shell route for it, so we host the upload page at `/`
 * (the only always-SPA path) with the token in a query param.
 */
export function receiveUrl(token: string): string {
	return `${window.location.origin}/?receive=${encodeURIComponent(token)}`;
}

export const dropboxService = {
	create: (body: {
		expires_in_seconds: number;
		target_directory_id?: number | null;
	}) => api.post<DropboxLink>("/dropbox-links", { json: body }),

	cancel: (token: string) =>
		api.delete<{ status: string }>(
			`/dropbox-links/${encodeURIComponent(token)}`,
		),

	info: (token: string) => api.get<DropboxInfo>(`/dropbox/${token}`),

	upload: (
		token: string,
		file: File,
		originalFilename: string,
		onProgress?: (progress: DropboxUploadProgress) => void,
	) =>
		file.size >= CHUNKED_THRESHOLD
			? chunkedDropboxUpload(token, file, originalFilename, onProgress)
			: singleDropboxUpload(token, file, originalFilename, onProgress),
};

function singleDropboxUpload(
	token: string,
	file: File,
	originalFilename: string,
	onProgress?: (progress: DropboxUploadProgress) => void,
) {
	/**
	 * Public one-file upload to a dropbox token. No auth/CSRF — the token is the
	 * credential. Uses XHR for upload-progress events.
	 */
	return new Promise<{ file_id: number; slug: string }>((resolve, reject) => {
		const fd = new FormData();
		fd.append("file", file, originalFilename);
		fd.append("original_filename", originalFilename);
		const xhr = new XMLHttpRequest();
		xhr.open("POST", `/dropbox/${token}/upload`);
		xhr.upload.onprogress = (e) => {
			if (!e.lengthComputable || !onProgress) return;
			const sent = Math.round((e.loaded / e.total) * 100);
			onProgress(
				sent >= 100
					? { phase: "finalizing", percent: 99 }
					: { phase: "uploading", percent: sent },
			);
		};
		xhr.onload = () => {
			if (xhr.status >= 200 && xhr.status < 300) {
				try {
					resolve(JSON.parse(xhr.responseText));
				} catch {
					reject(new Error("invalid server response"));
				}
			} else {
				let detail = `HTTP ${xhr.status}`;
				try {
					const d = JSON.parse(xhr.responseText).detail;
					detail = typeof d === "string" ? d : JSON.stringify(d);
				} catch {
					/* ignore */
				}
				reject(new Error(detail));
			}
		};
		xhr.onerror = () => reject(new Error("network error"));
		xhr.send(fd);
	});
}

async function chunkedDropboxUpload(
	token: string,
	file: File,
	originalFilename: string,
	onProgress?: (progress: DropboxUploadProgress) => void,
): Promise<{ file_id: number; slug: string }> {
	const encoded = encodeURIComponent(token);
	const init = await api.post<DropboxChunkedInit>(
		`/dropbox/${encoded}/upload/init`,
		{
			json: {
				original_filename: originalFilename,
				total_size: file.size,
				content_type: file.type || undefined,
			},
		},
	);
	const { upload_id, chunk_size, num_chunks } = init;
	const done = new Set<number>(init.received ?? []);
	const report = () =>
		onProgress?.({
			phase: "uploading",
			percent: Math.round((done.size / num_chunks) * 100),
		});
	report();

	const pending = Array.from({ length: num_chunks }, (_, i) => i).filter(
		(i) => !done.has(i),
	);
	let cursor = 0;

	async function worker() {
		while (cursor < pending.length) {
			const index = pending[cursor++];
			const start = index * chunk_size;
			const chunk = file.slice(start, Math.min(start + chunk_size, file.size));
			let attempt = 0;
			for (;;) {
				try {
					await api.post(`/dropbox/${encoded}/upload/chunk`, {
						query: { upload_id, index },
						body: chunk,
						headers: { "Content-Type": "application/octet-stream" },
					});
					break;
				} catch (err) {
					if (++attempt >= CHUNK_RETRIES) throw err;
					await delay(300 * attempt);
				}
			}
			done.add(index);
			report();
		}
	}

	await Promise.all(
		Array.from(
			{ length: Math.min(MAX_CONCURRENT_CHUNKS, pending.length) },
			worker,
		),
	);
	onProgress?.({ phase: "finalizing", percent: 100 });
	return api.post<{ file_id: number; slug: string }>(
		`/dropbox/${encoded}/upload/finalize`,
		{
			json: { upload_id },
		},
	);
}

function delay(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
