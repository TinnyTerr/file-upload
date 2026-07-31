import { useCallback, useState } from "react";
import { toast } from "sonner";
import { ApiError, errorMessage } from "@/config/api";
import { performUpload } from "@/features/files/lib/uploadCore";
import type { EncryptionMode, FileObject } from "@/features/files/types";
import { decryptBlob } from "@/workers/aeadClient";
import type { DriveItem } from "../lib/items";
import {
	type EncryptionChange,
	encryptionService,
} from "../services/encryptionService";
import { useInvalidateDrive } from "./useDrive";

export interface ConversionProgress {
	phase:
		| "downloading"
		| "decrypting"
		| "encrypting"
		| "uploading"
		| "finishing";
	percent: number;
	filename: string;
}

export interface ConversionResult {
	/** The key that opens the replacement, for a `client` target. */
	clientKeyB64: string | null;
	/** The replacement file's id — what the revealed key actually opens. */
	newFileId: number;
	/** False when the replaced original could not be purged: the conversion
	 * succeeded but left a duplicate behind. The key is still valid. */
	committed: boolean;
}

/** Mutations for the encryption panel. Each one invalidates the whole drive:
 * a folder re-key rewrites files at every level below it. */
export function useEncryption() {
	const invalidate = useInvalidateDrive();
	const [busy, setBusy] = useState(false);

	const run = useCallback(
		async <T>(label: string, op: () => Promise<T>): Promise<T | null> => {
			setBusy(true);
			try {
				return await op();
			} catch (err) {
				toast.error(label, { description: errorMessage(err) });
				return null;
			} finally {
				setBusy(false);
				invalidate();
			}
		},
		[invalidate],
	);

	const setEncryption = useCallback(
		(item: DriveItem, change: EncryptionChange) =>
			run("Couldn't change the encryption", async () => {
				const result =
					item.kind === "folder"
						? await encryptionService.setDirectory(item.id, change)
						: await encryptionService.setFile(item.id, change);
				const rewritten =
					"files_reencrypted" in result ? result.files_reencrypted : 0;
				toast.success("Encryption updated", {
					description: rewritten
						? `${rewritten} file${rewritten === 1 ? "" : "s"} re-encrypted.`
						: undefined,
				});
				return result;
			}),
		[run],
	);

	const setAccessSecret = useCallback(
		(item: DriveItem, password?: string) =>
			run("Couldn't change the access key", async () => {
				const result =
					item.kind === "folder"
						? await encryptionService.setDirectoryAccess(item.id, password)
						: await encryptionService.setFileAccess(item.id, password);
				toast.success(
					password ? "Password lock set" : "New random access key issued",
				);
				return result;
			}),
		[run],
	);

	/** Not routed through `run`: a seal commits to the database *before* the
	 * response carrying the only copy of the key is written, so a dropped
	 * connection is not "nothing happened" — it is a file that is now
	 * permanently unreadable. A generic "couldn't seal" toast would tell the
	 * user the opposite of the truth, so a transport failure gets its own copy. */
	const seal = useCallback(
		async (fileId: number, password?: string) => {
			setBusy(true);
			try {
				return await encryptionService.seal(fileId, password);
			} catch (err) {
				if (err instanceof ApiError) {
					toast.error("Couldn't seal the file", {
						description: errorMessage(err),
					});
				} else {
					toast.error("The seal may have completed", {
						description:
							"The connection dropped before the key arrived. Reload and check this file's encryption before retrying — if it now says “sealed”, the key was lost in transit and the file cannot be recovered.",
						duration: 30_000,
					});
				}
				return null;
			} finally {
				setBusy(false);
				invalidate();
			}
		},
		[invalidate],
	);

	return { setEncryption, setAccessSecret, seal, busy };
}

/**
 * The browser half of an end-to-end conversion.
 *
 * The server has no key for `client`/`sealed` content, so there is no
 * server-side path into or out of those modes -- the bytes have to come down,
 * be transformed here, and go back up as a new file. The old file is destroyed
 * only after the replacement is confirmed (`POST /files/:id/e2e-conversion`),
 * so an interrupted conversion leaves a duplicate rather than a hole.
 */
export function useE2EConversion() {
	const invalidate = useInvalidateDrive();
	const [progress, setProgress] = useState<ConversionProgress | null>(null);
	const [busy, setBusy] = useState(false);

	const convert = useCallback(
		async (args: {
			file: FileObject;
			/** What the replacement should be. */
			target: EncryptionMode;
			/** Needed when the *current* file is client/sealed: the key that opens it. */
			currentKey?: Uint8Array | null;
			/** Reuse one key across a batch instead of minting one per file. */
			presetKey?: Uint8Array;
			/** Null only when nothing was uploaded — i.e. there is no key to save
			 * and nothing was left behind. Every other outcome returns a result so
			 * the caller can surface the key. */
		}): Promise<ConversionResult | null> => {
			const { file, target, currentKey, presetKey } = args;
			const name = file.original_filename;
			setBusy(true);
			try {
				setProgress({ phase: "downloading", percent: 0, filename: name });
				// The owner's own read: no link involved, so a limited share link
				// doesn't spend a use to re-encrypt its own file.
				let payload = await encryptionService.content(file.id);

				if (
					file.encryption_mode === "client" ||
					file.encryption_mode === "sealed"
				) {
					if (!currentKey) throw new Error("The current key is required");
					setProgress({ phase: "decrypting", percent: 0, filename: name });
					payload = await decryptBlob(payload, currentKey, (percent) =>
						setProgress({ phase: "decrypting", percent, filename: name }),
					);
				}

				const outcome = await performUpload({
					file: new File([payload], name, {
						type: file.content_type ?? "application/octet-stream",
					}),
					options: {
						encryption_mode: target,
						directory_id: file.directory_id,
					},
					presetKey: target === "client" ? presetKey : undefined,
					onProgress: ({ phase, percent }) =>
						setProgress({
							phase: phase === "finalizing" ? "finishing" : phase,
							percent,
							filename: name,
						}),
				});

				setProgress({ phase: "finishing", percent: 100, filename: name });
				// The new file already exists and, for a client-mode target, only
				// `outcome.clientKeyB64` can ever open it. If the commit fails the
				// conversion is incomplete — but withholding the key here would
				// strand that file permanently, so it is surfaced either way and
				// `committed: false` tells the caller to say so out loud.
				try {
					await encryptionService.commitConversion(
						outcome.result.file_id,
						file.id,
					);
				} catch (err) {
					toast.error("The replaced file could not be removed", {
						description: `${errorMessage(err)} — the converted copy is safe; delete “${name}” manually.`,
					});
					return {
						clientKeyB64: outcome.clientKeyB64,
						newFileId: outcome.result.file_id,
						committed: false,
					};
				}
				toast.success("Converted", {
					description:
						target === "client"
							? "Save the new key — the server has no copy of it."
							: `“${name}” is now ${target === "none" ? "unencrypted" : "server-encrypted"}.`,
				});
				return {
					clientKeyB64: outcome.clientKeyB64,
					newFileId: outcome.result.file_id,
					committed: true,
				};
			} catch (err) {
				toast.error("Conversion failed", { description: errorMessage(err) });
				return null;
			} finally {
				setBusy(false);
				setProgress(null);
				invalidate();
			}
		},
		[invalidate],
	);

	return { convert, progress, busy };
}
