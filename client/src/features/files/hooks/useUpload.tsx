import { useQueryClient } from "@tanstack/react-query";
import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useRef,
	useState,
} from "react";
import { toast } from "sonner";
import { useAuth } from "@/features/auth/hooks/auth";
import { dirKeys } from "@/features/directories/hooks/queryKeys";
import { driveKeys } from "@/features/drive/hooks/queryKeys";
import { formatBytes } from "@/lib/bytes";
import {
	performUpload,
	type UploadOutcome,
	type UploadPhase,
} from "../lib/uploadCore";
import type { UploadOptions } from "../types";
import { filesKeys } from "./queryKeys";
import { useUsage } from "./useUsage";

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
	/** Re-runs a failed or cancelled item with the same file and options it
	 * was originally queued with. No-op once the tab holding the `File` has
	 * navigated away and cleared the queue. */
	retry: (id: string) => void;
	clearFinished: () => void;
	reset: () => void;
}

/** What `retry` needs that a finished `UploadItem` doesn't carry: the actual
 * bytes, and the options they were queued with. Kept out of `UploadItem`
 * itself so a `File` (and a raw key) never end up in something rendered or
 * inspected as ordinary list state. */
interface RetryData {
	file: File;
	options: UploadOptions;
	presetKey?: Uint8Array;
}

const UploadContext = createContext<UploadState | null>(null);

/**
 * Holds upload progress in a context above the routed pages, so an in-flight
 * upload (and its UI) survives navigating away from the Files tab instead of
 * being torn down with the component that started it.
 */
