import { useQuery } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import {
	publicService,
	rawPath,
} from "@/features/download/services/publicService";
import { saveBlob } from "@/lib/download";
import { createZip } from "@/lib/zip";
import { decryptBlob } from "@/workers/aeadClient";
import {
	dirZipPath,
	type PublicDirMember,
	publicDirService,
} from "../services/publicDirService";
import type { FolderKeys } from "./useFolderKeys";

export function useDirInfo(slug: string | undefined, dir: number | null) {
	return useQuery({
		queryKey: ["public", "dir", slug, dir ?? "entry"],
		queryFn: () => publicDirService.info(slug!, dir),
		enabled: !!slug,
		retry: false,
	});
}

/** Download one member using whichever key its own scope resolves to. */
export function downloadMember(member: PublicDirMember, keys: FolderKeys) {
	const key = keys.held(member.key_scope);
	if (
		member.encryption_mode === "client" ||
		member.encryption_mode === "sealed"
	) {
		if (!key?.bytes) {
			toast.error("This file needs its own key before it can be decrypted.");
			return Promise.resolve();
		}
		const bytes = key.bytes;
		return publicService
			.fetchRaw(member.slug)
			.then((cipher) => decryptBlob(cipher, bytes))
			.then((plain) => saveBlob(plain, member.filename))
			.catch((e) =>
				toast.error(e instanceof Error ? e.message : "Download failed"),
			);
	}
	window.location.assign(
		rawPath(
			member.slug,
			member.encryption_mode === "server" ? key?.secret : undefined,
		),
	);
	return Promise.resolve();
}

/**
 * Download one folder level as a ZIP.
 *
 * For `none`/`server` the server streams it, following the subtree as far as
 * the presented key reaches. An end-to-end folder has to be assembled here,
 * because only this browser can decrypt its members.
 */
export function useFolderZip(slug: string, keys: FolderKeys) {
	const [status, setStatus] = useState<"idle" | "working" | "done" | "error">(
		"idle",
	);
	const [progress, setProgress] = useState({ done: 0, total: 0 });

	const downloadAll = useCallback(
		async (args: {
			dir: number | null;
			title: string;
			keyScope: string;
			mode: string;
			members: PublicDirMember[];
		}) => {
			const key = keys.held(args.keyScope);
			if (args.mode !== "client" && args.mode !== "sealed") {
				window.location.assign(
					dirZipPath(slug, { dir: args.dir, accessKey: key?.secret }),
				);
				return;
			}
			if (!key?.bytes) {
				toast.error("Unlock this folder first.");
				return;
			}
			const bytes = key.bytes;
			setStatus("working");
			setProgress({ done: 0, total: args.members.length });
			try {
				const entries: { name: string; data: Uint8Array }[] = [];
				for (let i = 0; i < args.members.length; i++) {
					const cipher = await publicService.fetchRaw(args.members[i].slug);
					const plain = await decryptBlob(cipher, bytes);
					entries.push({
						name: args.members[i].filename,
						data: new Uint8Array(await plain.arrayBuffer()),
					});
					setProgress({ done: i + 1, total: args.members.length });
				}
				saveBlob(createZip(entries), `${args.title || "folder"}.zip`);
				setStatus("done");
				toast.success("Folder downloaded & decrypted");
			} catch (err) {
				setStatus("error");
				toast.error(
					err instanceof Error ? err.message : "Folder download failed",
				);
			}
		},
		[slug, keys],
	);

	return { downloadAll, status, progress };
}
