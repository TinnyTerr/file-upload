import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { errorMessage } from "@/config/api";
import {
	createFolderKeyCheckBlob,
	createFolderKeyMaterial,
} from "@/features/directories/lib/folderKey";
import { dirService } from "@/features/directories/services/dirService";
import type { Directory } from "@/features/directories/types";
import { performUpload } from "@/features/files/lib/uploadCore";
import type { EncryptionMode, UploadOptions } from "@/features/files/types";
import { useInvalidateDrive } from "./useDrive";

export interface TreeProgress {
	total: number;
	completed: number;
	current?: string;
	percent: number;
}

/** Split "Photos/2024/beach.jpg" into ["Photos", "2024"] — the folder chain the
 * file needs to land in, relative to wherever the upload was started. */
function folderChain(file: File): string[] {
	const rel = (file as File & { webkitRelativePath?: string })
		.webkitRelativePath;
	if (!rel) return [];
	return rel.split("/").slice(0, -1).filter(Boolean);
}

/**
 * Upload a picked OS folder, recreating its directory structure underneath the
 * currently open folder rather than flattening it into one bundle.
 *
 * Encryption follows the same rule the backend uses: every folder created here
 * is a child, so it inherits, and every file derives its mode from the folder
 * it lands in. That means one key covers the whole tree -- for a client-mode
 * destination the caller passes the (already verified) folder key in
 * `presetKey` and it is reused at every level.
 */
export function useDriveTreeUpload() {
	const invalidate = useInvalidateDrive();
	const [progress, setProgress] = useState<TreeProgress | null>(null);
	const [busy, setBusy] = useState(false);

	// Closing the tab mid-tree-upload abandons whatever hasn't reached the
	// server yet, with no way to resume it -- worth an "are you sure".
	useEffect(() => {
		if (!busy) return;
		const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault();
		window.addEventListener("beforeunload", onBeforeUnload);
		return () => window.removeEventListener("beforeunload", onBeforeUnload);
	}, [busy]);

	const uploadTree = useCallback(
		async (args: {
			files: File[];
			/** The open folder, or null at the root of the drive. */
			parent: Directory | null;
			/** Encryption for the top-level folder when creating one at the root. */
			rootMode?: EncryptionMode;
			/** The destination folder's client key, when it has one. */
			presetKey?: Uint8Array;
			/** Extra per-file options (lifecycle, link limits) from the form. */
			options?: Partial<UploadOptions>;
		}): Promise<{
			createdRootId: number | null;
			clientKeyB64: string | null;
		}> => {
			const { files, parent, rootMode = "none", options = {} } = args;
			if (!files.length) return { createdRootId: null, clientKeyB64: null };

			setBusy(true);
			setProgress({ total: files.length, completed: 0, percent: 0 });
			// Path (joined chain) -> directory id. "" is the destination itself.
			const dirIds = new Map<string, number | null>([["", parent?.id ?? null]]);
			let presetKey = args.presetKey;
			let clientKeyB64: string | null = null;
			let createdRootId: number | null = null;
			// A file at the destination itself takes the destination's mode; the
			// backend derives it, so what we send only matters for client mode,
			// where the browser has to do the encrypting.
			const mode: EncryptionMode = parent ? parent.encryption_mode : rootMode;

			/** Create every missing folder along `chain`, returning the deepest id. */
			const ensureChain = async (chain: string[]): Promise<number | null> => {
				let path = "";
				let parentId = parent?.id ?? null;
				for (const segment of chain) {
					path = path ? `${path}/${segment}` : segment;
					const known = dirIds.get(path);
					if (known !== undefined) {
						parentId = known;
						continue;
					}
					// Only the very first folder created at the root of the drive gets
					// to choose an encryption mode -- everything below it inherits.
					const atRoot = parentId === null;
					if (atRoot && mode === "client" && !presetKey) {
						const material = await createFolderKeyMaterial();
						presetKey = material.key;
						clientKeyB64 = material.clientKeyB64;
					}
					const created = await dirService.create(
						atRoot
							? {
									title: segment,
									encryption_mode: mode,
									key_check_blob:
										mode === "client" && presetKey
											? await createFolderKeyCheckBlob(presetKey)
											: null,
								}
							: { title: segment, parent_directory_id: parentId },
					);
					dirIds.set(path, created.id);
					createdRootId ??= created.id;
					parentId = created.id;
				}
				return parentId;
			};

			try {
				for (let i = 0; i < files.length; i++) {
					const file = files[i];
					setProgress({
						total: files.length,
						completed: i,
						current: file.name,
						percent: 0,
					});
					const directoryId = await ensureChain(folderChain(file));
					await performUpload({
						file,
						options: {
							...options,
							encryption_mode: mode,
							directory_id: directoryId,
						},
						presetKey: mode === "client" ? presetKey : undefined,
						onProgress: ({ percent }) =>
							setProgress((p) => (p ? { ...p, percent } : p)),
					});
				}
				setProgress({
					total: files.length,
					completed: files.length,
					percent: 100,
				});
				toast.success("Folder uploaded", {
					description: `${files.length} file${files.length === 1 ? "" : "s"}`,
				});
				return { createdRootId, clientKeyB64 };
			} catch (err) {
				toast.error("Folder upload failed", { description: errorMessage(err) });
				return { createdRootId, clientKeyB64 };
			} finally {
				setBusy(false);
				invalidate();
			}
		},
		[invalidate],
	);

	return { uploadTree, progress, busy };
}