export function UploadProvider({ children }: { children: ReactNode }) {
	const qc = useQueryClient();
	const { user } = useAuth();
	// UploadProvider sits above the router and mounts on public pages too
	// (download/folder links, login) -- only ask for usage once someone is
	// actually signed in, or an anonymous visitor's tab fires a 401 for it.
	const usage = useUsage(!!user);
	const [items, setItems] = useState<UploadItem[]>([]);
	const [busy, setBusy] = useState(false);
	const controllers = useRef(new Map<string, AbortController>());
	const retryData = useRef(new Map<string, RetryData>());
	// How many uploads (the sequential batch, plus any independent retries)
	// are running right now -- `busy` is derived from whether this is above
	// zero, so a retry kicked off after its batch finished still holds the
	// beforeunload guard up, and a retry kicked off *during* a batch doesn't
	// let the batch's own completion drop it early.
	const activeCount = useRef(0);
	const beginActive = useCallback(() => {
		activeCount.current += 1;
		setBusy(true);
	}, []);
	const endActive = useCallback(() => {
		activeCount.current -= 1;
		if (activeCount.current <= 0) setBusy(false);
	}, []);

	const update = useCallback((id: string, patch: Partial<UploadItem>) => {
		setItems((prev) =>
			prev.map((it) => (it.id === id ? { ...it, ...patch } : it)),
		);
	}, []);

	const invalidateAfterUpload = useCallback(() => {
		qc.invalidateQueries({ queryKey: filesKeys.list });
		qc.invalidateQueries({ queryKey: filesKeys.usage });
		// The Drive explorer shows one level at a time; the upload may have
		// landed in a level other than the one currently on screen.
		qc.invalidateQueries({ queryKey: driveKeys.all });
		qc.invalidateQueries({ queryKey: dirKeys.list });
	}, [qc]);

	// A closed tab can't finish encrypting or uploading whatever's in flight.
	useEffect(() => {
		if (!busy) return;
		const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault();
		window.addEventListener("beforeunload", onBeforeUnload);
		return () => window.removeEventListener("beforeunload", onBeforeUnload);
	}, [busy]);

	/** Runs one already-queued item. Shared by the batch loop in `start` and
	 * by `retry`, which is really just this same step run again later. */
	const runOne = useCallback(
		async (
			id: string,
			filename: string,
			file: File,
			options: UploadOptions,
			presetKey?: Uint8Array,
		): Promise<{ filename: string; outcome: UploadOutcome } | null> => {
			const controller = new AbortController();
			controllers.current.set(id, controller);
			try {
				const outcome = await performUpload({
					file,
					options,
					presetKey,
					signal: controller.signal,
					onProgress: ({ phase, percent }) =>
						update(id, { status: phase, percent }),
				});
				update(id, { status: "done", percent: 100, outcome });
				return { filename, outcome };
			} catch (err) {
				if (err instanceof DOMException && err.name === "AbortError") {
					update(id, { status: "cancelled" });
				} else {
					const msg = err instanceof Error ? err.message : "Upload failed";
					update(id, { status: "error", error: msg });
					toast.error(`Upload failed: ${filename}`, { description: msg });
				}
				return null;
			} finally {
				controllers.current.delete(id);
			}
		},
		[update],
	);

	const start = useCallback(
		async (
			files: File[],
			options: UploadOptions,
			presetKey?: Uint8Array,
		): Promise<{ filename: string; outcome: UploadOutcome }[]> => {
			if (!files.length) return [];

			// Reject up front what the server would reject anyway -- no point
			// paying for a full encrypt+upload to learn about a 413 at the end.
			// Skipped entirely if usage hasn't loaded yet; the server still
			// enforces both limits regardless.
			let accepted = files;
			const limits = usage.data;
			if (limits) {
				accepted = [];
				let planned = 0;
				const remaining = Math.max(0, limits.quota_bytes - limits.used_bytes);
				for (const f of files) {
					if (f.size > limits.max_file_bytes) {
						toast.error(`${f.name} is too large`, {
							description: `The per-file limit is ${formatBytes(limits.max_file_bytes)}.`,
						});
						continue;
					}
					if (planned + f.size > remaining) {
						toast.error(`${f.name} won't fit in your quota`, {
							description: `Only ${formatBytes(Math.max(0, remaining - planned))} of storage remains.`,
						});
						continue;
					}
					planned += f.size;
					accepted.push(f);
				}
			}
			if (!accepted.length) return [];

			const succeeded: { filename: string; outcome: UploadOutcome }[] = [];
			const queued: UploadItem[] = accepted.map((f) => ({
				id: `u${++seq}`,
				filename: f.name,
				size: f.size,
				status: "queued",
				percent: 0,
			}));
			setItems((prev) => [...prev, ...queued]);

			beginActive();
			try {
				// Sequential uploads keep memory + bandwidth predictable.
				for (let i = 0; i < accepted.length; i++) {
					const item = queued[i];
					const file = accepted[i];
					retryData.current.set(item.id, { file, options, presetKey });
					const result = await runOne(
						item.id,
						item.filename,
						file,
						options,
						presetKey,
					);
					if (result) succeeded.push(result);
				}
			} finally {
				endActive();
			}

			if (succeeded.length) invalidateAfterUpload();
			return succeeded;
		},
		[usage.data, runOne, beginActive, endActive, invalidateAfterUpload],
	);

	const retry = useCallback(
		(id: string) => {
			const data = retryData.current.get(id);
			const filename = items.find((it) => it.id === id)?.filename;
			if (!data || !filename) return;
			update(id, {
				status: "queued",
				percent: 0,
				error: undefined,
				outcome: undefined,
			});
			beginActive();
			runOne(id, filename, data.file, data.options, data.presetKey)
				.then((result) => {
					if (result) invalidateAfterUpload();
				})
				.finally(endActive);
		},
		[items, update, runOne, beginActive, endActive, invalidateAfterUpload],
	);

	const cancel = useCallback((id: string) => {
		controllers.current.get(id)?.abort();
	}, []);

	const clearFinished = useCallback(() => {
		setItems((prev) => {
			const kept = new Set<string>();
			const next = prev.filter((it) => {
				const done = ["done", "error", "cancelled"].includes(it.status);
				if (!done) kept.add(it.id);
				return !done;
			});
			for (const id of retryData.current.keys()) {
				if (!kept.has(id)) retryData.current.delete(id);
			}
			return next;
		});
	}, []);

	const reset = useCallback(() => {
		for (const c of controllers.current.values()) c.abort();
		controllers.current.clear();
		retryData.current.clear();
		setItems([]);
	}, []);

	const completed = items.filter((it) => it.status === "done" && it.outcome);

	return (
		<UploadContext.Provider
			value={{
				items,
				completed,
				busy,
				start,
				cancel,
				retry,
				clearFinished,
				reset,
			}}
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
