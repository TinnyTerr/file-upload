/**
 * The second factor has to survive a leaked password. That means the TOTP
 * step is throttled on the same counters as the password step, the counter is
 * only cleared once a session is actually issued, and an accepted code cannot
 * be presented twice.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { authenticator } from "otplib";
import { getMasterKey } from "../src/config.ts";
import { sealSecret } from "../src/crypto/secretEncrypt.ts";
import type { UserRow } from "../src/db/rows.ts";
import * as credentials from "../src/security/credentials.ts";
import { type Harness, makeHarness, makeUser } from "./harness.ts";

const PASSWORD = "correct horse battery staple";

async function enrolledMaster(
	h: Harness,
	username: string,
): Promise<{ user: UserRow; secret: string }> {
	// Masters always have MFA enforced, so no permission row edits needed.
	const user = await makeUser(h.db, username, "master");
	const secret = authenticator.generateSecret();
	credentials.createTotp(
		h.db,
		user.id,
		sealSecret(getMasterKey(h.state.settings), Buffer.from(secret)),
		"test",
	);
	return { user, secret };
}

async function login(h: Harness, username: string): Promise<Response> {
	return h.request("/api/auth/login", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ username, password: PASSWORD }),
	});
}

async function ticketFor(h: Harness, username: string): Promise<string> {
	const res = await login(h, username);
	expect(res.status).toBe(200);
	const body = (await res.json()) as { status: string; mfa_ticket: string };
	expect(body.status).toBe("mfa_required");
	return body.mfa_ticket;
}

async function verify(
	h: Harness,
	ticket: string,
	code: string,
): Promise<Response> {
	return h.request("/api/auth/totp/verify-login", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ mfa_ticket: ticket, code }),
	});
}

describe("TOTP login step", () => {
	let h: Harness;
	afterEach(() => h.close());

	test("wrong codes lock the account like wrong passwords do", async () => {
		h = await makeHarness();
		await enrolledMaster(h, "guessed");
		const ticket = await ticketFor(h, "guessed");
		for (let i = 0; i < 5; i++) {
			expect((await verify(h, ticket, "000000")).status).toBe(401);
		}
		// Five failures is the lock. Re-authenticating with the (correct)
		// password does not hand out a fresh ticket: the account is locked
		// until the window passes, exactly as after five wrong passwords.
		expect((await login(h, "guessed")).status).toBe(429);
	});

	test("an accepted code is refused when presented again", async () => {
		h = await makeHarness();
		const { secret } = await enrolledMaster(h, "replayed");
		const code = authenticator.generate(secret);

		const first = await verify(h, await ticketFor(h, "replayed"), code);
		expect(first.status).toBe(200);
		expect(first.headers.get("set-cookie")).toContain("fu_session=");

		const again = await verify(h, await ticketFor(h, "replayed"), code);
		expect(again.status).toBe(401);
	});
});

describe("MFA enrolment re-authentication", () => {
	let h: Harness;
	afterEach(() => h.close());

	test("starting an enrolment needs the current password", async () => {
		h = await makeHarness();
		const user = await makeUser(h.db, "enroller");
		const { cookie, csrf } = h.signIn(user);
		const post = (body: unknown) =>
			h.request("/api/account/mfa/totp/setup", {
				method: "POST",
				cookie,
				csrf,
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});
		expect((await post({})).status).toBe(401);
		expect((await post({ current_password: "nope" })).status).toBe(401);
		const ok = await post({ current_password: PASSWORD });
		expect(ok.status).toBe(200);
		expect((await ok.json()) as { secret: string }).toHaveProperty("secret");
	});
});
