import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { errorMessage } from "@/config/api";
import type { ShareEntry } from "@/features/files/components/ShareModal";
import { filesKeys } from "@/features/files/hooks/queryKeys";
import { folderUrl } from "@/features/files/lib/shareUrl";
import { performUpload } from "@/features/files/lib/uploadCore";
import type { EncryptionMode } from "@/features/files/types";
import { createFolderKeyMaterial } from "../lib/folderKey";
import { dirService } from "../services/dirService";
import { dirKeys } from "./queryKeys";

export interface FolderProgress {
	total: number;
	completed: number;
	current?: string;
	percent: number;
}

export function useFolderUpload() {
	const qc = useQueryClient();
	const [progress, setProgress] = useState<FolderProgress | null>(null);
	const [busy, setBusy] = useState(false);

	const upload = useCallback(
		async (
			title: string,
			mode: EncryptionMode,
			files: File[],
		): Promise<ShareEntry | null> => {
			if (!files.length) return null;
			setBusy(true);
			setProgress({ total: files.length, completed: 0, percent: 0 });
			try {
				const keyMaterial =
					mode === "client" ? await createFolderKeyMaterial() : null;
				const dir = await dirService.create({
					title,
					encryption_mode: mode,
					key_check_blob: keyMaterial?.keyCheckBlob ?? null,
				});

				for (let i = 0; i < files.length; i++) {
					setProgress({
						total: files.length,
						completed: i,
						current: files[i].name,
						percent: 0,
					});
					await performUpload({
						file: files[i],
						options: { encryption_mode: mode, directory_id: dir.id },
						presetKey: keyMaterial?.key,
						onProgress: ({ percent }) =>
							setProgress((p) => (p ? { ...p, percent } : p)),
					});
				}

				setProgress({
					total: files.length,
					completed: files.length,
					percent: 100,
				});
				qc.invalidateQueries({ queryKey: dirKeys.list });
				qc.invalidateQueries({ queryKey: filesKeys.usage });
				toast.success("Folder uploaded", {
					description: `${files.length} files in “${title}”`,
				});

				return {
					filename: title,
					mode,
					baseUrl: folderUrl(dir.slug),
					accessKey: dir.access_key,
					clientKeyB64: keyMaterial?.clientKeyB64 ?? null,
				};
			} catch (err) {
				toast.error("Folder upload failed", { description: errorMessage(err) });
				return null;
			} finally {
				setBusy(false);
			}
		},
		[qc],
	);

	return { upload, progress, busy };
}
