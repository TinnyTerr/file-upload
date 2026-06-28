import { api } from "@/config/api";
import type { FileObject, Usage, UploadResult, MintLinkResult, UploadOptions } from "../types";

interface ChunkedInit {
  upload_id: string;
  chunk_size: number;
  num_chunks: number;
  total: number;
  received: number[];
}

/** Options serialized into the chunked-init JSON / form fields. */
function optionFields(opts: UploadOptions): Record<string, unknown> {
  return {
    encryption_mode: opts.encryption_mode,
    max_uses: opts.max_uses ?? undefined,
    expires_in_seconds: opts.expires_in_seconds ?? undefined,
    compress: opts.compress ?? false,
    randomize_filename: opts.randomize_filename ?? false,
    is_permanent: opts.is_permanent ?? true,
    temp_days: opts.temp_days ?? undefined,
    delete_if_idle_days: opts.delete_if_idle_days ?? undefined,
    archive_after_idle_days: opts.archive_after_idle_days ?? undefined,
    directory_id: opts.directory_id ?? undefined,
  };
}

export const filesService = {
  list: () => api.get<{ files: FileObject[] }>("/files/").then((r) => r.files),

  usage: () => api.get<Usage>("/files/usage"),

  delete: (fileId: number) => api.delete(`/files/${fileId}`),

  saveToMyFiles: (slug: string) => api.post<{ file_id: number; slug: string }>(`/files/${slug}/save`),

  // --- single-shot multipart upload ---
  uploadSingle: (
    blob: Blob,
    filename: string,
    opts: UploadOptions,
    onProgress?: (percent: number) => void,
    signal?: AbortSignal,
  ): Promise<UploadResult> => {
    const fd = new FormData();
    fd.append("file", blob, filename);
    fd.append("original_filename", filename);
    for (const [k, v] of Object.entries(optionFields(opts))) {
      if (v !== undefined) fd.append(k, String(v));
    }
    // Use XHR for upload progress events.
    return xhrUpload("/files/upload", fd, onProgress, signal);
  },

  // --- chunked upload (large files) ---
  chunkedInit: (filename: string, totalSize: number, contentType: string | undefined, opts: UploadOptions) =>
    api.post<ChunkedInit>("/files/upload/init", {
      json: {
        original_filename: filename,
        total_size: totalSize,
        content_type: contentType,
        ...optionFields(opts),
      },
    }),

  chunkedStatus: (uploadId: string) =>
    api.get<{ received: number[] }>("/files/upload/status", { query: { upload_id: uploadId } }),

  chunkedSend: (uploadId: string, index: number, chunk: Blob, signal?: AbortSignal) =>
    api.post<{ index: number; num_chunks: number }>("/files/upload/chunk", {
      query: { upload_id: uploadId, index },
      body: chunk,
      headers: { "Content-Type": "application/octet-stream" },
      signal,
    }),

  chunkedFinalize: (uploadId: string) =>
    api.post<UploadResult>("/files/upload/finalize", { json: { upload_id: uploadId } }),

  chunkedAbort: (uploadId: string) =>
    api.delete("/files/upload", { query: { upload_id: uploadId } }),

  // --- remote URL upload (synchronous on the server) ---
  remoteUpload: (url: string, originalFilename?: string) =>
    api.post<UploadResult & { job_id: number; status: string }>("/files/remote-upload", {
      json: { url, original_filename: originalFilename || undefined },
    }),

  // --- links ---
  mintLink: (fileId: number, body: { max_uses?: number | null; expires_in_seconds?: number | null; hide_uploader?: boolean }) =>
    api.post<MintLinkResult>(`/files/${fileId}/links`, { json: body }),

  editLink: (linkId: number, body: { max_uses?: number | null; expires_in_seconds?: number | null; active?: boolean; hide_uploader?: boolean }) =>
    api.patch<{ status: string }>(`/links/${linkId}`, { json: body }),

  deleteLink: (linkId: number) => api.delete(`/links/${linkId}`),
};

/** Upload via XMLHttpRequest to surface progress; mirrors the api.ts CSRF rules. */
function xhrUpload(
  path: string,
  body: FormData,
  onProgress?: (percent: number) => void,
  signal?: AbortSignal,
): Promise<UploadResult> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", path);
    xhr.withCredentials = true;
    const token = localStorage.getItem("fu_csrf_token");
    if (token) xhr.setRequestHeader("X-CSRF-Token", token);

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100));
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
    xhr.onabort = () => reject(new DOMException("aborted", "AbortError"));
    if (signal) {
      if (signal.aborted) return xhr.abort();
      signal.addEventListener("abort", () => xhr.abort());
    }
    xhr.send(body);
  });
}
