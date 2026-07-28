import { useQuery } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import {
	publicService,
	rawPath,
} from "@/features/download/services/publicService";
import type { EncryptionMode } from "@/features/files/types";
import { base64UrlToBytes } from "@/lib/base64url";
import { saveBlob } from "@/lib/download";
import { createZip } from "@/lib/zip";
import { decryptBlob } from "@/workers/aeadClient";
import {
	dirZipPath,
	type PublicDirMember,
	publicDirService,
} from "../services/publicDirService";

export function useDirInfo(slug: string | undefined) {
	return useQuery({
		queryKey: ["public", "dir", slug],
		queryFn: () => publicDirService.info(slug!),
		enabled: !!slug,
		retry: false,
	});
}

/** Download a single member (navigate for none/server, decrypt for client). */
export function downloadMember(
	member: PublicDirMember,
	mode: EncryptionMode,
	keys: { clientKey?: string | null; serverKey?: string | null },
) {
	if (mode === "client") {
		if (!keys.clientKey) {
			toast.error("Missing decryption key (#ek=).");
			return Promise.resolve();
		}
		const keyBytes = base64UrlToBytes(keys.clientKey);
		return publicService
			.fetchRaw(member.slug)
			.then((cipher) => decryptBlob(cipher, keyBytes))
			.then((plain) => saveBlob(plain, member.filename))
			.catch((e) =>
				toast.error(e instanceof Error ? e.message : "Download failed"),
			);
	}
	window.location.assign(
		rawPath(member.slug, mode === "server" ? keys.serverKey : undefined),
	);
	return Promise.resolve();
}

/** Download the whole folder as a ZIP. */
export function useFolderZip(
	slug: string,
	title: string,
	mode: EncryptionMode,
) {
	const [status, setStatus] = useState<"idle" | "working" | "done" | "error">(
		"idle",
	);
	const [progress, setProgress] = useState({ done: 0, total: 0 });

	const downloadAll = useCallback(
		async (
			members: PublicDirMember[],
			keys: { clientKey?: string | null; serverKey?: string | null },
		) => {
			// Server streams the ZIP for none/server modes.
			if (mode !== "client") {
				window.location.assign(
					dirZipPath(slug, mode === "server" ? keys.serverKey : undefined),
				);
				return;
			}
			if (!keys.clientKey) {
				toast.error("Missing decryption key (#ek=) for this folder.");
				return;
			}
			const keyBytes = base64UrlToBytes(keys.clientKey);
			setStatus("working");
			setProgress({ done: 0, total: members.length });
			try {
				const entries: { name: string; data: Uint8Array }[] = [];
				for (let i = 0; i < members.length; i++) {
					const cipher = await publicService.fetchRaw(members[i].slug);
					const plain = await decryptBlob(cipher, keyBytes);
					entries.push({
						name: members[i].filename,
						data: new Uint8Array(await plain.arrayBuffer()),
					});
					setProgress({ done: i + 1, total: members.length });
				}
				saveBlob(createZip(entries), `${title || "folder"}.zip`);
				setStatus("done");
				toast.success("Folder downloaded & decrypted");
			} catch (err) {
				setStatus("error");
				toast.error(
					err instanceof Error ? err.message : "Folder download failed",
				);
			}
		},
		[slug, title, mode],
	);

	return { downloadAll, status, progress };
}
