import { useCallback, useRef, useState } from "react";
import { verifyFolderKey } from "@/features/directories/lib/folderKey";
import type { EncryptionMode } from "@/features/files/types";
import { publicDirService } from "../services/publicDirService";

export interface HeldKey {
	/** `server` secrets travel as `?ek=`; `client` keys are used locally. */
	mode: "server" | "client";
	/** The `?ek=` value, for server mode. */
	secret?: string;
	/** The raw 32-byte key, for client mode. */
	bytes?: Uint8Array;
}

export interface FolderKeys {
	/** Whether a node can be opened: unencrypted, or we hold its key. */
	isUnlocked: (node: {
		encryption_mode: EncryptionMode;
		key_scope: string;
	}) => boolean;
	held: (keyScope: string) => HeldKey | undefined;
	/** Verifies and stores a key for one node. Throws with a readable message. */
	unlock: (args: {
		slug: string;
		dirId: number | null;
		keyScope: string;
		mode: EncryptionMode;
		keyCheckBlob: string | null;
		value: string;
	}) => Promise<void>;
}

/** Strip a key out of a pasted share URL, or take it as given. */
function extractKey(value: string, marker: "#ek=" | "?ek="): string {
	const trimmed = value.trim();
	const idx = trimmed.indexOf(marker);
	if (idx === -1) return trimmed;
	return trimmed.slice(idx + marker.length).split(/[?&#]/)[0];
}

/**
 * The keys a visitor has proved for one shared folder tree, kept in memory for
 * the life of the page.
 *
 * Keyed by `key_scope` rather than by folder id, so unlocking a break point
 * once opens every descendant that inherits from it — which is the whole point
 * of inheritance — while a sibling that broke away still asks for its own.
 */
export function useFolderKeys(): FolderKeys {
	const [, bump] = useState(0);
	const keys = useRef(new Map<string, HeldKey>());

	const held = useCallback(
		(keyScope: string) => keys.current.get(keyScope),
		[],
	);

	const isUnlocked = useCallback(
		(node: { encryption_mode: EncryptionMode; key_scope: string }) => {
			if (node.encryption_mode === "none") return true;
			return keys.current.has(node.key_scope);
		},
		[],
	);

	const unlock = useCallback<FolderKeys["unlock"]>(
		async ({ slug, dirId, keyScope, mode, keyCheckBlob, value }) => {
			if (mode === "client" || mode === "sealed") {
				if (!keyCheckBlob) {
					throw new Error(
						"This folder has no key check stored, so a key can't be verified.",
					);
				}
				// Verified locally against the folder's own check blob — an
				// end-to-end key must never be sent to the server to be checked.
				const bytes = await verifyFolderKey(
					extractKey(value, "#ek="),
					keyCheckBlob,
				);
				keys.current.set(keyScope, { mode: "client", bytes });
				bump((n) => n + 1);
				return;
			}
			const secret = extractKey(value, "?ek=");
			// Server-side check, which is also where a password-locked node's
			// guess counter lives.
			await publicDirService.unlock(slug, dirId, secret);
			keys.current.set(keyScope, { mode: "server", secret });
			bump((n) => n + 1);
		},
		[],
	);

	return { isUnlocked, held, unlock };
}
