import { randomBytes } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { Router } from "express";
import type { AppState } from "../appState.ts";
import { recordAudit } from "../audit.ts";
import { applyLocalUpsert, isChangelogTable } from "../cluster/changelog.ts";
import {
	dismissConflict,
	getConflict,
	listConflicts,
	openConflictCount,
} from "../cluster/conflicts.ts";
import {
	authenticatePeer,
	credentialSummary,
	mintEnrollmentToken,
	performExchange,
	requirePeer,
} from "../cluster/credentials.ts";
import { masterStatus } from "../cluster/degraded.ts";
import { readOwnEvents } from "../cluster/eventStore.ts";
import * as clusterHttp from "../cluster/http.ts";
import { ClusterHTTPError } from "../cluster/http.ts";
import { materialSummary } from "../cluster/identityFetch.ts";
import { chunkStorageStats } from "../cluster/placement.ts";
import { outstandingReservations } from "../cluster/quota.ts";
import { selfStats } from "../cluster/selfStats.ts";
import {
	currentTiering,
	isMaster,
	measureDrift,
	promoteSelf,
	retier,
} from "../cluster/tiering.ts";
import { buildTopology } from "../cluster/topology.ts";
import { ConfigLockedError, isEnvManaged, setEnvValue } from "../config.ts";
import { type ClusterNodeRow, nowIso } from "../db/rows.ts";
import { HttpError } from "../httpError.ts";
import { getLogger, queryBackendLogs } from "../logging.ts";
import { asyncHandler } from "../middleware/asyncHandler.ts";
import { clientIp, requireSession } from "../middleware/auth.ts";
import { requirePermission } from "../middleware/deps.ts";
import { requireCsrf } from "../security/csrf.ts";

/** The session-authenticated cluster management surface: token and enrolment,
 * node linking, self/topology/conflicts, re-tier and promote.
 *
 * The node-to-node handshake used to live here too, two auth models
 * interleaved in one 625-line file. Phase 9 (§5.13) moved it to
 * `routes/clusterNode.ts`, which is mounted at the same prefix and has exactly
 * one guard. Nothing in this file authenticates a node — the two exceptions
 * are marked, and both are read-throughs where an operator's session on one
 * node and a peer proxying for one are genuinely the same request. */

const log = getLogger("app.cluster.routes");

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
		// §5.13: whether what we present to this peer is a secret shared with it
		// alone, or still the shared cluster token. The dashboard shows it because
		// "which peers are still on the legacy token" is the only thing an
		// operator has to do anything about.
		credential_at: node.credential_at,
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

/** Tell a node we have just linked to enrol with us, handing it a one-use
 * enrolment token minted here rather than this node's standing credential. The
 * call itself is authenticated with whatever the operator pasted — an enrolment
 * token minted on the far side, or its cluster token while that is still
 * honoured there. */
