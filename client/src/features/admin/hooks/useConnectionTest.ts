import { useCallback, useRef, useState } from "react";
import { errorMessage } from "@/config/api";
import {
	foldRate,
	nextChunkLength,
	RangeQueue,
} from "@/features/files/lib/chunkPlanner";
import { connectionService } from "../services/connectionService";

export interface TraceRow {
	n: number;
	offset: number;
	length: number;
	seconds: number;
	/** This chunk alone: length / seconds. */
	chunkRate: number;
	/** The running estimate after folding this chunk in. */
	smoothedRate: number;
	/** What the next chunk will be sized to. */
	nextLength: number;
}

export interface UploadRun {
	bytes: number;
	seconds: number;
	rows: TraceRow[];
	done: boolean;
}

export interface DownloadRun {
	bytes: number;
	seconds: number;
	firstByteMs: number;
}

/** Random bytes, built from one 1 MiB block so the proxy can't compress them. */
function randomBlob(bytes: number): Blob {
	const block = new Uint8Array(new ArrayBuffer(1024 * 1024));
	for (let o = 0; o < block.length; o += 65536) {
		crypto.getRandomValues(block.subarray(o, o + 65536));
	}
	const parts: Uint8Array<ArrayBuffer>[] = [];
	let left = bytes;
	while (left > 0) {
		const n = Math.min(block.length, left);
		parts.push(block.subarray(0, n));
		left -= n;
	}
	return new Blob(parts);
}

const TRACE_KEEP = 200;

/** Runs the connection probes. One at a time; starting one cancels the last. */
export function useConnectionTest() {
	const [pings, setPings] = useState<number[]>([]);
	const [download, setDownload] = useState<DownloadRun | null>(null);
	const [upload, setUpload] = useState<UploadRun | null>(null);
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const controller = useRef<AbortController | null>(null);

	const run = useCallback(
		async (label: string, task: (signal: AbortSignal) => Promise<void>) => {
			controller.current?.abort();
			const ctl = new AbortController();
			controller.current = ctl;
			setBusy(label);
			setError(null);
			try {
				await task(ctl.signal);
			} catch (err) {
				if (!ctl.signal.aborted) setError(errorMessage(err));
			} finally {
				if (controller.current === ctl) {
					controller.current = null;
					setBusy(null);
				}
			}
		},
		[],
	);

	const runPing = useCallback(
		() =>
			run("ping", async (signal) => {
				const samples: number[] = [];
				setPings([]);
				for (let i = 0; i < 5; i++) {
					samples.push(await connectionService.ping(signal));
					setPings([...samples]);
				}
			}),
		[run],
	);

	const runDownload = useCallback(
		(bytes: number) =>
			run("download", async (signal) => {
				setDownload(await connectionService.download(bytes, signal));
			}),
		[run],
	);

	/** The same sizing loop as a real chunked upload, minus encryption and
	 * finalize: the chunks are discarded by the server, so only the link is
	 * being measured. */
	const runUpload = useCallback(
		(bytes: number, concurrency: number) =>
			run("upload", async (signal) => {
				const payload = randomBlob(bytes);
				const queue = new RangeQueue(bytes, []);
				const rows: TraceRow[] = [];
				let rate: number | null = null;
				const started = performance.now();
				const publish = (done: boolean) =>
					setUpload({
						bytes,
						seconds: (performance.now() - started) / 1000,
						rows: rows.slice(-TRACE_KEEP),
						done,
					});
				publish(false);

				const worker = async () => {
					for (;;) {
						if (signal.aborted) throw new DOMException("aborted", "AbortError");
						const next = queue.take(nextChunkLength(rate));
						if (!next) return;
						const { offset, length } = next;
						const t0 = performance.now();
						await connectionService.uploadChunk(
							length,
							payload.slice(offset, offset + length),
							signal,
						);
						const seconds = (performance.now() - t0) / 1000;
						rate = foldRate(rate, { bytes: length, seconds });
						rows.push({
							n: rows.length + 1,
							offset,
							length,
							seconds,
							chunkRate: seconds > 0 ? length / seconds : 0,
							smoothedRate: rate,
							nextLength: nextChunkLength(rate),
						});
						publish(false);
					}
				};

				await Promise.all(
					Array.from({ length: Math.max(1, concurrency) }, worker),
				);
				publish(true);
			}),
		[run],
	);

	const cancel = useCallback(() => controller.current?.abort(), []);

	return {
		pings,
		download,
		upload,
		busy,
		error,
		runPing,
		runDownload,
		runUpload,
		cancel,
	};
}
