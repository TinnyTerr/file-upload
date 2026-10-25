import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import type { WebhookRow } from "../src/db/rows.ts";
import { shapeDelivery } from "../src/webhooks.ts";

function hook(format: string): WebhookRow {
	return {
		id: 1,
		owner_id: 1,
		url: "https://example.com/h",
		secret: "s3cret",
		events: "file.uploaded",
		active: 1,
		created_at: "2026-01-01T00:00:00.000Z",
		last_triggered_at: null,
		last_status: null,
		format,
	};
}

describe("webhook body shaping", () => {
	test("json is the signed envelope", () => {
		const { body, headers } = shapeDelivery(hook("json"), "file.uploaded", {
			file_id: 3,
		});
		const parsed = JSON.parse(body);
		expect(parsed.event).toBe("file.uploaded");
		expect(parsed.data).toEqual({ file_id: 3 });
		expect(headers["X-Webhook-Signature"]).toBe(
			createHmac("sha256", "s3cret").update(body).digest("hex"),
		);
	});

	test("discord is a single content string", () => {
		const { body } = shapeDelivery(hook("discord"), "file.uploaded", {
			original_filename: "a.txt",
		});
		expect(JSON.parse(body).content).toContain("a.txt was uploaded");
	});

	test("ntfy is plain text with a Title header", () => {
		const { body, headers } = shapeDelivery(hook("ntfy"), "torrent.completed", {
			name: "Ubuntu",
		});
		expect(body).toBe("Ubuntu finished and was imported.");
		expect(headers["Content-Type"]).toBe("text/plain");
		expect(headers.Title).toBe("Torrent finished");
	});
});
