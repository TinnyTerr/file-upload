import { useCallback, useState } from "react";
import { toast } from "sonner";
import type { EncryptionMode } from "@/features/files/types";
import { base64UrlToBytes } from "@/lib/base64url";
import { saveBlob } from "@/lib/download";
import { decryptBlob } from "@/workers/aeadClient";
import { publicService, rawPath } from "../services/publicService";

export type DownloadStatus =
	| "idle"
	| "downloading"
	| "decrypting"
	| "done"
	| "error";

export function useDownload(
	slug: string,
	filename: string,
	mode: EncryptionMode,
) {
	const [status, setStatus] = useState<DownloadStatus>("idle");
	const [percent, setPercent] = useState(0);
	const [error, setError] = useState<string | null>(null);

	/** keys: clientKey (base64url, from #ek=), serverKey (from ?ek=), or
	 * sealKey (already derived from a Seal & Forget password). */
	const download = useCallback(
		async (keys: {
			clientKey?: string | null;
			serverKey?: string | null;
			sealKey?: Uint8Array | null;
		}) => {
			setError(null);
			try {
				if (mode === "none") {
					window.location.assign(rawPath(slug));
					return;
				}
				if (mode === "server") {
					if (!keys.serverKey) {
						setError(
							"This file needs an access key (?ek=). Paste the full share link.",
						);
						return;
					}
					window.location.assign(rawPath(slug, keys.serverKey));
					return;
				}
				// client and sealed both mean the same thing here: the server holds
				// no key, so the bytes come down as ciphertext and the browser is
				// the only thing that can turn them back into a file.
				if (!keys.clientKey && !keys.sealKey) {
					setError(
						"Missing decryption key (#ek=). You need the complete share link.",
					);
					return;
				}
				const keyBytes = keys.sealKey ?? base64UrlToBytes(keys.clientKey!);
				setStatus("downloading");
				setPercent(0);
				const cipher = await publicService.fetchRaw(slug, (loaded, total) =>
					setPercent(total ? Math.round((loaded / total) * 100) : 0),
				);
				setStatus("decrypting");
				setPercent(0);
				const plain = await decryptBlob(cipher, keyBytes, setPercent);
				saveBlob(plain, filename);
				setStatus("done");
				toast.success("Downloaded & decrypted");
			} catch (err) {
				const msg = err instanceof Error ? err.message : "Download failed";
				setError(msg);
				setStatus("error");
				toast.error(msg);
			}
		},
		[slug, filename, mode],
	);

	return { download, status, percent, error };
}
