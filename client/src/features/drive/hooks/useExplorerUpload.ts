import { useCallback, useState } from "react";
import { toast } from "sonner";
import type { Directory } from "@/features/directories/types";
import type { ShareEntry } from "@/features/files/components/ShareModal";
import {
	defaultFormState,
	toUploadOptions,
	type UploadFormState,
} from "@/features/files/components/UploadOptionsForm";
import { useUpload } from "@/features/files/hooks/useUpload";
import { outcomeToShareEntry } from "@/features/files/lib/shareMapping";
import { isKeyHeldByUser } from "@/features/files/types";
import { base64UrlToBytes, bytesToBase64Url } from "@/lib/base64url";
import { useDriveTreeUpload } from "./useDriveUpload";
import { useRevealedKeys } from "./useRevealedKeys";

/** Something the user asked to upload that is waiting on a folder key. */
interface Pending {
	dir: Directory;
	files: File[];
	tree: boolean;
}

/**
 * Every way into the explorer's upload path, behind one interface.
 *
 * The old card kept the destination folder's key in its own state; there are
 * now four entry points (toolbar, drop overlay, row drop, tree drop) and they
 * cannot each keep a copy, so the key comes from the app-level map instead.
 */
export function useExplorerUpload() {
	const { start } = useUpload();
	const tree = useDriveTreeUpload();
	const { keyFor, remember, reveal } = useRevealedKeys();
	const [form, setForm] = useState<UploadFormState>(defaultFormState);
	const [shareEntries, setShareEntries] = useState<ShareEntry[]>([]);
	const [pending, setPending] = useState<Pending | null>(null);

	const keyBytesFor = useCallback(
		(dir: Directory | null): Uint8Array | undefined => {
			if (!dir || !isKeyHeldByUser(dir.encryption_mode)) return undefined;
			const ownerId = dir.inherited_from_directory_id ?? dir.id;
			const b64 = keyFor("folder", ownerId) ?? keyFor("folder", dir.id);
			return b64 ? base64UrlToBytes(b64) : undefined;
		},
		[keyFor],
	);

	/** Null when the destination is ready; the folder to unlock otherwise. */
	const blockedBy = useCallback(
		(dir: Directory | null): Directory | null => {
			if (!dir || !isKeyHeldByUser(dir.encryption_mode)) return null;
			return keyBytesFor(dir) ? null : dir;
		},
		[keyBytesFor],
	);

	const runFiles = useCallback(
		async (files: File[], dir: Directory | null, explicitKey?: Uint8Array) => {
			if (!files.length) return;
			const results = await start(
				files,
				{
					...toUploadOptions(form),
					encryption_mode: dir ? dir.encryption_mode : form.encryption_mode,
					directory_id: dir?.id ?? null,
				},
				explicitKey ?? keyBytesFor(dir),
			);
			for (const r of results) {
				if (r.outcome?.clientKeyB64 && !dir) {
					remember("file", r.outcome.result.file_id, r.outcome.clientKeyB64);
				}
			}
			const entries = results
				.map((r) => outcomeToShareEntry(r.filename, r.outcome))
				.filter((e): e is ShareEntry => e !== null);
			if (entries.length) setShareEntries(entries);
		},
		[start, form, keyBytesFor, remember],
	);

	const runTree = useCallback(
		async (files: File[], dir: Directory | null, explicitKey?: Uint8Array) => {
			if (!files.length) return;
			const { createdRootId, clientKeyB64 } = await tree.uploadTree({
				files,
				parent: dir,
				rootMode: form.encryption_mode,
				presetKey: explicitKey ?? keyBytesFor(dir),
				options: toUploadOptions(form),
			});
			if (createdRootId !== null && clientKeyB64 !== null) {
				remember("folder", createdRootId, clientKeyB64);
				const rootName =
					(
						files[0] as File & { webkitRelativePath?: string }
					)?.webkitRelativePath?.split("/")[0] || "Uploaded folder";
				reveal({
					subject: rootName,
					key: clientKeyB64,
					isPassword: false,
					reason:
						"This folder was encrypted in your browser before upload. The server never saw this key and cannot recover it.",
					refs: [{ kind: "folder", id: createdRootId }],
				});
			}
		},
		[tree, form, keyBytesFor, remember, reveal],
	);

	/** The single entry point. Queues behind the unlock prompt when the
	 * destination is end-to-end and this tab doesn't hold its key. */
	const upload = useCallback(
		async (files: File[], dir: Directory | null, isTree = false) => {
			if (!files.length) return;
			const blocked = blockedBy(dir);
			if (blocked) {
				setPending({ dir: blocked, files, tree: isTree });
				toast.info(`“${blocked.title}” is end-to-end encrypted`, {
					description: "Unlock it with its key to upload into it.",
				});
				return;
			}
			await (isTree ? runTree(files, dir) : runFiles(files, dir));
		},
		[blockedBy, runFiles, runTree],
	);

	/** Called once the unlock dialog has stored the key in the app-level map. */
	const resumePending = useCallback(
		async (unlockedKey?: Uint8Array) => {
			const queued = pending;
			setPending(null);
			if (!queued) return;
			if (unlockedKey) {
				const b64 = bytesToBase64Url(unlockedKey);
				remember(
					"folder",
					queued.dir.inherited_from_directory_id ?? queued.dir.id,
					b64,
				);
				remember("folder", queued.dir.id, b64);
			}
			await (queued.tree
				? runTree(queued.files, queued.dir, unlockedKey)
				: runFiles(queued.files, queued.dir, unlockedKey));
		},
		[pending, remember, runFiles, runTree],
	);

	return {
		form,
		setForm,
		upload,
		shareEntries,
		setShareEntries,
		pending,
		setPending,
		resumePending,
		blockedBy,
		treeProgress: tree.progress,
		treeBusy: tree.busy,
	};
}