async function triggerEnroll(
	state: AppState,
	baseUrl: string,
	token: string,
	actor: string,
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
	// Unscoped: the joining node's id is exactly what we do not know yet, which
	// is why the operator is doing this at all. It buys one credential exchange
	// and expires in fifteen minutes.
	const invitation = mintEnrollmentToken(state.db, { createdBy: actor });
	try {
		const res = (await clusterHttp.postJson(
			// Router is mounted at /api/cluster in app.ts -- every other node-to-node
			// call in cluster/*.ts uses the /api prefix (membership.ts, blobs.ts).
			`${baseUrl}/api/cluster/enroll`,
			token,
			{ master_url: state.settings.nodeUrl, master_token: invitation.token },
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

	// ── the local cluster token and enrolment (§5.13) ───────────────────────
	//
	// `CLUSTER_TOKEN` is now a bootstrap credential, not the cluster's standing
	// auth: it is honoured only until every linked peer has established a pair
	// credential, after which `legacyTokenAcceptable()` goes false on its own.
	// Linking a node from here mints a one-use enrolment token instead.

	router.get("/token", requireCluster, (_req, res) => {
		res.json({
			token: state.clusterToken,
			...credentialSummary(db),
		});
	});

	router.post(
		"/token/rotate",
		requireSession(state),
		requireCsrf,
		requireCluster,
		(req, res) => {
			// A CLUSTER_TOKEN fixed by the environment can't be rotated: the new
			// one would live in memory until the next restart handed every peer
			// back the old one. Refuse up front (409) rather than rotate into
			// that. Persistence itself stays best-effort -- an unwritable config
			// file is an operator problem, and the rotation has already happened.
			if (isEnvManaged("CLUSTER_TOKEN"))
				throw new ConfigLockedError("CLUSTER_TOKEN");
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
			// Rotating this no longer breaks the cluster (S3): peers call us with
			// their pair credential, which this does not touch. It only changes
			// what a *new* node may bootstrap with.
			res.json({ token: newToken, ...credentialSummary(db) });
		},
	);

	/** Mint a one-use enrolment token for an operator to paste into the node
	 * that is doing the linking. Short-lived and single-purpose: it authorizes
	 * one credential exchange and nothing else. */
	router.post(
		"/enrollment-tokens",
		requireSession(state),
		requireCsrf,
		requireCluster,
		(req, res) => {
			const minted = mintEnrollmentToken(db, {
				createdBy: req.currentUser!.username,
			});
			recordAudit(db, {
				actor: req.currentUser!.username,
				action: "cluster.enrollment_token_minted",
				target: `expires:${minted.expires_at}`,
				ip: clientIp(state, req),
			});
			res.json({
				...minted,
				node_id: state.settings.nodeId,
				name: state.settings.nodeName,
				base_url: state.settings.nodeUrl,
			});
		},
	);

	/** Re-key a peer by hand. The same exchange the maintenance job runs, so
	 * there is one rotation mechanism rather than an operator-only second one;
	 * the old inbound secret stays valid for the overlap window either way. */
	router.post(
		"/nodes/:id(\\d+)/rotate-credential",
		requireSession(state),
		requireCsrf,
		requireCluster,
		asyncHandler(async (req, res) => {
			const node = db.get<ClusterNodeRow>(
				"SELECT * FROM cluster_nodes WHERE id = $id",
				{ $id: Number(req.params.id) },
			);
			if (!node) throw new HttpError(404, "not found");
			if (!node.node_id || !node.base_url || !node.token) {
				throw new HttpError(409, "that node has no credential to rotate");
			}
			try {
				await performExchange(state, {
					baseUrl: node.base_url,
					auth: node.token,
					expectNodeId: node.node_id,
				});
			} catch (err) {
				const reason =
					err instanceof ClusterHTTPError ? err.message : String(err);
				throw new HttpError(502, `the peer refused the exchange: ${reason}`);
			}
			recordAudit(db, {
				actor: req.currentUser!.username,
				action: "cluster.credential_rotated",
				target: `node:${node.node_id}`,
				ip: clientIp(state, req),
			});
			res.json(
				serializeNode(
					db.get<ClusterNodeRow>("SELECT * FROM cluster_nodes WHERE id = $id", {
						$id: node.id,
					})!,
				),
			);
		}),
	);

	// ── the local chunk cache (§5.11) ───────────────────────────────────────
	//
	// The cap is an operator decision about *this* node's disk, so it is set
	// here rather than replicated: a cluster-wide cache size would be a number
	// that is wrong for every node but one.

	router.put(
		"/cache-cap",
		requireSession(state),
		requireCsrf,
		requireCluster,
		(req, res) => {
			const raw = (req.body as { cache_max_bytes?: unknown }).cache_max_bytes;
			const value = Number(raw);
			if (!Number.isFinite(value) || value < 0) {
				throw new HttpError(400, "cache_max_bytes must be a positive number");
			}
			// Persist first, apply second: setEnvValue refuses a key the
			// environment fixes (409), and applying first would leave this process
			// holding a value the file rejected.
			setEnvValue(
				state.settings.configPath,
				"CACHE_MAX_BYTES",
				String(Math.trunc(value)),
			);
			state.settings.cacheMaxBytes = Math.trunc(value);
			recordAudit(db, {
				actor: req.currentUser!.username,
				action: "cluster.cache_cap_set",
				target: `bytes:${Math.trunc(value)}`,
				ip: clientIp(state, req),
			});
			res.json(chunkStorageStats(state));
		},
	);

	// ── this node ───────────────────────────────────────────────────────────

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
			// §5.10. How much of the user population this node can authenticate
			// without asking anyone — the operational read on D-12's "a user cannot
			// log in on a node that cannot reach a holder".
			identity: materialSummary(db),
			// §5.13. How far this node is from having retired the shared token.
			credentials: credentialSummary(db),
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
	// read-through — the one place in this file where a node authenticates, and
	// it is a node relaying an operator's own request.

	const peerAuth = requirePeer(state);
	const managerOrPeer = (
		req: Request,
		res: Response,
		next: NextFunction,
	): void => {
		if (authenticatePeer(state, req)) {
			peerAuth(req, res, next);
			return;
		}
		requireCluster(req, res, next);
	};

	/** The master as a peer we can call: its URL from the generation, its
	 * credential from the `cluster_nodes` row we linked it through. */
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

	// ── linked remote nodes ─────────────────────────────────────────────────

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
					// Whatever the operator pasted: an enrolment token minted on that
					// node, or its cluster token. Either way it is provisional — the
					// exchange the enrolment kicks off replaces it with a pair secret,
					// which is why `credential_at` stays NULL here.
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

			const enroll = await triggerEnroll(
				state,
				node.base_url,
				node.token,
				req.currentUser!.username,
			);
			res.json({
				...serializeNode(
					db.get<ClusterNodeRow>("SELECT * FROM cluster_nodes WHERE id = $id", {
						$id: node.id,
					})!,
				),
				enroll,
			});
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
			// The inbound verifiers go with it, or an unlinked node keeps a working
			// credential into this one. `legacyTokenAcceptable()` is deliberately
			// unaffected by that: dropping the last peer must not revive the shared
			// token on a node that has ever credentialed anyone.
			if (node.node_id) {
				db.run(
					"DELETE FROM cluster_peer_credentials WHERE peer_node_id = $peer",
					{ $peer: node.node_id },
				);
			}
			recordAudit(db, {
				actor: req.currentUser!.username,
				action: "cluster.node_unlinked",
				target: `node:${id}`,
				ip: clientIp(state, req),
			});
			res.json({ status: "deleted" });
		},
	);

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
 * Mounted at /admin/cluster in app.ts.
 *
 * Node-authenticated, not session-authenticated: these are what a peer polls
 * when the websocket is unavailable (cluster/firehoseClient.ts). */
export function adminClusterRouter(state: AppState): Router {
	const router = Router();
	// `allowBootstrapToken`: the firehose is a monitoring endpoint as well as a
	// peer one, and an operator's collector holding CLUSTER_TOKEN must not go
	// dark the day the mesh finishes credentialing itself. Peers reach it with
	// their pair credential like everything else; this is the one place the
	// shared token outlives its retirement, and it reads events rather than
	// touching cluster state.
	const peerAuth = requirePeer(state, { allowBootstrapToken: true });

	router.get("/node-logs", peerAuth, (req, res) => {
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

	router.get("/events", peerAuth, (req, res) => {
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
