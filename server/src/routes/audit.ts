import { Router } from "express";
import type { AppState } from "../appState.ts";
import { verifyAuditChain } from "../audit.ts";
import type { AuditLogRow } from "../db/rows.ts";
import { requireMaster } from "../middleware/deps.ts";

interface CountRow {
	n: number;
}
interface ActionRow {
	action: string;
}

/** Mirrors app/routes/audit_view.py. Cluster events are deferred (cluster
 * flag stays off), so /audit/cluster always returns an empty result shape. */
export function auditRouter(state: AppState): Router {
	const router = Router();
	const { db } = state;

	router.get("/", requireMaster(state), (req, res) => {
		const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
		const offset = Math.max(0, Number(req.query.offset) || 0);
		const q = typeof req.query.q === "string" ? req.query.q : "";
		const action = typeof req.query.action === "string" ? req.query.action : "";

		const totalCount = db.get<CountRow>(
			"SELECT COUNT(*) as n FROM audit_log",
		)!.n;
		const actions = db
			.all<ActionRow>(
				"SELECT DISTINCT action FROM audit_log ORDER BY action ASC",
			)
			.map((r) => r.action);

		const clauses: string[] = [];
		const params: Record<string, string> = {};
		if (action) {
			clauses.push("action = $action");
			params.$action = action;
		}
		const terms = q
			.split(/\s+/)
			.map((t) => t.trim())
			.filter(Boolean);
		terms.forEach((term, i) => {
			const key = `$q${i}`;
			clauses.push(
				`(CAST(id AS TEXT) LIKE ${key} OR actor LIKE ${key} OR action LIKE ${key} OR target LIKE ${key} OR ip LIKE ${key})`,
			);
			params[key] = `%${term}%`;
		});
		const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

		const filteredCount = db.get<CountRow>(
			`SELECT COUNT(*) as n FROM audit_log ${where}`,
			params,
		)!.n;
		const entries = db.all<AuditLogRow>(
			`SELECT * FROM audit_log ${where} ORDER BY id DESC LIMIT $limit OFFSET $offset`,
			{ ...params, $limit: limit, $offset: offset },
		);

		// verifyAuditChain re-reads and re-hashes the ENTIRE audit_log table --
		// too expensive to run on every GET, so it's opt-in via ?verify=1.
		// chain_ok is null (not checked) unless the caller asks.
		const chainOk = req.query.verify === "1" ? verifyAuditChain(db) : null;

		res.json({
			entries: entries.map((e) => ({
				id: e.id,
				actor: e.actor,
				action: e.action,
				target: e.target,
				ip: e.ip,
				created_at: e.created_at,
			})),
			chain_ok: chainOk,
			actions,
			total_count: totalCount,
			filtered_count: filteredCount,
			limit,
			offset,
		});
	});

	router.get("/cluster", requireMaster(state), (req, res) => {
		const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
		const offset = Math.max(0, Number(req.query.offset) || 0);
		res.json({
			entries: [],
			actions: [],
			servers: [],
			total_count: 0,
			filtered_count: 0,
			limit,
			offset,
		});
	});

	return router;
}
