import { createHmac, randomBytes } from "node:crypto";
import type { AppState } from "./appState.ts";
import { nowIso, type WebhookRow } from "./db/rows.ts";
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
	"dropbox.received",
	"torrent.completed",
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

/** How a hook's body is shaped. `json` is the signed machine-readable envelope;
 * the others are for chat/push services that want a sentence, not a schema, so
 * they carry no payload beyond that sentence. */
export const WEBHOOK_FORMATS = ["json", "discord", "ntfy"] as const;
export type WebhookFormat = (typeof WEBHOOK_FORMATS)[number];

export function isWebhookFormat(value: unknown): value is WebhookFormat {
	return (
		typeof value === "string" &&
		(WEBHOOK_FORMATS as readonly string[]).includes(value)
	);
}

function str(v: unknown, fallback = "a file"): string {
	return typeof v === "string" && v ? v : fallback;
}

/** One-line human summary of an event, for the sentence-shaped formats. */
export function describeEvent(
	event: WebhookEvent,
	data: Record<string, unknown>,
): { title: string; text: string } {
	if (data.test === true) {
		return {
			title: "Webhook test",
			text: `Test delivery triggered by ${str(data.triggered_by, "someone")}.`,
		};
	}
	switch (event) {
		case "file.uploaded":
			return {
				title: "File uploaded",
				text: `${str(data.original_filename)} was uploaded.`,
			};
		case "file.downloaded":
			return {
				title: "File downloaded",
				text: `${str(data.original_filename)} was downloaded.`,
			};
		case "link.created":
			return {
				title: "Link created",
				text: `A share link was created for ${str(data.original_filename)}.`,
			};
		case "dropbox.received":
			return {
				title: "Dropbox upload",
				text: `${str(data.original_filename)} arrived through a dropbox link.`,
			};
		case "torrent.completed":
			return {
				title: "Torrent finished",
				text: `${str(data.name, "A torrent")} finished and was imported.`,
			};
	}
}

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
	await Promise.all(
		targets.map((h) => deliverToHook(state, h, event, payload)),
	);
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

export function shapeDelivery(
	hook: WebhookRow,
	event: WebhookEvent,
	payload: Record<string, unknown>,
): { body: string; headers: Record<string, string> } {
	const signed = (body: string, type: string) => ({
		"Content-Type": type,
		"X-Webhook-Event": event,
		"X-Webhook-Signature": signPayload(hook.secret, body),
	});
	if (hook.format === "discord") {
		const { title, text } = describeEvent(event, payload);
		const body = JSON.stringify({ content: `**${title}** — ${text}` });
		return { body, headers: signed(body, "application/json") };
	}
	if (hook.format === "ntfy") {
		const { title, text } = describeEvent(event, payload);
		return {
			body: text,
			headers: { ...signed(text, "text/plain"), Title: title, Tags: "package" },
		};
	}
	const body = JSON.stringify({ event, fired_at: nowIso(), data: payload });
	return { body, headers: signed(body, "application/json") };
}

async function deliverToHook(
	state: AppState,
	hook: WebhookRow,
	event: WebhookEvent,
	payload: Record<string, unknown>,
): Promise<void> {
	const { body, headers } = shapeDelivery(hook, event, payload);
	let status: number | null = null;
	try {
		const res = await fetchLogged(
			"webhook",
			hook.url,
			{
				method: "POST",
				headers,
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
