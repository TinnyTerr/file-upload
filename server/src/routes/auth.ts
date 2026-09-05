import type { Request, Response } from "express";
import { Router } from "express";
import { authenticator } from "otplib";
import type { AppState } from "../appState.ts";
import { recordAudit } from "../audit.ts";
import { getMasterKey } from "../config.ts";
import { openSecret } from "../crypto/secretEncrypt.ts";
import type { UserRow } from "../db/rows.ts";
import { asyncHandler } from "../middleware/asyncHandler.ts";
import { clientCountry, clientIp, requireSession } from "../middleware/auth.ts";
import { mfaEnforcedFor, passkeyEnforcedFor } from "../permissions.ts";
import * as credentials from "../security/credentials.ts";
import { requireCsrf } from "../security/csrf.ts";
import {
	hashPassword,
	verifyDummyPassword,
	verifyPassword,
} from "../security/passwords.ts";
import { COOKIE_NAME, type SessionRow } from "../security/sessions.ts";
import {
	buildAuthenticationOptions,
	resolveRpContext,
	verifyAuthentication,
} from "../security/webauthn.ts";

/** Mirrors app/routes/auth.py -- login/logout/session listing/revocation,
 * matching status codes, cookie attrs, and CSRF header behavior exactly.
 * Extended with a second-factor step (TOTP/WebAuthn) and usernameless
 * WebAuthn login -- see CLAUDE.md's "Login + second factor" section. */
