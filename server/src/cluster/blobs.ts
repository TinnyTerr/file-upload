import { createWriteStream, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { AppState } from "../appState.ts";
import type { ClusterNodeRow } from "../db/rows.ts";
import { getLogger } from "../logging.ts";
import { touchBlobAccess } from "./cacheEviction.ts";
import { ClusterHTTPError, openStream } from "./http.ts";

/** Mirrors app/cluster/blobs.py. */

const log = getLogger("app.cluster.blobs");

/** Try each active peer in turn for a content-addressed blob, streaming the
 * first hit to `dest`. Returns true on success.
 *
 * Iterating peers (rather than consulting a location registry) keeps
 * failover simple and correct for a small cluster: any peer that still holds
 * the bytes can serve them, so a single downed node never makes a
 * fully-replicated file unavailable. Skips peers whose heartbeat marks them
 * inactive. */
export async function fetchBlobFromPeers(
	state: AppState,
	opts: {
		storedSha256: string;
		transformKey: string;
		dest: string;
		blobId?: number;
	},
): Promise<boolean> {
	const peers = state.db
		.all<ClusterNodeRow>("SELECT * FROM cluster_nodes WHERE active = 1")
		.filter((n) => n.base_url && n.token);

	mkdirSync(dirname(opts.dest), { recursive: true });
	for (const peer of peers) {
		const url = `${peer.base_url.replace(/\/$/, "")}/api/cluster/blobs/${opts.storedSha256}?transform=${encodeURIComponent(opts.transformKey)}`;
		let resp: Response;
		try {
			resp = await openStream(url, peer.token, 30_000);
		} catch (err) {
			if (err instanceof ClusterHTTPError) continue;
			throw err;
		}
		const tmp = `${opts.dest}.peer.tmp`;
		try {
			if (!resp.body) throw new Error("empty response body");
			await pipeline(
				Readable.fromWeb(resp.body as never),
				createWriteStream(tmp),
			);
			renameSync(tmp, opts.dest);
			log.info(
				`fetched blob ${opts.storedSha256.slice(0, 12)} from peer ${peer.base_url}`,
			);
			// This node just pulled the bytes in -- count it as a fresh cache
			// entry so cluster/cacheEviction.ts's LRU clock starts now, not at
			// whatever created the (replicated) content_blobs row.
			touchBlobAccess(state.db, opts.blobId);
			return true;
		} catch {
			try {
				unlinkSync(tmp);
			} catch {
				// best-effort
			}
			log.warning(
				`failed streaming blob ${opts.storedSha256.slice(0, 12)} from ${peer.base_url}`,
			);
		}
	}
	return false;
}
