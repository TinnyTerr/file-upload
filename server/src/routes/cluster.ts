import { randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import type { NextFunction, Request, Response } from "express";
import { Router } from "express";
import type { AppState } from "../appState.ts";
import { recordAudit } from "../audit.ts";
import { computeDigest } from "../cluster/digest.ts";
import {
	adoptEpochIfHigher,
	getSelfState,
	handleMasterAssumed,
	handleVoteRequest,
	resolveMaster,
} from "../cluster/election.ts";
import { readOwnEvents } from "../cluster/eventStore.ts";
import * as clusterHttp from "../cluster/http.ts";
import { ClusterHTTPError } from "../cluster/http.ts";
import { enrollWithMaster, upsertPeer } from "../cluster/membership.ts";
import {
	applyRows,
	exportAll,
	localIdentity,
	type SerializedRow,
} from "../cluster/replication.ts";
import { setEnvValue } from "../config.ts";
import { type ClusterNodeRow, nowIso } from "../db/rows.ts";
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
	const self = getSelfState(state.db);
	return {
		node_id: state.settings.nodeId,
		name: state.settings.nodeName,
		is_master: self.role === "master",
		archive_enabled: state.settings.archiveEnabled,
		replication_mode: state.settings.replicationMode,
		disk_total_bytes: usage?.total ?? 0,
		disk_free_bytes: usage?.free ?? 0,
		used_bytes: usedStorageBytes(state.db),
		role: self.role,
		epoch: self.epoch,
		current_master_id: self.current_master_id,
		current_master_url: self.current_master_url,
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
		role: node.role,
		epoch: node.epoch,
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

/** Authenticate a request by the cluster token (Bearer or X-Cluster-Token).
 * Distinct from API-key/session auth: this single token grants read/write
 * access to node-to-node membership/replication endpoints regardless of
 * which user (if any) is behind the request. */
export function requireClusterToken(state: AppState) {
	return (req: Request, res: Response, next: NextFunction): void => {
		const header = req.header("authorization") ?? "";
		let presented = header.startsWith("Bearer ")
			? header.slice("Bearer ".length).trim()
			: "";
		if (!presented) presented = (req.header("x-cluster-token") ?? "").trim();
		const expected = state.clusterToken || "";
		const presentedBuf = Buffer.from(presented);
		const expectedBuf = Buffer.from(expected);
		const ok =
			!!presented &&
			!!expected &&
			presentedBuf.length === expectedBuf.length &&
			timingSafeEqual(presentedBuf, expectedBuf);
		if (!ok) {
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
	// Master is an elected, epoch-versioned role (cluster/election.ts) -- the
	// static NODE_ROLE config value can be stale, so check the live state.
	if (getSelfState(state.db).role !== "master") {
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
			// stats.role already reports the live elected role (getSelfState) --
			// don't overwrite it with the static NODE_ROLE bootstrap config value.
			...stats,
			node_url: state.settings.nodeUrl,
			halts,
		});
	});

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
		is_master?: boolean;
		archive_enabled?: boolean;
		replication_mode?: string;
		disk_total_bytes?: number;
		disk_free_bytes?: number;
		used_bytes?: number;
		role?: string;
		epoch?: number;
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
			isMaster: !!body.is_master,
			archiveEnabled: body.archive_enabled !== false,
			replicationMode: body.replication_mode ?? "full",
			diskTotalBytes: body.disk_total_bytes ?? 0,
			diskFreeBytes: body.disk_free_bytes ?? 0,
			usedBytes: body.used_bytes ?? 0,
			role: body.role,
			epoch: body.epoch,
		});
		recordAudit(db, {
			actor: `node:${body.node_id}`,
			action: "cluster.node_joined",
			target: `node:${peer.id}`,
			ip: clientIp(state, req),
		});

		const others = db
			.all<ClusterNodeRow>("SELECT * FROM cluster_nodes WHERE active = 1")
			.filter((n) => n.node_id && n.node_id !== body.node_id);
		const peers = others.map((n) => ({
			node_id: n.node_id,
			name: n.name,
			base_url: n.base_url,
			token: n.token,
			is_master: !!n.is_master,
			archive_enabled: !!n.archive_enabled,
			replication_mode: n.replication_mode,
			role: n.role,
			epoch: n.epoch,
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
			isMaster: !!body.is_master,
			archiveEnabled: body.archive_enabled !== false,
			replicationMode: body.replication_mode ?? "full",
			diskTotalBytes: body.disk_total_bytes ?? 0,
			diskFreeBytes: body.disk_free_bytes ?? 0,
			usedBytes: body.used_bytes ?? 0,
			role: body.role,
			epoch: body.epoch,
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

	// ── row metadata replication (announce-id protocol) ─────────────────────

	router.post("/reserve", clusterAuth, (req, res) => {
		const body = req.body as {
			table?: string;
			id?: number;
			identity?: string;
			epoch?: number;
		};
		if (!body?.table || body.id === undefined || !body.identity) {
			res.status(400).json({ detail: "table, id and identity are required" });
			return;
		}

		// Epoch fencing: a requester behind the epoch we already know about is
		// stale (told to re-resolve current epoch/master and retry); a
		// requester AHEAD of us means WE'RE behind (e.g. missed an election
		// while partitioned) -- adopt the higher epoch and self-demote if we
		// mistakenly still believe we're master, but let the request proceed
		// once adopted rather than bouncing it needlessly.
		const requestEpoch = Number(body.epoch ?? 0);
		const self = getSelfState(db);
		if (Number.isFinite(requestEpoch) && requestEpoch < self.epoch) {
			res.json({
				ok: false,
				conflict: false,
				stale_epoch: true,
				current_epoch: self.epoch,
				current_master: resolveMaster(state),
			});
			return;
		}
		if (Number.isFinite(requestEpoch) && requestEpoch > self.epoch) {
			adoptEpochIfHigher(state, requestEpoch, {});
		}

		const existing = localIdentity(db, body.table, body.id);
		const ok = existing === null || existing === body.identity;
		res.json({ ok, conflict: !ok, epoch: getSelfState(db).epoch });
	});

	router.post("/replicate", clusterAuth, (req, res) => {
		const body = req.body as { rows?: SerializedRow[] };
		const applied = applyRows(db, body?.rows ?? []);
		res.json({ applied });
	});

	router.get("/export", clusterAuth, (_req, res) => {
		res.json({ rows: exportAll(db) });
	});

	// ── leader election (cluster-token auth, same as the rest of the
	// node-to-node handshake -- consensus traffic is deliberately NOT routed
	// through ws.ts's firehose; that's an audit/event fan-out mechanism and
	// conflating it with leadership messaging would couple two things that
	// should be able to fail independently) ────────────────────────────────

	router.post("/vote-request", clusterAuth, (req, res) => {
		const body = req.body as {
			candidate_id?: string;
			candidate_url?: string;
			epoch?: number;
			vector?: Record<string, number>;
		};
		const result = handleVoteRequest(state, body);
		if (result.granted) {
			recordAudit(db, {
				actor: `node:${body.candidate_id}`,
				action: "cluster.vote_granted",
				target: `epoch:${body.epoch}`,
				ip: clientIp(state, req),
			});
		}
		res.json(result);
	});

	router.post("/master-assumed", clusterAuth, (req, res) => {
		const body = req.body as {
			node_id?: string;
			node_url?: string;
			epoch?: number;
		};
		const result = handleMasterAssumed(state, body);
		if (result.accepted) {
			recordAudit(db, {
				actor: `node:${body.node_id}`,
				action: "cluster.master_assumed",
				target: `epoch:${body.epoch}`,
				ip: clientIp(state, req),
			});
		}
		res.json(result);
	});

	return router;
}

/** Mirrors app/routes/ws.py's admin_router (`/api/admin/cluster/*`) REST
 * surface -- node-logs and the HTTP long-poll firehose fallback. The
 * websocket firehose itself (`/api/admin/cluster/firehose`) is set up
 * separately in server/src/ws.ts since it needs the raw http.Server.
 * Mounted at /api/admin/cluster in app.ts -- the `/api` prefix is part of the
 * public URL and clients must include it, or ws.ts's upgrade handler finds no
 * route and destroys the socket (a proxy renders that as a bare 502). */
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