export function authRouter(state: AppState): Router {
	const router = Router();
	const { db, sessionManager, lockout } = state;

	function issueSession(
		req: Request,
		res: Response,
		user: UserRow,
		ip: string,
		forceMfaEnrollment: boolean,
	): void {
		// The failure counter clears only once the *whole* ceremony succeeds.
		// Clearing it at the password step let an attacker holding a leaked
		// password burn the ticket's attempts, log in again to reset, and loop --
		// which made the second factor guessable at no cost.
		lockout.resetSuccess(db, user.username);
		const { cookieValue, csrfToken } = sessionManager.create(db, user.id, {
			ip,
			userAgent: req.header("user-agent") ?? null,
			// Recorded once, at login: it describes where the session was started
			// from, so it must not drift as the user moves around.
			countryCode: clientCountry(state, req),
		});
		res.cookie(COOKIE_NAME, cookieValue, sessionManager.cookieParams());
		res.json({
			csrf_token: csrfToken,
			must_change_credentials: !!user.must_change_credentials,
			force_mfa_enrollment: forceMfaEnrollment,
		});
	}

	/** Whether a passkey ceremony on this `conn_id` follows a verified password
	 * (the challenge was moved to `awaiting_second_factor` by `/login`) or is
	 * the whole login. The two get different user-verification demands --
	 * security/webauthn.ts. */
	function isSecondFactor(connId: string): boolean {
		return (
			state.loginChallenges.get(connId)?.state === "awaiting_second_factor"
		);
	}

	router.get("/ws-token", (req, res) => {
		if (!state.wsTokenRateLimiter.allow(clientIp(state, req))) {
			res.status(429).json({ detail: "too many attempts, try later" });
			return;
		}
		const connId = state.loginChallenges.create();
		res.json({ conn_id: connId, expires_in: 300 });
	});

	router.post(
		"/login",
		asyncHandler(async (req, res) => {
			const { username, password, conn_id: connId } = req.body ?? {};
			if (typeof username !== "string" || typeof password !== "string") {
				res.status(422).json({ detail: "username and password required" });
				return;
			}
			const ip = clientIp(state, req);

			if (!lockout.checkLoginAllowed(db, username, ip)) {
				recordAudit(db, { actor: username, action: "login.locked_out", ip });
				res.status(429).json({ detail: "too many attempts, try later" });
				return;
			}

			const user = db.get<UserRow>(
				"SELECT * FROM users WHERE username = $username",
				{ $username: username },
			);

			const ok = user
				? await verifyPassword(password, user.password_hash)
				: (await verifyDummyPassword(password), false);

			if (!user || !ok) {
				lockout.recordFailure(db, username, "username");
				lockout.recordFailure(db, ip, "ip");
				recordAudit(db, { actor: username, action: "login.failure", ip });
				res.status(401).json({ detail: "invalid credentials" });
				return;
			}

			const credRows = credentials.listForUser(db, user.id);
			const mfaEnforced = mfaEnforcedFor(db, user);
			// `require_passkey` narrows which factor is acceptable, so a
			// TOTP-only account under that flag counts as having no usable
			// factor at all and is sent to enrollment instead of a challenge.
			const usableCreds = passkeyEnforcedFor(db, user)
				? credRows.filter((c) => c.kind === "webauthn")
				: credRows;

			if (usableCreds.length > 0 && mfaEnforced) {
				const ticket = state.secondFactorTickets.create(user.id);
				if (typeof connId === "string" && connId) {
					state.loginChallenges.transition(connId, {
						state: "awaiting_second_factor",
						userId: user.id,
					});
				}
				recordAudit(db, {
					actor: username,
					action: "login.mfa_challenge_issued",
					ip,
				});
				res.json({
					status: "mfa_required",
					mfa_ticket: ticket,
					methods: [...new Set(usableCreds.map((c) => c.kind))],
				});
				return;
			}

			recordAudit(db, { actor: username, action: "login.success", ip });
			issueSession(req, res, user, ip, mfaEnforced && usableCreds.length === 0);
		}),
	);

	router.post(
		"/totp/verify-login",
		asyncHandler(async (req, res) => {
			const { mfa_ticket: ticket, code, conn_id: connId } = req.body ?? {};
			if (typeof ticket !== "string" || typeof code !== "string") {
				res.status(422).json({ detail: "mfa_ticket and code required" });
				return;
			}
			const ip = clientIp(state, req);
			const userId = state.secondFactorTickets.consumeAttempt(ticket);
			if (userId === null) {
				res.status(401).json({ detail: "invalid or expired ticket" });
				return;
			}
			const user = db.get<UserRow>("SELECT * FROM users WHERE id = $id", {
				$id: userId,
			});
			if (!user) {
				res.status(401).json({ detail: "invalid or expired ticket" });
				return;
			}
			// A TOTP code can never satisfy `require_passkey`, even if the
			// account still has an authenticator app enrolled from before the
			// flag was set.
			if (passkeyEnforcedFor(db, user)) {
				res.status(403).json({ detail: "a passkey is required to sign in" });
				return;
			}
			// A 6-digit code is guessable in a way a password is not, so this
			// step is throttled on exactly the same counters as the password
			// step. The ticket's own attempt cap is not enough: a fresh ticket
			// costs one (correct) password.
			if (!lockout.checkLoginAllowed(db, user.username, ip)) {
				recordAudit(db, {
					actor: user.username,
					action: "login.locked_out",
					ip,
				});
				res.status(429).json({ detail: "too many attempts, try later" });
				return;
			}
			const totpCreds = credentials
				.listForUser(db, userId)
				.filter((c) => c.kind === "totp" && c.secret_blob);
			const masterKey = getMasterKey(state.settings);
			const step = credentials.totpStep();
			const matched = totpCreds.find((c) => {
				try {
					const secret = openSecret(
						masterKey,
						Buffer.from(c.secret_blob!),
					).toString();
					return authenticator.verify({ token: code, secret });
				} catch {
					return false;
				}
			});
			// A code is single-use. One that verifies but belongs to a step this
			// credential has already accepted is a replay, and counts as a
			// failure like any other wrong code.
			const replayed =
				!!matched &&
				matched.totp_last_step !== null &&
				step <= matched.totp_last_step;

			if (!matched || replayed) {
				lockout.recordFailure(db, user.username, "username");
				lockout.recordFailure(db, ip, "ip");
				recordAudit(db, {
					actor: user.username,
					action: "login.mfa_failure",
					ip,
				});
				res.status(401).json({ detail: "invalid code" });
				return;
			}

			state.secondFactorTickets.destroy(ticket);
			credentials.markTotpUsed(db, matched.id, step);
			if (typeof connId === "string" && connId) {
				state.loginChallenges.transition(connId, { state: "done" });
			}
			recordAudit(db, {
				actor: user.username,
				action: "login.mfa_success",
				ip,
			});
			issueSession(req, res, user, ip, false);
		}),
	);

	router.post(
		"/webauthn/login/start",
		asyncHandler(async (req, res) => {
			const { conn_id: providedConnId } = req.body ?? {};
			let rpContext: { rpID: string; origin: string };
			try {
				rpContext = resolveRpContext(state.settings, req);
			} catch (err) {
				res.status(400).json({
					detail: err instanceof Error ? err.message : "invalid origin",
				});
				return;
			}
			const connId =
				typeof providedConnId === "string" && providedConnId
					? providedConnId
					: state.loginChallenges.create();
			const options = await buildAuthenticationOptions(
				rpContext,
				!isSecondFactor(connId),
			);
			state.loginChallenges.setWebauthnChallenge(connId, options.challenge);
			res.json({ options, conn_id: connId });
		}),
	);

	router.post(
		"/webauthn/login/finish",
		asyncHandler(async (req, res) => {
			const { conn_id: connId, response } = req.body ?? {};
			const ip = clientIp(state, req);
			if (
				typeof connId !== "string" ||
				!connId ||
				!response ||
				typeof response !== "object"
			) {
				res.status(422).json({ detail: "conn_id and response required" });
				return;
			}
			const challenge = state.loginChallenges.takeWebauthnChallenge(connId);
			if (!challenge) {
				res
					.status(400)
					.json({ detail: "authentication ceremony expired, try again" });
				return;
			}
			const credRow = credentials.findWebauthnByCredentialId(
				db,
				(response as { id?: string }).id ?? "",
			);
			if (!credRow || !credRow.webauthn_id || !credRow.webauthn_public_key) {
				recordAudit(db, {
					actor: "unknown",
					action: "login.webauthn_failure",
					ip,
				});
				res.status(401).json({ detail: "unknown passkey" });
				return;
			}
			const user = db.get<UserRow>("SELECT * FROM users WHERE id = $id", {
				$id: credRow.user_id,
			});
			if (!user) {
				res.status(401).json({ detail: "unknown passkey" });
				return;
			}
			let rpContext: { rpID: string; origin: string };
			try {
				rpContext = resolveRpContext(state.settings, req);
			} catch (err) {
				res.status(400).json({
					detail: err instanceof Error ? err.message : "invalid origin",
				});
				return;
			}
			const transports = credRow.transports
				? JSON.parse(credRow.transports)
				: undefined;
			let verification: Awaited<ReturnType<typeof verifyAuthentication>>;
			try {
				verification = await verifyAuthentication(
					rpContext,
					response as never,
					challenge,
					{
						id: credRow.webauthn_id,
						publicKey: new Uint8Array(credRow.webauthn_public_key),
						counter: credRow.sign_count,
						transports,
					},
					!isSecondFactor(connId),
				);
			} catch (err) {
				recordAudit(db, {
					actor: user.username,
					action: "login.webauthn_failure",
					ip,
				});
				res.status(401).json({
					detail: err instanceof Error ? err.message : "verification failed",
				});
				return;
			}
			if (!verification.verified) {
				recordAudit(db, {
					actor: user.username,
					action: "login.webauthn_failure",
					ip,
				});
				res.status(401).json({ detail: "verification failed" });
				return;
			}

			credentials.bumpSignCount(
				db,
				credRow.id,
				verification.authenticationInfo.newCounter,
			);
			state.loginChallenges.transition(connId, { state: "done" });
			recordAudit(db, {
				actor: user.username,
				action: "login.webauthn_usernameless_success",
				ip,
			});
			issueSession(req, res, user, ip, false);
		}),
	);

	router.post("/logout", requireSession(state), requireCsrf, (req, res) => {
		const cookieValue = req.cookies?.[COOKIE_NAME] as string | undefined;
		sessionManager.destroy(db, cookieValue);
		const user = db.get<UserRow>("SELECT * FROM users WHERE id = $id", {
			$id: req.sessionRow!.user_id,
		});
		recordAudit(db, {
			actor: user?.username ?? String(req.sessionRow!.user_id),
			action: "logout",
		});
		res.clearCookie(COOKIE_NAME, { path: "/" });
		res.json({ status: "logged_out" });
	});

	router.get("/sessions", requireSession(state), (req, res) => {
		const current = req.sessionRow!;
		const rows = db.all<SessionRow>(
			"SELECT * FROM sessions WHERE user_id = $userId AND expires_at > $now",
			{ $userId: current.user_id, $now: new Date().toISOString() },
		);
		res.json({
			sessions: rows.map((s) => ({
				id: s.id,
				ip_address: s.ip_address,
				user_agent: s.user_agent,
				country_code: s.country_code,
				created_at: s.created_at,
				last_seen_at: s.last_seen_at,
				expires_at: s.expires_at,
				is_current: s.id === current.id,
			})),
		});
	});

	router.delete(
		"/sessions/:id",
		requireSession(state),
		requireCsrf,
		asyncHandler(async (req, res) => {
			const { current_password: currentPassword } = req.body ?? {};
			const current = req.sessionRow!;
			const user = db.get<UserRow>("SELECT * FROM users WHERE id = $id", {
				$id: current.user_id,
			})!;
			if (
				typeof currentPassword !== "string" ||
				!(await verifyPassword(currentPassword, user.password_hash))
			) {
				res.status(401).json({ detail: "invalid credentials" });
				return;
			}
			const target = db.get<SessionRow>(
				"SELECT * FROM sessions WHERE id = $id",
				{ $id: req.params.id },
			);
			if (!target || target.user_id !== current.user_id) {
				res.status(404).json({ detail: "session not found" });
				return;
			}
			db.run("DELETE FROM sessions WHERE id = $id", { $id: target.id });
			recordAudit(db, {
				actor: user.username,
				action: "session.revoked",
				target: target.id,
			});
			res.json({ status: "revoked" });
		}),
	);

	router.delete(
		"/sessions",
		requireSession(state),
		requireCsrf,
		asyncHandler(async (req, res) => {
			const { current_password: currentPassword } = req.body ?? {};
			const current = req.sessionRow!;
			const user = db.get<UserRow>("SELECT * FROM users WHERE id = $id", {
				$id: current.user_id,
			})!;
			if (
				typeof currentPassword !== "string" ||
				!(await verifyPassword(currentPassword, user.password_hash))
			) {
				res.status(401).json({ detail: "invalid credentials" });
				return;
			}
			db.run("DELETE FROM sessions WHERE user_id = $userId", {
				$userId: current.user_id,
			});
			recordAudit(db, { actor: user.username, action: "session.revoked_all" });
			res.clearCookie(COOKIE_NAME, { path: "/" });
			res.json({ status: "all_revoked" });
		}),
	);

	return router;
}
