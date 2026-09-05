/**
 * Worker entry for one digest over one file.
 *
 * Hashing is the only CPU-bound step in the upload pipeline that had no natural
 * yield point. `encryptFile` awaits a read and a write per 2 MB chunk, and
 * node:zlib and sharp both dispatch to libuv's threadpool -- all three leave the
 * event loop responsive. A digest loop does not: `for await (const chunk of
 * createReadStream(...))` looks like it yields, but the read-ahead keeps the
 * iterator's buffer full, so the whole file hashes as one uninterrupted block.
 * Measured on 256 MB, the loop stalled the event loop for 2028 ms of a 2047 ms
 * run -- extrapolated to the 6.4 GB upload in CLAUDE.md, that is ~48 s during
 * which this process serves nothing: no login, no download, no cluster
 * heartbeat, no torrent poll. Running it detached (routes/files.ts's 202
 * finalize) does not help; a detached async function is still on this event
 * loop.
 *
 * The worker takes a *path*, not bytes: it opens the file itself, so nothing
 * crosses the thread boundary but a string in and a hex digest out. That is why
 * the offload is free -- 2076 ms in a worker against 2047 ms inline.
 *
 * One algorithm per message on purpose. Two digests in one worker share a
 * thread and serialize (512 MB: sha256+md5 together = 2443 ms); one worker each
 * runs them in parallel (1702 ms) and lands within 4% of sha256 alone (1639 ms),
 * so md5 costs essentially nothing. Reading the file twice is not the
 * bottleneck.
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

/** Matches the read size the rest of the storage layer streams at. */
const READ_SIZE = 1024 * 1024;

export interface HashRequest {
	id: number;
	path: string;
	algo: string;
}

export type HashResponse =
	| { id: number; digest: string }
	| { id: number; error: string };

declare const self: Worker;

self.onmessage = async (event: MessageEvent<HashRequest>) => {
	const { id, path, algo } = event.data;
	try {
		const hash = createHash(algo);
		const stream = createReadStream(path, { highWaterMark: READ_SIZE });
		for await (const chunk of stream as AsyncIterable<Buffer>) {
			hash.update(chunk);
		}
		postMessage({ id, digest: hash.digest("hex") } satisfies HashResponse);
	} catch (err) {
		postMessage({
			id,
			error: err instanceof Error ? err.message : String(err),
		} satisfies HashResponse);
	}
};
