import { Router } from "express";
import type { AppState } from "../appState.ts";
import { recordAudit } from "../audit.ts";
import { nowIso, type WebhookRow } from "../db/rows.ts";
import { asyncHandler } from "../middleware/asyncHandler.ts";
import { clientIp, requireSession } from "../middleware/auth.ts";
import { requireActiveUser } from "../middleware/deps.ts";
import { requireCsrf } from "../security/csrf.ts";
import {
	generateWebhookSecret,
	isWebhookEvent,
	sendTestWebhook,
	WEBHOOK_EVENTS,
} from "../webhooks.ts";
import { resolvePublicAddress, validatePublicHttpUrl } from "./remoteUpload.ts";

const MAX_WEBHOOKS_PER_USER = 20;

function serializeWebhook(h: WebhookRow) {
	return {
		id: h.id,
		url: h.url,
		events: h.events.split(","),
		active: !!h.active,
		created_at: h.created_at,
		last_triggered_at: h.last_triggered_at,
		last_status: h.last_status,
	};
}

/** Same SSRF posture as remoteUpload.ts: the URL has to resolve to a public
 * address at the moment it's accepted, because a webhook is this server
 * making an outbound request of its own choosing to a URL an account
 * controls. */
async function assertPublicUrl(url: string): Promise<string> {
	const parsed = validatePublicHttpUrl(url);
	await resolvePublicAddress(parsed.hostname);
	return parsed.toString();
}

function parseEvents(raw: unknown): string[] | null {
	if (!Array.isArray(raw) || !raw.length) return null;
	const unique = [...new Set(raw)];
	if (!unique.every(isWebhookEvent)) return null;
	return unique;
}

export function webhooksRouter(state: AppState): Router {
	const router = Router();
	const { db } = state;

	router.get("/", requireActiveUser(state), (req, res) => {
		const user = req.currentUser!;
		const hooks = db.all<WebhookRow>(
			"SELECT * FROM webhooks WHERE owner_id = $id ORDER BY created_at DESC",
			{ $id: user.id },
		);
		res.json({ webhooks: hooks.map(serializeWebhook), events: WEBHOOK_EVENTS });
	});

	router.post(
		"/",
		requireSession(state),
		requireCsrf,
		requireActiveUser(state),
		asyncHandler(async (req, res) => {
			const user = req.currentUser!;
			const count = db.get<{ n: number }>(
				"SELECT COUNT(*) as n FROM webhooks WHERE owner_id = $id",
				{ $id: user.id },
			)!.n;
			if (count >= MAX_WEBHOOKS_PER_USER) {
				res.status(429).json({
					detail: `webhook limit reached (${MAX_WEBHOOKS_PER_USER}); delete one first`,
				});
				return;
			}
			const body = req.body ?? {};
			const events = parseEvents(body.events);
			if (!events) {
				res.status(400).json({
					detail: `events must be a non-empty array drawn from: ${WEBHOOK_EVENTS.join(", ")}`,
				});
				return;
			}
			if (typeof body.url !== "string") {
				res.status(400).json({ detail: "url is required" });
				return;
			}
			let url: string;
			try {
				url = await assertPublicUrl(body.url);
			} catch {
				res.status(400).json({
					detail: "url must be a public http(s) address",
				});
				return;
			}
			const secret = generateWebhookSecret();
			db.run(
				`INSERT INTO webhooks (owner_id, url, secret, events, active, created_at)
       VALUES ($ownerId, $url, $secret, $events, 1, $now)`,
				{
					$ownerId: user.id,
					$url: url,
					$secret: secret,
					$events: events.join(","),
					$now: nowIso(),
				},
			);
			const hook = db.get<WebhookRow>(
				"SELECT * FROM webhooks WHERE id = last_insert_rowid()",
			)!;
			recordAudit(db, {
				actor: user.username,
				action: "webhook.created",
				target: `webhook:${hook.id}`,
				ip: clientIp(state, req),
			});
			res.json({ ...serializeWebhook(hook), secret });
		}),
	);

	router.patch(
		"/:webhookId(\\d+)",
		requireSession(state),
		requireCsrf,
		requireActiveUser(state),
		asyncHandler(async (req, res) => {
			const user = req.currentUser!;
			const hook = db.get<WebhookRow>("SELECT * FROM webhooks WHERE id = $id", {
				$id: req.params.webhookId,
			});
			if (!hook || (user.role !== "master" && hook.owner_id !== user.id)) {
				res.status(404).json({ detail: "not found" });
				return;
			}
			const body = req.body ?? {};
			let url = hook.url;
			if (body.url !== undefined) {
				if (typeof body.url !== "string") {
					res.status(400).json({ detail: "url must be a string" });
					return;
				}
				try {
					url = await assertPublicUrl(body.url);
				} catch {
					res
						.status(400)
						.json({ detail: "url must be a public http(s) address" });
					return;
				}
			}
			let events = hook.events;
			if (body.events !== undefined) {
				const parsed = parseEvents(body.events);
				if (!parsed) {
					res.status(400).json({
						detail: `events must be a non-empty array drawn from: ${WEBHOOK_EVENTS.join(", ")}`,
					});
					return;
				}
				events = parsed.join(",");
			}
			const active = body.active !== undefined ? !!body.active : !!hook.active;
			db.run(
				"UPDATE webhooks SET url = $url, events = $events, active = $active WHERE id = $id",
				{ $url: url, $events: events, $active: active ? 1 : 0, $id: hook.id },
			);
			res.json(
				serializeWebhook(
					db.get<WebhookRow>("SELECT * FROM webhooks WHERE id = $id", {
						$id: hook.id,
					})!,
				),
			);
		}),
	);

	router.delete(
		"/:webhookId(\\d+)",
		requireSession(state),
		requireCsrf,
		requireActiveUser(state),
		(req, res) => {
			const user = req.currentUser!;
			const hook = db.get<WebhookRow>("SELECT * FROM webhooks WHERE id = $id", {
				$id: req.params.webhookId,
			});
			if (!hook || (user.role !== "master" && hook.owner_id !== user.id)) {
				res.status(404).json({ detail: "not found" });
				return;
			}
			db.run("DELETE FROM webhooks WHERE id = $id", { $id: hook.id });
			recordAudit(db, {
				actor: user.username,
				action: "webhook.deleted",
				target: `webhook:${hook.id}`,
				ip: clientIp(state, req),
			});
			res.json({ status: "deleted" });
		},
	);

	router.post(
		"/:webhookId(\\d+)/test",
		requireSession(state),
		requireCsrf,
		requireActiveUser(state),
		asyncHandler(async (req, res) => {
			const user = req.currentUser!;
			const hook = db.get<WebhookRow>("SELECT * FROM webhooks WHERE id = $id", {
				$id: req.params.webhookId,
			});
			if (!hook || (user.role !== "master" && hook.owner_id !== user.id)) {
				res.status(404).json({ detail: "not found" });
				return;
			}
			await sendTestWebhook(state, hook, user.username);
			res.json({ status: "sent" });
		}),
	);

	return router;
}
