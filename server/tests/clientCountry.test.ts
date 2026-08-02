/**
 * `clientCountry` — the CF-IPCountry reader (middleware/auth.ts).
 *
 * The header is only meaningful because Cloudflare sets it; any client can
 * *send* it. So the point under test is the trust gate: without evidence the
 * request really came through Cloudflare, the header is ignored outright rather
 * than letting a visitor choose their own country.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { Request } from "express";
import type { AppState } from "../src/appState.ts";
import { clientCountry, clientIp } from "../src/middleware/auth.ts";
import {
	type Harness,
	makeHarness,
	makeUser,
	testSettings,
} from "./harness.ts";

/** Minimal Request stand-in: clientCountry only reads headers. */
function fakeReq(headers: Record<string, string>): Request {
	return {
		header: (name: string) => headers[name.toLowerCase()],
		socket: { remoteAddress: "10.0.0.1" },
	} as unknown as Request;
}

function stateWith(mode: "off" | "proxy" | "cloudflare"): AppState {
	return { settings: testSettings({ trustProxyMode: mode }) } as AppState;
}

describe("trust gate", () => {
	test("TRUST_PROXY=cloudflare reads the header", () => {
		expect(
			clientCountry(stateWith("cloudflare"), fakeReq({ "cf-ipcountry": "GB" })),
		).toBe("GB");
	});

	test("TRUST_PROXY=off ignores it entirely", () => {
		expect(
			clientCountry(stateWith("off"), fakeReq({ "cf-ipcountry": "GB" })),
		).toBeNull();
	});

	test("TRUST_PROXY=true needs a CF-Ray to prove Cloudflare was involved", () => {
		// A spoofable header on its own proves nothing.
		expect(
			clientCountry(stateWith("proxy"), fakeReq({ "cf-ipcountry": "GB" })),
		).toBeNull();
		expect(
			clientCountry(
				stateWith("proxy"),
				fakeReq({ "cf-ipcountry": "GB", "cf-ray": "8a1b2c3d4e5f-LHR" }),
			),
		).toBe("GB");
	});
});

describe("Cloudflare's special codes", () => {
	test("XX means Cloudflare has no country data for the client", () => {
		expect(
			clientCountry(stateWith("cloudflare"), fakeReq({ "cf-ipcountry": "XX" })),
		).toBe("XX");
	});

	test("T1 means the client arrived over Tor", () => {
		expect(
			clientCountry(stateWith("cloudflare"), fakeReq({ "cf-ipcountry": "T1" })),
		).toBe("T1");
	});
});

describe("parsing", () => {
	test("normalizes case and surrounding whitespace", () => {
		expect(
			clientCountry(
				stateWith("cloudflare"),
				fakeReq({ "cf-ipcountry": "  de " }),
			),
		).toBe("DE");
	});

	test("a malformed value is treated as absent, not stored", () => {
		for (const bad of ["", "G", "GBR", "G1B", "??", "<script>"]) {
			expect(
				clientCountry(
					stateWith("cloudflare"),
					fakeReq({ "cf-ipcountry": bad }),
				),
			).toBeNull();
		}
	});

	test("an absent header is null", () => {
		expect(clientCountry(stateWith("cloudflare"), fakeReq({}))).toBeNull();
	});
});

describe("alongside clientIp", () => {
	test("both honour the same Cloudflare gate", () => {
		const req = fakeReq({
			"cf-ipcountry": "FR",
			"cf-connecting-ip": "203.0.113.7",
		});
		const state = stateWith("cloudflare");
		expect(clientIp(state, req)).toBe("203.0.113.7");
		expect(clientCountry(state, req)).toBe("FR");
	});
});

describe("persistence", () => {
	let h: Harness;
	afterEach(() => h?.close());

	test("a session records the country it was created from", async () => {
		h = await makeHarness();
		const user = await makeUser(h.db, "alice");
		h.state.sessionManager.create(h.db, user.id, {
			ip: "203.0.113.7",
			userAgent: "test",
			countryCode: "T1",
		});
		const row = h.db.get<{ country_code: string | null }>(
			"SELECT country_code FROM sessions WHERE user_id = $id",
			{ $id: user.id },
		);
		expect(row?.country_code).toBe("T1");
	});

	test("no Cloudflare in front means the column stays NULL, not a guess", async () => {
		h = await makeHarness();
		const user = await makeUser(h.db, "bob");
		h.state.sessionManager.create(h.db, user.id, { ip: "10.0.0.1" });
		const row = h.db.get<{ country_code: string | null }>(
			"SELECT country_code FROM sessions WHERE user_id = $id",
			{ $id: user.id },
		);
		expect(row?.country_code).toBeNull();
	});

	test("the sessions endpoint surfaces it", async () => {
		h = await makeHarness();
		const user = await makeUser(h.db, "carol");
		const { cookieValue, csrfToken } = h.state.sessionManager.create(
			h.db,
			user.id,
			{ ip: "203.0.113.7", userAgent: "test", countryCode: "JP" },
		);
		void csrfToken;
		const res = await h.request("/api/auth/sessions", {
			cookie: `fu_session=${cookieValue}`,
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			sessions: { country_code: string | null }[];
		};
		expect(body.sessions[0]?.country_code).toBe("JP");
	});
});
