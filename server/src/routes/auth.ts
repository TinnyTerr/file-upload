import type { Request, Response } from "express";
import { Router } from "express";
import { authenticator } from "otplib";
import type { AppState } from "../appState.ts";
import { recordAudit } from "../audit.ts";
import { ensureCredentialMaterial } from "../cluster/identityFetch.ts";
import { getMasterKey } from "../config.ts";
import { openSecret } from "../crypto/secretEncrypt.ts";
import type { UserRow } from "../db/rows.ts";
import { asyncHandler } from "../middleware/asyncHandler.ts";
import { clientCountry, clientIp, requireSession } from "../middleware/auth.ts";
import { mfaEnforcedFor, passkeyEnforcedFor } from "../permissions.ts";
import * as credentials from "../security/credentials.ts";
import { requireCsrf } from "../security/csrf.ts";
import { verifyDummyPassword, verifyPassword } from "../security/passwords.ts";
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

			const found = db.get<UserRow>(
				"SELECT * FROM users WHERE username = $username",
				{ $username: username },
			);

			// §5.10, D-12: `password_hash` and the TOTP seeds do not replicate.
			// If this node has never authenticated this user -- or a password
			// change elsewhere has invalidated what it holds -- it pulls the
			// material up the tier now, once, and verifies locally from here on.
			// The candidate password never leaves this node either way.
			//
			// Deliberately after the lockout check above: a fetch is a peer
			// request, and letting an unthrottled login attempt trigger one would
			// hand an attacker a lever on the master.
			const user = found
				? await ensureCredentialMaterial(state, found)
				: undefined;

			// The dummy verify on the miss path is what keeps "no such user" and
			// "wrong password" indistinguishable by timing -- it must run, and its
			// result is never the answer.
			let ok = false;
			if (user) {
				ok = await verifyPassword(password, user.password_hash);
			} else {
				await verifyDummyPassword(password);
			}

			if (!user || !ok) {
				lockout.recordFailure(db, username, "username");
				lockout.recordFailure(db, ip, "ip");
				recordAudit(db, { actor: username, action: "login.failure", ip });
				res.status(401).json({ detail: "invalid credentials" });
				return;
			}

			lockout.resetSuccess(db, username);

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
			const totpCreds = credentials
				.listForUser(db, userId)
				.filter((c) => c.kind === "totp" && c.secret_blob);
			const masterKey = getMasterKey(state.settings);
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

			if (!matched) {
				recordAudit(db, {
					actor: user.username,
					action: "login.mfa_failure",
					ip,
				});
				res.status(401).json({ detail: "invalid code" });
				return;
			}

			state.secondFactorTickets.destroy(ticket);
			credentials.touchLastUsed(db, matched.id);
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
			const options = await buildAuthenticationOptions(rpContext);
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
			if (!credRow?.webauthn_id || !credRow.webauthn_public_key) {
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
