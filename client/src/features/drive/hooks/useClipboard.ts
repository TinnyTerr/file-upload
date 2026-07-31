import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import type { DriveItem } from "../lib/items";
import type { DriveLocation } from "../types";
import type { useDriveMutations } from "./useDriveMutations";

export interface ClipboardState {
	mode: "cut" | "copy";
	/** The whole rows, not just ids: a paste happens in a *different* folder
	 * from the cut, so the source level is no longer loaded by then and the
	 * ids alone couldn't be turned back into anything actionable. */
	items: DriveItem[];
	sourceDirId: number | null;
}

const STORAGE_KEY = "fu_clipboard@v1";

/**
 * Cut / copy / paste.
 *
 * **Cut + paste is a move**; **copy + paste is a server-side duplicate**
 * (`POST /files/:id/copy`, `POST /directories/:id/copy`), which is a
 * `ref_count` bump on a blob that is already on disk. It is deliberately not a
 * browser re-upload: that would re-encrypt under a different key, break
 * `client`/`sealed` files outright, and spend quota and bandwidth on something
 * the blob store does by incrementing an integer.
 *
 * The one thing the server can't do is copy *into* an end-to-end folder — it
 * holds no key for one — so that paste comes back as a 409 naming the folder.
 */

function load(): ClipboardState | null {
	try {
		const raw = sessionStorage.getItem(STORAGE_KEY);
		return raw ? (JSON.parse(raw) as ClipboardState) : null;
	} catch {
		return null;
	}
}

export function useClipboard(
	loc: DriveLocation,
	mutations: ReturnType<typeof useDriveMutations>,
) {
	const [clipboard, setClipboard] = useState<ClipboardState | null>(load);

	useEffect(() => {
		try {
			if (clipboard)
				sessionStorage.setItem(STORAGE_KEY, JSON.stringify(clipboard));
			else sessionStorage.removeItem(STORAGE_KEY);
		} catch {
			// Session storage is a convenience here, not a requirement.
		}
	}, [clipboard]);

	const currentDirId = loc === "root" ? null : loc;

	const put = useCallback(
		(mode: "cut" | "copy", selected: DriveItem[]) => {
			if (!selected.length) return;
			setClipboard({ mode, items: selected, sourceDirId: currentDirId });
			const n = `${selected.length} item${selected.length === 1 ? "" : "s"}`;
			toast.success(`${n} ready to ${mode === "cut" ? "move" : "copy"}`, {
				description: "Open the destination folder and press Ctrl+V.",
			});
		},
		[currentDirId],
	);

	const cut = useCallback(
		(selected: DriveItem[]) => put("cut", selected),
		[put],
	);
	const copy = useCallback(
		(selected: DriveItem[]) => put("copy", selected),
		[put],
	);

	/** Non-null is the reason a paste can't happen, shown in the tooltip. */
	const pasteReason = !clipboard
		? "Nothing has been cut or copied."
		: // A copy into the same folder is a legitimate duplicate; a *move* there
			// is a no-op.
			clipboard.mode === "cut" && clipboard.sourceDirId === currentDirId
			? "These items are already in this folder."
			: clipboard.items.some(
						(i) => i.kind === "folder" && i.id === currentDirId,
					)
				? "A folder can't be pasted into itself."
				: null;

	const paste = useCallback(async () => {
		if (!clipboard || pasteReason) return;
		if (clipboard.mode === "cut") {
			await mutations.move(clipboard.items, currentDirId);
			setClipboard(null);
			return;
		}
		// A copy stays on the clipboard, as it does everywhere else — pasting the
		// same thing into three folders is the whole point of Copy.
		await mutations.copy(clipboard.items, currentDirId);
	}, [clipboard, pasteReason, mutations, currentDirId]);

	const isCut = useCallback(
		(item: DriveItem) =>
			clipboard?.mode === "cut" &&
			clipboard.items.some((i) => i.kind === item.kind && i.id === item.id),
		[clipboard],
	);

	return {
		clipboard,
		cut,
		copy,
		paste,
		pasteReason,
		isCut,
		clear: () => setClipboard(null),
	};
}
