import { Router } from "express";
import type { AppState } from "../appState.ts";
import { recordAudit } from "../audit.ts";
import { type ApiKeyRow, nowIso, type UserRow } from "../db/rows.ts";
import { asyncHandler } from "../middleware/asyncHandler.ts";
import { clientIp, requireSession } from "../middleware/auth.ts";
import {
	requireActiveUser,
	requireMaster,
	requirePermission,
} from "../middleware/deps.ts";
import { generateKey, hashKey } from "../security/apiKeys.ts";
import { requireCsrf } from "../security/csrf.ts";
import { verifyPassword } from "../security/passwords.ts";

interface CountRow {
	n: number;
}
interface MaxRow {
	m: number | null;
}

const MAX_ACTIVE_KEYS_PER_USER = 20;

function serializeKey(k: ApiKeyRow) {
	return {
		id: k.id,
		owner_id: k.owner_id,
		user_key_number: k.user_key_number,
		bound_ip: k.bound_ip,
		active: !!k.active,
		created_at: k.created_at,
		last_used_at: k.last_used_at,
		rate_limit_per_min: k.rate_limit_per_min,
	};
}

const MAX_RATE_LIMIT_PER_MIN = 6000;

/** Mirrors app/routes/keys.py -- mounted at /keys plus an admin sub-route at
 * /admin/keys registered separately in app.ts. */
export function keysRouter(state: AppState): Router {
	const router = Router();
	const { db } = state;

	router.post(
		"/",
		requireSession(state),
		requireCsrf,
		requirePermission(state, "can_use_api_keys"),
		(req, res) => {
			const user = req.currentUser!;
			const activeCount = db.get<CountRow>(
				"SELECT COUNT(*) as n FROM api_keys WHERE owner_id = $id AND active = 1",
				{ $id: user.id },
			)!.n;
			if (activeCount >= MAX_ACTIVE_KEYS_PER_USER) {
				res.status(429).json({
					detail: `active API key limit reached (${MAX_ACTIVE_KEYS_PER_USER}); delete one first`,
				});
				return;
			}
			const nextNumber =
				(db.get<MaxRow>(
					"SELECT MAX(user_key_number) as m FROM api_keys WHERE owner_id = $id",
					{ $id: user.id },
				)?.m ?? 0) + 1;
			const raw = generateKey();
			db.run(
				`INSERT INTO api_keys (owner_id, user_key_number, key_hash, active, created_at)
       VALUES ($ownerId, $num, $hash, 1, $now)`,
				{
					$ownerId: user.id,
					$num: nextNumber,
					$hash: hashKey(raw),
					$now: nowIso(),
				},
			);
			const key = db.get<ApiKeyRow>(
				"SELECT * FROM api_keys WHERE id = last_insert_rowid()",
			)!;
			recordAudit(db, {
				actor: user.username,
				action: "apikey.created",
				target: `apikey:${key.id}`,
				ip: clientIp(state, req),
			});
			res.json({ id: key.id, user_key_number: key.user_key_number, key: raw });
		},
	);

	router.get("/", requireActiveUser(state), (req, res) => {
		const user = req.currentUser!;
		const keys = db.all<ApiKeyRow>(
			"SELECT * FROM api_keys WHERE owner_id = $id AND active = 1 ORDER BY user_key_number ASC",
			{ $id: user.id },
		);
		res.json({ keys: keys.map(serializeKey) });
	});

	router.delete(
		"/:keyId",
		requireSession(state),
		requireCsrf,
		requireActiveUser(state),
		(req, res) => {
			const user = req.currentUser!;
			const key = db.get<ApiKeyRow>("SELECT * FROM api_keys WHERE id = $id", {
				$id: req.params.keyId,
			});
			if (!key) {
				res.status(404).json({ detail: "not found" });
				return;
			}
			if (user.role !== "master" && key.owner_id !== user.id) {
				res.status(403).json({ detail: "not your key" });
				return;
			}
			recordAudit(db, {
				actor: user.username,
				action: "apikey.deleted",
				target: `apikey:${key.id}`,
				ip: clientIp(state, req),
			});
			// Hard delete, not soft -- so it disappears from the admin panel
			// immediately instead of lingering as an inactive row (see CLAUDE.md).
			db.run("DELETE FROM api_keys WHERE id = $id", { $id: key.id });
			res.json({ status: "deleted" });
		},
	);

	router.patch(
		"/:keyId",
		requireSession(state),
		requireCsrf,
		requireActiveUser(state),
		(req, res) => {
			const user = req.currentUser!;
			const key = db.get<ApiKeyRow>("SELECT * FROM api_keys WHERE id = $id", {
				$id: req.params.keyId,
			});
			if (!key) {
				res.status(404).json({ detail: "not found" });
				return;
			}
			if (user.role !== "master" && key.owner_id !== user.id) {
				res.status(403).json({ detail: "not your key" });
				return;
			}
			const raw = (req.body ?? {}).rate_limit_per_min;
			let value: number | null;
			if (raw === null) {
				value = null;
			} else {
				const n = Number(raw);
				if (!Number.isFinite(n) || n < 1 || n > MAX_RATE_LIMIT_PER_MIN) {
					res.status(400).json({
						detail: `rate_limit_per_min must be null or 1-${MAX_RATE_LIMIT_PER_MIN}`,
					});
					return;
				}
				value = Math.floor(n);
			}
			db.run("UPDATE api_keys SET rate_limit_per_min = $v WHERE id = $id", {
				$v: value,
				$id: key.id,
			});
			res.json({ id: key.id, rate_limit_per_min: value });
		},
	);

	router.post(
		"/:keyId/reset-ip",
		requireSession(state),
		requireCsrf,
		requireActiveUser(state),
		asyncHandler(async (req, res) => {
			const user = req.currentUser!;
			const key = db.get<ApiKeyRow>("SELECT * FROM api_keys WHERE id = $id", {
				$id: req.params.keyId,
			});
			if (!key) {
				res.status(404).json({ detail: "not found" });
				return;
			}
			if (user.role !== "master" && key.owner_id !== user.id) {
				res.status(403).json({ detail: "not your key" });
				return;
			}
			const { password } = req.body ?? {};
			if (
				typeof password !== "string" ||
				!(await verifyPassword(password, user.password_hash))
			) {
				res.status(401).json({ detail: "invalid password" });
				return;
			}
			db.run("UPDATE api_keys SET bound_ip = NULL WHERE id = $id", {
				$id: key.id,
			});
			recordAudit(db, {
				actor: user.username,
				action: "apikey.ip_reset",
				target: `apikey:${key.id}`,
				ip: clientIp(state, req),
			});
			res.json({ status: "ip_reset" });
		}),
	);

	return router;
}

/** Mounted separately at /admin/keys in app.ts (matches app/routes/keys.py::admin_router). */
export function adminKeysRouter(state: AppState): Router {
	const router = Router();
	const { db } = state;

	router.get("/", requireMaster(state), (_req, res) => {
		const users = new Map(
			db.all<UserRow>("SELECT * FROM users").map((u) => [u.id, u.username]),
		);
		const keys = db.all<ApiKeyRow>(
			"SELECT * FROM api_keys WHERE active = 1 ORDER BY owner_id ASC, user_key_number ASC, id ASC",
		);
		res.json({
			keys: keys.map((k) => ({
				...serializeKey(k),
				owner_username: users.get(k.owner_id) ?? null,
			})),
		});
	});

	return router;
}
