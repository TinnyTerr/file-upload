import { useCallback, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { ShareEntry } from "@/features/files/components/ShareModal";
import {
	fileUrl,
	folderUrl,
	rawUrl,
	shareUrl,
} from "@/features/files/lib/shareUrl";
import { useDialogs } from "@/providers/DialogProvider";
import { type DriveItem, itemKey, itemName } from "../lib/items";
import { drivePath } from "../types";
import { useDriveMutations } from "./useDriveMutations";
import { useRevealedKeys } from "./useRevealedKeys";

/** Everything the explorer can do to an item, in one place.
 *
 * Lifted out of the old `DriveListing` because the command bar, the nav tree,
 * the context menus and the keyboard map all need to invoke the *same*
 * implementations -- four copies of "delete these, but confirm first" is four
 * chances for them to disagree about what the confirmation says. */
export interface DriveActions {
	open: (item: DriveItem) => void;
	share: (item: DriveItem) => void;
	download: (items: DriveItem[]) => void;
	rename: (item: DriveItem) => void;
	encryption: (item: DriveItem) => void;
	move: (items: DriveItem[]) => void;
	remove: (items: DriveItem[]) => Promise<void>;
}

/** The server caps a zip at 500 members (`GET /api/files/batch-zip`). */
export const BATCH_ZIP_LIMIT = 500;

export function useDriveActions() {
	const navigate = useNavigate();
	const { confirm } = useDialogs();
	const { keyFor } = useRevealedKeys();
	const mutations = useDriveMutations();

	const [shareEntries, setShareEntries] = useState<ShareEntry[]>([]);
	const [moveTargets, setMoveTargets] = useState<DriveItem[] | null>(null);
	const [encryptionKey, setEncryptionKey] = useState<string | null>(null);
	const [renameKey, setRenameKey] = useState<string | null>(null);

	const remove = useCallback(
		async (targets: DriveItem[]) => {
			if (!targets.length) return;
			const folders = targets.filter((t) => t.kind === "folder").length;
			const ok = await confirm({
				title:
					targets.length === 1
						? "Delete this item?"
						: `Delete ${targets.length} items?`,
				description:
					targets.length === 1
						? `“${itemName(targets[0]!)}”${folders ? ", everything inside it," : ""} and all its links will be removed.`
						: `The selected items${folders ? ", everything inside the folders," : ""} and all their links will be removed.`,
				confirmText: "Delete",
				destructive: true,
			});
			if (ok) await mutations.remove(targets);
		},
		[confirm, mutations],
	);

	const download = useCallback(
		(items: DriveItem[]) => {
			const files = items.filter((i) => i.kind === "file");
			if (!files.length) return;
			if (files.length === 1) {
				const only = files[0]!;
				if (only.kind !== "file") return;
				const link = only.file.links[0];
				if (!link) return;
				window.open(
					shareUrl(rawUrl(link.slug), only.file.encryption_mode, {
						accessKey: only.file.access_key,
						clientKeyB64: keyFor("file", only.id),
					}),
					"_blank",
					"noopener",
				);
				return;
			}
			// One request for the whole selection. The server caps it, so the UI
			// caps it too rather than sending ids it knows will be refused.
			const ids = files.slice(0, BATCH_ZIP_LIMIT).map((f) => f.id);
			window.open(
				`/api/files/batch-zip?ids=${ids.join(",")}`,
				"_blank",
				"noopener",
			);
		},
		[keyFor],
	);

	const share = useCallback(
		(item: DriveItem) => {
			if (item.kind === "folder") {
				setShareEntries([
					{
						filename: item.dir.title,
						mode: item.dir.encryption_mode,
						baseUrl: folderUrl(item.dir.slug),
						accessKey: item.dir.access_key,
						// Only present if this tab created or unlocked the folder -- the
						// server never had this key, and it dies with the tab.
						clientKeyB64: keyFor("folder", item.id),
					},
				]);
				return;
			}
			const link = item.file.links[0];
			if (!link) return;
			setShareEntries([
				{
					filename: item.file.original_filename,
					mode: item.file.encryption_mode,
					baseUrl: fileUrl(link.slug),
					accessKey: item.file.access_key,
					clientKeyB64: keyFor("file", item.id),
				},
			]);
		},
		[keyFor],
	);

	const actions = useMemo<DriveActions>(
		() => ({
			open: (item) =>
				item.kind === "folder"
					? navigate(drivePath(item.id))
					: download([item]),
			share,
			download,
			rename: (item) => setRenameKey(itemKey(item)),
			encryption: (item) => setEncryptionKey(itemKey(item)),
			move: (items) => items.length && setMoveTargets(items),
			remove,
		}),
		[navigate, download, share, remove],
	);

	return {
		actions,
		mutations,
		shareEntries,
		setShareEntries,
		moveTargets,
		setMoveTargets,
		encryptionKey,
		setEncryptionKey,
		renameKey,
		setRenameKey,
	};
}
