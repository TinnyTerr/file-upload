import { createHmac, randomBytes } from "node:crypto";
import type { AppState } from "./appState.ts";
import { type WebhookRow, nowIso } from "./db/rows.ts";
import { getLogger } from "./logging.ts";
import { fetchLogged } from "./outbound.ts";

const log = getLogger("app.webhooks");

/** The only event names a webhook may subscribe to. Adding one means also
 * calling `triggerWebhooks` from the route that produces it -- an unwired
 * event would let someone subscribe to something that silently never fires. */
export const WEBHOOK_EVENTS = [
	"file.uploaded",
	"file.downloaded",
	"link.created",
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export function isWebhookEvent(value: unknown): value is WebhookEvent {
	return (
		typeof value === "string" &&
		(WEBHOOK_EVENTS as readonly string[]).includes(value)
	);
}

export function generateWebhookSecret(): string {
	return randomBytes(24).toString("base64url");
}

function signPayload(secret: string, body: string): string {
	return createHmac("sha256", secret).update(body, "utf-8").digest("hex");
}

/**
 * Fire-and-forget delivery to every active webhook the owner has subscribed
 * to `event` for. Never awaited by the caller's request path -- same shape as
 * `replicateFile`'s best-effort cluster replication in routes/files.ts, so a
 * slow or dead endpoint on the far side never adds latency to an upload,
 * download or link creation.
 *
 * The URL was validated against `validatePublicHttpUrl` +
 * `resolvePublicAddress` at registration time (routes/webhooks.ts), the same
 * SSRF guard remote-upload URLs get -- an attacker-chosen URL fired from the
 * server's own network position is exactly the surface that guard exists for.
 * DNS is not re-resolved on every delivery (rebinding after registration is a
 * narrower window than remote-upload's single fetch, and re-checking every
 * delivery would cost a DNS round trip per event); this is an accepted gap
 * worth tightening if webhooks ever point at anything more sensitive.
 */
export async function triggerWebhooks(
	state: AppState,
	ownerId: number,
	event: WebhookEvent,
	payload: Record<string, unknown>,
): Promise<void> {
	const hooks = state.db.all<WebhookRow>(
		"SELECT * FROM webhooks WHERE owner_id = $ownerId AND active = 1",
		{ $ownerId: ownerId },
	);
	const targets = hooks.filter((h) => h.events.split(",").includes(event));
	await Promise.all(targets.map((h) => deliverToHook(state, h, event, payload)));
}

/** Same delivery as `triggerWebhooks`, for exactly one hook, bypassing its own
 * event subscription -- what `POST /api/webhooks/:id/test` needs: a hook that
 * only subscribed to `file.downloaded` should still be testable. */
export async function sendTestWebhook(
	state: AppState,
	hook: WebhookRow,
	triggeredBy: string,
): Promise<void> {
	await deliverToHook(state, hook, "file.uploaded", {
		test: true,
		triggered_by: triggeredBy,
	});
}

async function deliverToHook(
	state: AppState,
	hook: WebhookRow,
	event: WebhookEvent,
	payload: Record<string, unknown>,
): Promise<void> {
	const body = JSON.stringify({
		event,
		fired_at: nowIso(),
		data: payload,
	});
	let status: number | null = null;
	try {
		const res = await fetchLogged(
			"webhook",
			hook.url,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-Webhook-Event": event,
					"X-Webhook-Signature": signPayload(hook.secret, body),
				},
				body,
				signal: AbortSignal.timeout(10_000),
			},
			{ redact: "origin" },
		);
		status = res.status;
	} catch (err) {
		log.warning(
			`webhook delivery failed webhook_id=${hook.id} event=${event}: ${
				err instanceof Error ? err.message : String(err)
			}`,
		);
	}
	state.db.run(
		"UPDATE webhooks SET last_triggered_at = $now, last_status = $status WHERE id = $id",
		{ $now: nowIso(), $status: status, $id: hook.id },
	);
}
