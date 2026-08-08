import { randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import type { NextFunction, Request, Response } from "express";
import { Router } from "express";
import type { AppState } from "../appState.ts";
import { recordAudit } from "../audit.ts";
import {
	applyLocalUpsert,
	type ChangeEntry,
	isChangelogTable,
	logHead,
	readChanges,
} from "../cluster/changelog.ts";
import {
	dismissConflict,
	getConflict,
	listConflicts,
	openConflictCount,
} from "../cluster/conflicts.ts";
import { masterStatus } from "../cluster/degraded.ts";
import { computeDigest } from "../cluster/digest.ts";
import { readOwnEvents } from "../cluster/eventStore.ts";
import * as clusterHttp from "../cluster/http.ts";
import { ClusterHTTPError } from "../cluster/http.ts";
import { enrollWithMaster, upsertPeer } from "../cluster/membership.ts";
import {
	type GrantRequest,
	grantReservation,
	outstandingReservations,
	renewReservation,
	settleReservation,
} from "../cluster/quota.ts";
import { applyPushedRevocation } from "../cluster/revocation.ts";
import {
	currentTiering,
	isMaster,
	measureDrift,
	promoteSelf,
	regionOf,
	retier,
	retierForNewMember,
	selfRole,
	type Tiering,
} from "../cluster/tiering.ts";
import { buildTopology } from "../cluster/topology.ts";
import { setEnvValue } from "../config.ts";
import { type ClusterNodeRow, nowIso } from "../db/rows.ts";
import { HttpError } from "../httpError.ts";
import { getLogger, queryBackendLogs } from "../logging.ts";
import { asyncHandler } from "../middleware/asyncHandler.ts";
import { clientIp, requireSession } from "../middleware/auth.ts";
import { requirePermission } from "../middleware/deps.ts";
import { requireCsrf } from "../security/csrf.ts";
import { diskUsageBytes, usedStorageBytes } from "../storage/accounting.ts";
import { safeJoin, storageRoot } from "../storage/paths.ts";

/** Mirrors app/routes/cluster.py -- both the session-authenticated
 * management surface (token reveal/rotate, node link/unlink, self/nodes) and
 * the cluster-token-authenticated node-to-node membership/replication/blob
 * handshake all live under this one router, matching the Python file's
 * single-router-mixed-deps layout. Mounted at /cluster in app.ts. */

const log = getLogger("app.cluster.routes");

interface ContentBlobRow {
	id: number;
	storage_path: string;
	stored_sha256: string;
	transform_key: string;
}

function selfStats(state: AppState) {
	const usage = diskUsageBytes();
	const tiering = currentTiering(state.db);
	const role = selfRole(state);
	const masterId = tiering?.master_node_id ?? null;
	const masterUrl =
		masterId === state.settings.nodeId
			? state.settings.nodeUrl
			: (tiering?.snapshot.find((m) => m.node_id === masterId)?.base_url ??
				null);
	return {
		node_id: state.settings.nodeId,
		name: state.settings.nodeName,
		is_master: role === "master",
		archive_enabled: state.settings.archiveEnabled,
		replication_mode: state.settings.replicationMode,
		disk_total_bytes: usage?.total ?? 0,
		disk_free_bytes: usage?.free ?? 0,
		used_bytes: usedStorageBytes(state.db),
		role,
		region: tiering ? regionOf(tiering, state.settings.nodeId) : null,
		tiering_generation: tiering?.generation ?? 0,
		master_node_id: masterId,
		master_node_url: masterUrl,
		// The whole record, so a peer's handshake either learns nothing new or
		// adopts a newer generation without a second request (cluster/tiering.ts).
		tiering,
	};
}

function mask(token: string): string {
	if (!token) return "";
	const tail = token.length > 4 ? token.slice(-4) : token;
	return `••••${tail}`;
}

function serializeNode(node: ClusterNodeRow) {
	return {
		id: node.id,
		node_id: node.node_id,
		name: node.name,
		base_url: node.base_url,
		token_preview: mask(node.token),
		active: !!node.active,
		is_master: !!node.is_master,
		// Derived from the tiering generation, never from what the node claimed.
		role: node.role,
		region: node.region,
		region_source: node.region_source,
		rtt_ms: node.rtt_ms,
		ineligible: !!node.ineligible,
		pinned_master: !!node.pinned_master,
		archive_enabled: !!node.archive_enabled,
		replication_mode: node.replication_mode,
		disk_total_bytes: node.disk_total_bytes,
		disk_free_bytes: node.disk_free_bytes,
		used_bytes: node.used_bytes,
		created_at: node.created_at,
		last_seen_at: node.last_seen_at,
		last_heartbeat_at: node.last_heartbeat_at,
	};
}

/** Whether this request carries *our* cluster token. Separate from the guard
 * below because one route (the Conflicts read-through) has to tell a peer call
 * from an operator's session and dispatch to a different auth for each — a
 * bearer that is not this token is left to the session path, where an API key
 * or OAuth token is judged on its own terms. */
export function clusterTokenPresented(state: AppState, req: Request): boolean {
	const header = req.header("authorization") ?? "";
	let presented = header.startsWith("Bearer ")
		? header.slice("Bearer ".length).trim()
		: "";
	if (!presented) presented = (req.header("x-cluster-token") ?? "").trim();
	const expected = state.clusterToken || "";
	const presentedBuf = Buffer.from(presented);
	const expectedBuf = Buffer.from(expected);
	return (
		!!presented &&
		!!expected &&
		presentedBuf.length === expectedBuf.length &&
		timingSafeEqual(presentedBuf, expectedBuf)
	);
}

/** Authenticate a request by the cluster token (Bearer or X-Cluster-Token).
 * Distinct from API-key/session auth: this single token grants read/write
 * access to node-to-node membership/replication endpoints regardless of
 * which user (if any) is behind the request. */
export function requireClusterToken(state: AppState) {
	return (req: Request, res: Response, next: NextFunction): void => {
		if (!clusterTokenPresented(state, req)) {
			res.status(401).json({ detail: "invalid cluster token" });
			return;
		}
		next();
	};
}

async function triggerEnroll(
	state: AppState,
	baseUrl: string,
	token: string,
): Promise<Record<string, unknown>> {
	// Master is derived from the tiering generation (cluster/tiering.ts) -- the
	// static NODE_ROLE config value can be stale, so check the live state.
	if (!isMaster(state)) {
		const result = { status: "skipped", reason: "this server is not a master" };
		log.info(`enroll ${baseUrl}: ${result.reason}`);
		return result;
	}
	if (!state.settings.nodeUrl) {
		const result = {
			status: "skipped",
			reason: "master has no NODE_URL to advertise",
		};
		log.warning(`enroll ${baseUrl}: ${result.reason}`);
		return result;
	}
	log.info(
		`enroll ${baseUrl}: commanding node to join master ${state.settings.nodeUrl}`,
	);
	try {
		const res = (await clusterHttp.postJson(
			// Router is mounted at /api/cluster in app.ts -- every other node-to-node
			// call in cluster/*.ts uses the /api prefix (membership.ts, blobs.ts).
			`${baseUrl}/api/cluster/enroll`,
			token,
			{ master_url: state.settings.nodeUrl, master_token: state.clusterToken },
			20_000,
		)) as Record<string, unknown> | null;
		const result = res ?? { status: "ok" };
		log.info(`enroll ${baseUrl}: node responded ${JSON.stringify(result)}`);
		return result;
	} catch (err) {
		const reason = err instanceof ClusterHTTPError ? err.message : String(err);
		log.warning(`enroll ${baseUrl}: command failed: ${reason}`);
		return { status: "error", reason };
	}
}

export function clusterRouter(state: AppState): Router {
	const router = Router();
	const { db } = state;
	const requireCluster = requirePermission(state, "can_manage_cluster");

	// ── local cluster token ─────────────────────────────────────────────────

	router.get("/token", requireCluster, (_req, res) => {
		res.json({ token: state.clusterToken });
	});

	router.post(
		"/token/rotate",
		requireSession(state),
		requireCsrf,
		requireCluster,
		(req, res) => {
			const newToken = randomBytes(32).toString("base64url");
			state.clusterToken = newToken;
			try {
				setEnvValue(state.settings.configPath, "CLUSTER_TOKEN", newToken);
			} catch {
				// best-effort persistence
			}
			recordAudit(db, {
				actor: req.currentUser!.username,
				action: "cluster.token_rotated",
				target: "cluster_token",
				ip: clientIp(state, req),
			});
			res.json({ token: newToken });
		},
	);

	// ── linked remote nodes ─────────────────────────────────────────────────

	router.get("/self", requireCluster, (_req, res) => {
		const stats = selfStats(state);
		const halts = Object.entries(state.haltRegistry.snapshot()).map(
			([scope, until]) => ({ scope, until }),
		);
		res.json({
			// stats.role already reports the role derived from the tiering
			// generation -- don't overwrite it with the static NODE_ROLE bootstrap
			// config value.
			...stats,
			node_url: state.settings.nodeUrl,
			halts,
			// What the drift counter would say right now, so the panel can show how
			// close the cluster is to re-tiering itself. Master-only: nobody else
			// counts drift, because nobody else may act on it.
			drift: isMaster(state)
				? measureDrift(db, state.settings, { persist: false })
				: null,
			// §5.5. `phase` is what the admin banner keys off: `grace` means a
			// master restart is being ridden out, `degraded` means a human has to
			// decide something.
			master_status: masterStatus(state),
			outstanding_reservations: isMaster(state)
				? outstandingReservations(db).length
				: null,
		});
	});

	// The replication graph the dashboard draws. Derived server-side from the
	// same `upstreamOf()` the pull job follows -- see cluster/topology.ts for why
	// it is not computed in the client.
	router.get("/topology", requireCluster, (_req, res) => {
		res.json(buildTopology(state));
	});

	// ── conflicts (redesign §5.8) ───────────────────────────────────────────
	//
	// Arbitration happens on the master and the record lives there, because a
	// verdict reached in two places is a verdict that can disagree with itself.
	// So the panel on any other node reads through to the master rather than
	// answering from a local table that would always be empty. `managerOrPeer`
	// is what lets one path serve both the operator's session and that
	// read-through.

	const managerOrPeer = (
		req: Request,
		res: Response,
		next: NextFunction,
	): void => {
		if (clusterTokenPresented(state, req)) {
			clusterAuth(req, res, next);
			return;
		}
		requireCluster(req, res, next);
	};

	/** The master as a peer we can call: its URL from the generation, its token
	 * from the `cluster_nodes` row we linked it through. */
	function masterPeer(): { baseUrl: string; token: string } | null {
		const tiering = currentTiering(db);
		const masterId = tiering?.master_node_id;
		if (!masterId || masterId === state.settings.nodeId) return null;
		const row = db.get<ClusterNodeRow>(
			"SELECT * FROM cluster_nodes WHERE node_id = $id",
			{ $id: masterId },
		);
		if (!row?.base_url || !row.token) return null;
		return { baseUrl: row.base_url.replace(/\/$/, ""), token: row.token };
	}

	/** Hand a conflicts request to the master. Returns false when this node *is*
	 * the master (answer locally) and throws an HttpError when it should be
	 * proxying but can't reach anyone. */
	async function proxyToMaster(
		res: Response,
		path: string,
		payload?: unknown,
	): Promise<boolean> {
		if (isMaster(state)) return false;
		const peer = masterPeer();
		if (!peer) {
			throw new HttpError(
				503,
				"conflicts are recorded on the master, and this node cannot reach one",
			);
		}
		const url = `${peer.baseUrl}/api/cluster${path}`;
		try {
			const body =
				payload === undefined
					? await clusterHttp.getJson(url, peer.token)
					: await clusterHttp.postJson(url, peer.token, payload);
			res.json(body ?? {});
		} catch (err) {
			const reason =
				err instanceof ClusterHTTPError ? err.message : String(err);
			throw new HttpError(502, `the master refused the request: ${reason}`);
		}
		return true;
	}

	router.get(
		"/conflicts",
		managerOrPeer,
		asyncHandler(async (req, res) => {
			const includeDismissed = req.query.include_dismissed === "1";
			const limit = Number(req.query.limit ?? 100) || 100;
			const query = `?include_dismissed=${includeDismissed ? 1 : 0}&limit=${limit}`;
			if (await proxyToMaster(res, `/conflicts${query}`)) return;
			res.json({
				conflicts: listConflicts(db, { includeDismissed, limit }),
				open: openConflictCount(db),
				node_id: state.settings.nodeId,
			});
		}),
	);

	router.post(
		"/conflicts/:id(\\d+)/dismiss",
		managerOrPeer,
		asyncHandler(async (req, res) => {
			const id = Number(req.params.id);
			if (await proxyToMaster(res, `/conflicts/${id}/dismiss`, {})) return;
			if (!dismissConflict(db, id)) {
				throw new HttpError(404, "no such open conflict");
			}
			res.json({ status: "dismissed" });
		}),
	);

	// Re-apply is a *fresh edit on top of the winner*, never a replay: the
	// losing payload is written as a local change, so it gets a new timestamp
	// and a base_master_seq of wherever the row now stands, and travels the
	// ordinary way. Replaying it as the original entry would re-enter it into
	// the same arbitration it already lost.
	router.post(
		"/conflicts/:id(\\d+)/reapply",
		managerOrPeer,
		asyncHandler(async (req, res) => {
			const id = Number(req.params.id);
			if (await proxyToMaster(res, `/conflicts/${id}/reapply`, {})) return;
			const conflict = getConflict(db, id);
			if (!conflict) throw new HttpError(404, "no such conflict");
			if (conflict.losing_op !== "upsert") {
				throw new HttpError(
					400,
					"the losing edit was a delete; re-apply it by deleting the row",
				);
			}
			if (!isChangelogTable(conflict.table_name)) {
				throw new HttpError(400, "that table no longer replicates");
			}
			const payload = JSON.parse(conflict.losing_payload) as Record<
				string,
				unknown
			> | null;
			if (!payload)
				throw new HttpError(400, "the losing edit carried no payload");
			const exists = db.get<{ id: number }>(
				`SELECT id FROM ${conflict.table_name} WHERE uid = $uid`,
				{ $uid: conflict.row_uid },
			);
			if (!exists) {
				throw new HttpError(409, "the row no longer exists");
			}
			applyLocalUpsert(db, conflict.table_name, conflict.row_uid, payload);
			dismissConflict(db, id);
			recordAudit(db, {
				actor: req.currentUser?.username ?? "cluster",
				action: "cluster.conflict_reapplied",
				target: `${conflict.table_name}:${conflict.row_uid}`,
				ip: clientIp(state, req),
			});
			res.json({ status: "reapplied" });
		}),
	);

	router.get("/nodes", requireCluster, (_req, res) => {
		const nodes = db.all<ClusterNodeRow>(
			"SELECT * FROM cluster_nodes ORDER BY created_at",
		);
		res.json({ nodes: nodes.map(serializeNode) });
	});

	router.post(
		"/nodes",
		requireSession(state),
		requireCsrf,
		requireCluster,
		asyncHandler(async (req, res) => {
			const body = req.body as {
				name?: string;
				base_url?: string;
				token?: string;
			};
			const name = (body.name ?? "").trim();
			const baseUrl = (body.base_url ?? "").trim().replace(/\/$/, "");
			const token = (body.token ?? "").trim();
			if (!name || !baseUrl || !token) {
				res
					.status(400)
					.json({ detail: "name, base_url and token are required" });
				return;
			}
			if (!/^https?:\/\//.test(baseUrl)) {
				res
					.status(400)
					.json({ detail: "base_url must start with http:// or https://" });
				return;
			}
			const now = nowIso();
			db.run(
				`INSERT INTO cluster_nodes (name, base_url, token, created_by_id, created_at)
       VALUES ($name, $baseUrl, $token, $createdBy, $now)`,
				{
					$name: name,
					$baseUrl: baseUrl,
					$token: token,
					$createdBy: req.currentUser!.id,
					$now: now,
				},
			);
			const node = db.get<ClusterNodeRow>(
				"SELECT * FROM cluster_nodes WHERE base_url = $baseUrl ORDER BY id DESC LIMIT 1",
				{
					$baseUrl: baseUrl,
				},
			)!;
			recordAudit(db, {
				actor: req.currentUser!.username,
				action: "cluster.node_linked",
				target: `node:${node.id}`,
				ip: clientIp(state, req),
			});

			const enroll = await triggerEnroll(state, node.base_url, node.token);
			res.json({ ...serializeNode(node), enroll });
		}),
	);

	// Operator switches over a linked node (§5.2, §5.3). None of these re-tier on
	// their own: they change the *input* to the computation, and the operator
	// decides when it runs -- either by hitting /retier, or by letting the drift
	// counter notice that the plan has changed and hold-down has passed.
	router.patch(
		"/nodes/:id",
		requireSession(state),
		requireCsrf,
		requireCluster,
		(req, res) => {
			const id = Number(req.params.id);
			const node = db.get<ClusterNodeRow>(
				"SELECT * FROM cluster_nodes WHERE id = $id",
				{ $id: id },
			);
			if (!node) {
				res.status(404).json({ detail: "not found" });
				return;
			}
			const body = req.body as {
				region?: string | null;
				ineligible?: boolean;
				pinned_master?: boolean;
			};
			if (body.region !== undefined) {
				const region = (body.region ?? "").trim();
				// An operator-set region is `configured`, which beats RTT inference
				// permanently; clearing it hands the node back to inference.
				db.run(
					"UPDATE cluster_nodes SET region = $region, region_source = $source WHERE id = $id",
					{
						$region: region || null,
						$source: region ? "configured" : "inferred",
						$id: id,
					},
				);
			}
			if (body.ineligible !== undefined) {
				db.run("UPDATE cluster_nodes SET ineligible = $v WHERE id = $id", {
					$v: body.ineligible ? 1 : 0,
					$id: id,
				});
			}
			if (body.pinned_master !== undefined) {
				// At most one pin, or the computation has two answers and stops being
				// a function.
				if (body.pinned_master) {
					db.run("UPDATE cluster_nodes SET pinned_master = 0");
				}
				db.run("UPDATE cluster_nodes SET pinned_master = $v WHERE id = $id", {
					$v: body.pinned_master ? 1 : 0,
					$id: id,
				});
			}
			recordAudit(db, {
				actor: req.currentUser!.username,
				action: "cluster.node_updated",
				target: `node:${id}`,
				ip: clientIp(state, req),
			});
			res.json(
				serializeNode(
					db.get<ClusterNodeRow>("SELECT * FROM cluster_nodes WHERE id = $id", {
						$id: id,
					})!,
				),
			);
		},
	);

	router.delete(
		"/nodes/:id",
		requireSession(state),
		requireCsrf,
		requireCluster,
		(req, res) => {
			const id = Number(req.params.id);
			const node = db.get<ClusterNodeRow>(
				"SELECT * FROM cluster_nodes WHERE id = $id",
				{ $id: id },
			);
			if (!node) {
				res.status(404).json({ detail: "not found" });
				return;
			}
			db.run("DELETE FROM cluster_nodes WHERE id = $id", { $id: id });
			recordAudit(db, {
				actor: req.currentUser!.username,
				action: "cluster.node_unlinked",
				target: `node:${id}`,
				ip: clientIp(state, req),
			});
			res.json({ status: "deleted" });
		},
	);

	// ── node-to-node membership handshake (cluster-token auth) ─────────────

	const clusterAuth = requireClusterToken(state);

	interface JoinBody {
		node_id: string;
		name: string;
		base_url: string;
		token: string;
		archive_enabled?: boolean;
		replication_mode?: string;
		disk_total_bytes?: number;
		disk_free_bytes?: number;
		used_bytes?: number;
		/** The sender's tiering generation. Adopted only if newer than ours; the
		 * sender's *role* is never taken from the body (S4). */
		tiering?: Tiering | null;
	}

	router.post("/join", clusterAuth, (req, res) => {
		const body = req.body as JoinBody;
		if (!body?.node_id || !body?.name || !body?.base_url || !body?.token) {
			res
				.status(400)
				.json({ detail: "node_id, name, base_url and token are required" });
			return;
		}
		const peer = upsertPeer(state, {
			nodeId: body.node_id,
			name: body.name,
			baseUrl: body.base_url,
			token: body.token,
			archiveEnabled: body.archive_enabled !== false,
			replicationMode: body.replication_mode ?? "full",
			diskTotalBytes: body.disk_total_bytes ?? 0,
			diskFreeBytes: body.disk_free_bytes ?? 0,
			usedBytes: body.used_bytes ?? 0,
			tiering: body.tiering,
		});
		recordAudit(db, {
			actor: `node:${body.node_id}`,
			action: "cluster.node_joined",
			target: `node:${peer.id}`,
			ip: clientIp(state, req),
		});
		// A node the current generation has never seen is admitted immediately
		// rather than waiting out the drift hold-down: until it is in a snapshot
		// it has no upstream, so its writes reach nobody. The response below then
		// carries the generation that names it, which is how the joiner learns its
		// own role in the same round-trip.
		retierForNewMember(state, body.node_id);

		const others = db
			.all<ClusterNodeRow>("SELECT * FROM cluster_nodes WHERE active = 1")
			.filter((n) => n.node_id && n.node_id !== body.node_id);
		const peers = others.map((n) => ({
			node_id: n.node_id,
			name: n.name,
			base_url: n.base_url,
			token: n.token,
			archive_enabled: !!n.archive_enabled,
			replication_mode: n.replication_mode,
		}));
		res.json({ self: selfStats(state), peers });
	});

	router.post(
		"/enroll",
		clusterAuth,
		asyncHandler(async (req, res) => {
			const body = req.body as { master_url?: string; master_token?: string };
			if (!body?.master_url || !body?.master_token) {
				res
					.status(400)
					.json({ detail: "master_url and master_token are required" });
				return;
			}
			const result = await enrollWithMaster(
				state,
				body.master_url,
				body.master_token,
			);
			res.json(result);
		}),
	);

	router.post("/heartbeat", clusterAuth, (req, res) => {
		const body = req.body as JoinBody;
		if (!body?.node_id || !body?.name || !body?.base_url || !body?.token) {
			res
				.status(400)
				.json({ detail: "node_id, name, base_url and token are required" });
			return;
		}
		upsertPeer(state, {
			nodeId: body.node_id,
			name: body.name,
			baseUrl: body.base_url,
			token: body.token,
			archiveEnabled: body.archive_enabled !== false,
			replicationMode: body.replication_mode ?? "full",
			diskTotalBytes: body.disk_total_bytes ?? 0,
			diskFreeBytes: body.disk_free_bytes ?? 0,
			usedBytes: body.used_bytes ?? 0,
			tiering: body.tiering,
		});
		res.json(selfStats(state));
	});

	router.get("/ping", clusterAuth, (_req, res) => {
		res.json(selfStats(state));
	});

	function findLocalBlob(
		storedSha256: string,
		transform: string | null,
	): ContentBlobRow | undefined {
		if (transform) {
			return db.get<ContentBlobRow>(
				"SELECT * FROM content_blobs WHERE stored_sha256 = $hash AND transform_key = $t",
				{
					$hash: storedSha256,
					$t: transform,
				},
			);
		}
		return db.get<ContentBlobRow>(
			"SELECT * FROM content_blobs WHERE stored_sha256 = $hash",
			{ $hash: storedSha256 },
		);
	}

	// Cheap existence probe used by cluster/cacheEviction.ts before evicting a
	// locally-cached blob -- confirms a full-replica peer already has these
	// exact bytes without transferring them. No response body (just the
	// status code), so a large eviction pass never streams file content just
	// to check durability.
	router.head("/blobs/:storedSha256", clusterAuth, (req, res) => {
		const transform =
			typeof req.query.transform === "string" ? req.query.transform : null;
		const blob = findLocalBlob(req.params.storedSha256, transform);
		if (!blob) {
			res.status(404).end();
			return;
		}
		let path: string;
		try {
			path = safeJoin(storageRoot(), blob.storage_path);
		} catch {
			res.status(404).end();
			return;
		}
		res.status(existsSync(path) ? 200 : 404).end();
	});

	router.get("/blobs/:storedSha256", clusterAuth, (req, res) => {
		const transform =
			typeof req.query.transform === "string" ? req.query.transform : null;
		const blob = findLocalBlob(req.params.storedSha256, transform);
		if (!blob) {
			res.status(404).json({ detail: "blob not found" });
			return;
		}
		let path: string;
		try {
			path = safeJoin(storageRoot(), blob.storage_path);
		} catch {
			res.status(404).json({ detail: "blob not found" });
			return;
		}
		if (!existsSync(path)) {
			res.status(404).json({ detail: "blob bytes missing on this node" });
			return;
		}
		const stat = statSync(path);
		res.writeHead(200, {
			"Content-Type": "application/octet-stream",
			"Content-Length": String(stat.size),
			"X-Blob-Transform": blob.transform_key,
			"X-Blob-Stored-Sha256": blob.stored_sha256,
			"X-Blob-Storage-Path": blob.storage_path,
		});
		createReadStream(path).pipe(res);
	});

	router.get("/digest", clusterAuth, (_req, res) => {
		res.json(computeDigest(state));
	});

	// ── the replication change log (redesign §5.7) ──────────────────────────
	//
	// One endpoint, both directions. A peer pulls from here with the cursor it
	// last reached; whether that is a follower reading down from its master or
	// the master reading up from a follower is the caller's business, not this
	// handler's -- which is what lets the region tier slot in later without a
	// new endpoint.
	//
	// Ascending from `after`, front-truncated at `limit`. Returning the newest
	// N instead would silently strand everything older, which is exactly the
	// bug B2 was in the event pipeline.

	router.get("/changes", clusterAuth, (req, res) => {
		const after = Number(req.query.after ?? 0) || 0;
		const limitRaw = Number(req.query.limit ?? 500);
		const limit = Math.max(
			1,
			Math.min(Number.isFinite(limitRaw) ? limitRaw : 500, 1000),
		);
		const entries = readChanges(db, { after, limit });
		res.json({
			entries,
			last_seq: entries.length > 0 ? entries[entries.length - 1]!.seq : after,
			// This node's log head, so a caller can tell "nothing new" from
			// "still catching up" without a second request.
			head: logHead(db),
			count: entries.length,
		});
	});

	// ── pushed revocations (redesign §5.9, D-13) ────────────────────────────
	//
	// The same entries the pull would have carried, delivered early because a
	// stale *grant* is a security hole and the operator is waiting. Applied
	// through the ordinary apply path, so a redelivery by the pull afterwards
	// dedups to nothing.

	router.post("/revocations", clusterAuth, (req, res) => {
		const entries = Array.isArray(req.body?.entries)
			? (req.body.entries as ChangeEntry[])
			: [];
		if (entries.length === 0) {
			res.json({ applied: 0 });
			return;
		}
		res.json(applyPushedRevocation(state, entries));
	});

	// ── tiering (redesign §5.3-5.4) ─────────────────────────────────────────
	//
	// `/vote-request` and `/master-assumed` used to live here. There is nothing
	// to replace them with: leadership is not negotiated, it is computed, and
	// the only thing that travels between nodes is the generation itself —
	// which already rides on every join and heartbeat. This endpoint exists so a
	// node can ask for it directly rather than waiting for the next heartbeat.

	router.get("/tiering", clusterAuth, (_req, res) => {
		res.json({ tiering: currentTiering(db) });
	});

	// ── quota reservations (redesign §5.9) ──────────────────────────────────
	//
	// The only synchronous cross-node call on the write path. Master-only: a
	// follower holds no ledger, and answering from one would be inventing the
	// authority the whole design exists to centralise. 409 rather than 403 —
	// the caller's credentials are fine, its *target* is wrong, and it should
	// re-resolve who the master is and retry.

	function requireQuotaAuthority(res: Response): boolean {
		if (isMaster(state)) return true;
		res.status(409).json({
			detail: "this node is not the cluster's quota authority",
			master_node_id: currentTiering(db)?.master_node_id ?? null,
		});
		return false;
	}

	router.post("/quota/reserve", clusterAuth, (req, res) => {
		if (!requireQuotaAuthority(res)) return;
		const body = req.body as Partial<GrantRequest>;
		if (!body?.user_uid || typeof body.bytes !== "number") {
			res.status(400).json({ detail: "user_uid and bytes are required" });
			return;
		}
		res.json(
			grantReservation(db, {
				user_uid: body.user_uid,
				bytes: body.bytes,
				kind: body.kind ?? "upload",
				node_id: body.node_id ?? "unknown",
			}),
		);
	});

	router.post("/quota/renew", clusterAuth, (req, res) => {
		if (!requireQuotaAuthority(res)) return;
		const uid = (req.body as { reservation_uid?: string })?.reservation_uid;
		if (!uid) {
			res.status(400).json({ detail: "reservation_uid is required" });
			return;
		}
		const renewed = renewReservation(db, uid);
		if (!renewed) {
			res.status(404).json({ detail: "no such reservation" });
			return;
		}
		res.json(renewed);
	});

	// Commit and release are idempotent and never fail on an unknown uid: a
	// reservation that already expired is settled, and the file row it admitted
	// exists either way. Erroring here would only make callers handle a case
	// with no remedy.
	router.post("/quota/commit", clusterAuth, (req, res) => {
		if (!requireQuotaAuthority(res)) return;
		const body = req.body as {
			reservation_uid?: string;
			actual_bytes?: number;
		};
		if (body?.reservation_uid) {
			settleReservation(
				db,
				body.reservation_uid,
				"committed",
				body.actual_bytes,
			);
		}
		res.json({ status: "ok" });
	});

	router.post("/quota/release", clusterAuth, (req, res) => {
		if (!requireQuotaAuthority(res)) return;
		const uid = (req.body as { reservation_uid?: string })?.reservation_uid;
		if (uid) settleReservation(db, uid, "released");
		res.json({ status: "ok" });
	});

	// Manual re-tier (§5.4 trigger 1): always available, always wins. Master-only
	// — a node that is not master has no standing to mint a generation, and
	// during a master outage none can be minted at all, which is the degraded
	// mode of §5.5 rather than a separate failure to handle.
	router.post(
		"/retier",
		requireSession(state),
		requireCsrf,
		requireCluster,
		(req, res) => {
			if (!isMaster(state)) {
				res.status(409).json({
					detail:
						"only the master mints a tiering generation; this node is not master",
				});
				return;
			}
			const tiering = retier(state, "manual", req.currentUser!.username);
			recordAudit(db, {
				actor: req.currentUser!.username,
				action: "cluster.retier_requested",
				target: `generation:${tiering?.generation ?? 0}`,
				ip: clientIp(state, req),
			});
			res.json({ tiering });
		},
	);

	// Operator promotion (§5.5). The only recovery from a master outage, and
	// deliberately manual: a node cannot tell "the master died" from "I got cut
	// off", and promoting on the second reading is the split brain this design
	// refuses to automate. The typed confirmation belongs to the human.
	router.post(
		"/promote",
		requireSession(state),
		requireCsrf,
		requireCluster,
		(req, res) => {
			const body = req.body as { confirm?: string; force?: boolean };
			if (isMaster(state)) {
				res.status(409).json({ detail: "this node is already master" });
				return;
			}
			const status = masterStatus(state);
			if (status.phase !== "degraded" && !body?.force) {
				res.status(409).json({
					detail:
						status.phase === "grace"
							? "the master is inside its restart grace window; wait for it to expire, or pass force to promote anyway"
							: "the master is reachable; promoting now would split the cluster. Pass force only if you know it is gone.",
					master_status: status,
				});
				return;
			}
			if (body?.confirm !== state.settings.nodeName) {
				res.status(400).json({
					detail: `type this node's name (${state.settings.nodeName}) to confirm promotion`,
				});
				return;
			}
			const tiering = promoteSelf(state, req.currentUser!.username);
			recordAudit(db, {
				actor: req.currentUser!.username,
				action: "cluster.promote_requested",
				target: `generation:${tiering.generation}`,
				ip: clientIp(state, req),
			});
			res.json({ tiering });
		},
	);

	return router;
}

/** Mirrors app/routes/ws.py's admin_router (`/admin/cluster/*`) REST
 * surface -- node-logs and the HTTP long-poll firehose fallback. The
 * websocket firehose itself (`/admin/cluster/firehose`) is set up
 * separately in server/src/ws.ts since it needs the raw http.Server.
 * Mounted at /admin/cluster in app.ts. */
export function adminClusterRouter(state: AppState): Router {
	const router = Router();
	const clusterAuth = requireClusterToken(state);

	router.get("/node-logs", clusterAuth, (req, res) => {
		const q = typeof req.query.q === "string" ? req.query.q : undefined;
		const level =
			typeof req.query.level === "string" ? req.query.level : undefined;
		const limitRaw = Number(req.query.limit ?? 200);
		const limit = Math.max(
			1,
			Math.min(Number.isFinite(limitRaw) ? limitRaw : 200, 1000),
		);
		res.json(queryBackendLogs({ q, level, limit }));
	});

	router.get("/events", clusterAuth, (req, res) => {
		const after = Number(req.query.after ?? 0) || 0;
		const limitRaw = Number(req.query.limit ?? 200);
		const limit = Math.max(
			1,
			Math.min(Number.isFinite(limitRaw) ? limitRaw : 200, 1000),
		);
		// Served from the durable `cluster_events` table, not EventBus' ring
		// buffer: this is the peer poll path, and a restart empties the buffer.
		const events = readOwnEvents(state.db, state.settings.nodeId, {
			after,
			limit,
		});
		const lastId = events.length > 0 ? events[events.length - 1]!.id : after;
		res.json({ events, last_id: lastId, count: events.length });
	});

	return router;
}
