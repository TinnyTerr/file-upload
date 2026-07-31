import { useQueryClient } from "@tanstack/react-query";
import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useRef,
	useState,
} from "react";
import { toast } from "sonner";
import { dirKeys } from "@/features/directories/hooks/queryKeys";
import { driveKeys } from "@/features/drive/hooks/queryKeys";
import {
	performUpload,
	type UploadOutcome,
	type UploadPhase,
} from "../lib/uploadCore";
import type { UploadOptions } from "../types";
import { filesKeys } from "./queryKeys";

export interface UploadItem {
	id: string;
	filename: string;
	size: number;
	status: "queued" | UploadPhase | "done" | "error" | "cancelled";
	percent: number;
	error?: string;
	outcome?: UploadOutcome;
}

let seq = 0;

interface UploadState {
	items: UploadItem[];
	completed: UploadItem[];
	busy: boolean;
	start: (
		files: File[],
		options: UploadOptions,
		/** One fixed client key for the whole batch, e.g. the key of the
		 * end-to-end folder these files are being uploaded into. */
		presetKey?: Uint8Array,
	) => Promise<{ filename: string; outcome: UploadOutcome }[]>;
	cancel: (id: string) => void;
	clearFinished: () => void;
	reset: () => void;
}

const UploadContext = createContext<UploadState | null>(null);

/**
 * Holds upload progress in a context above the routed pages, so an in-flight
 * upload (and its UI) survives navigating away from the Files tab instead of
 * being torn down with the component that started it.
 */
export function UploadProvider({ children }: { children: ReactNode }) {
	const qc = useQueryClient();
	const [items, setItems] = useState<UploadItem[]>([]);
	const [busy, setBusy] = useState(false);
	const controllers = useRef(new Map<string, AbortController>());

	const update = useCallback((id: string, patch: Partial<UploadItem>) => {
		setItems((prev) =>
			prev.map((it) => (it.id === id ? { ...it, ...patch } : it)),
		);
	}, []);

	const start = useCallback(
		async (
			files: File[],
			options: UploadOptions,
			presetKey?: Uint8Array,
		): Promise<{ filename: string; outcome: UploadOutcome }[]> => {
			if (!files.length) return [];
			const succeeded: { filename: string; outcome: UploadOutcome }[] = [];
			const queued: UploadItem[] = files.map((f) => ({
				id: `u${++seq}`,
				filename: f.name,
				size: f.size,
				status: "queued",
				percent: 0,
			}));
			setItems((prev) => [...prev, ...queued]);
			setBusy(true);

			// Sequential uploads keep memory + bandwidth predictable.
			for (let i = 0; i < files.length; i++) {
				const item = queued[i];
				const controller = new AbortController();
				controllers.current.set(item.id, controller);
				try {
					const outcome = await performUpload({
						file: files[i],
						options,
						presetKey,
						signal: controller.signal,
						onProgress: ({ phase, percent }) =>
							update(item.id, { status: phase, percent }),
					});
					update(item.id, { status: "done", percent: 100, outcome });
					succeeded.push({ filename: item.filename, outcome });
				} catch (err) {
					if (err instanceof DOMException && err.name === "AbortError") {
						update(item.id, { status: "cancelled" });
					} else {
						const msg = err instanceof Error ? err.message : "Upload failed";
						update(item.id, { status: "error", error: msg });
						toast.error(`Upload failed: ${item.filename}`, {
							description: msg,
						});
					}
				} finally {
					controllers.current.delete(item.id);
				}
			}

			setBusy(false);
			qc.invalidateQueries({ queryKey: filesKeys.list });
			qc.invalidateQueries({ queryKey: filesKeys.usage });
			// The Drive explorer shows one level at a time; the upload may have
			// landed in a level other than the one currently on screen.
			qc.invalidateQueries({ queryKey: driveKeys.all });
			qc.invalidateQueries({ queryKey: dirKeys.list });
			return succeeded;
		},
		[qc, update],
	);

	const cancel = useCallback((id: string) => {
		controllers.current.get(id)?.abort();
	}, []);

	const clearFinished = useCallback(() => {
		setItems((prev) =>
			prev.filter((it) => !["done", "error", "cancelled"].includes(it.status)),
		);
	}, []);

	const reset = useCallback(() => {
		for (const c of controllers.current.values()) c.abort();
		controllers.current.clear();
		setItems([]);
	}, []);

	const completed = items.filter((it) => it.status === "done" && it.outcome);

	return (
		<UploadContext.Provider
			value={{ items, completed, busy, start, cancel, clearFinished, reset }}
		>
			{children}
		</UploadContext.Provider>
	);
}

export function useUpload() {
	const ctx = useContext(UploadContext);
	if (!ctx) throw new Error("useUpload must be used within UploadProvider");
	return ctx;
}
