/**
 * Rate limiting for password-locked share links.
 *
 * A random `?ek=` token is 144 bits -- guessing it over HTTP is not a threat
 * model. A password chosen by a human is, so the moment an owner swaps the
 * token for one (see `PUT /directories/:id/access`), the public check on that
 * link stops being a plain comparison and starts being an authentication
 * attempt that has to be throttled.
 *
 * The counter is keyed on the **secret being guessed** -- the key scope, i.e.
 * the break-point folder or the file that actually owns the password -- and not
 * on the requester's IP, which a distributed guesser would sail straight past.
 *
 * It is deliberately *not* keyed on the presenting link slug either. One
 * password-locked folder can have hundreds of member files, each with its own
 * link whose slug `/d/:slug/info` hands out unauthenticated; a per-slug counter
 * would give an attacker one fresh budget per member against the same password.
 *
 * Sharing the `login_attempts` table (and `LockoutPolicy`'s rolling window)
 * means the lock survives restarts and shows up where operators already look.
 */

import type { AppState } from "../appState.ts";
import { getMasterKey } from "../config.ts";
import type { EffectiveEncryption } from "../crypto/effectiveEncryption.ts";
import {
	accessSecretMatches,
	recoverAccessSecret,
} from "../crypto/effectiveEncryption.ts";
import { HttpError } from "../httpError.ts";

export const LINK_ACCESS_IDENTIFIER = "link_access";
const IDENTIFIER_TYPE = LINK_ACCESS_IDENTIFIER;

export interface AccessCheck {
	ok: boolean;
	/** 429 when the slug is locked out, 401 for a plain mismatch. */
	status: 401 | 429;
	detail: string;
}

/** Verifies a presented `?ek=` against a node's effective access secret,
 * throttling per slug when that secret is a password. Returns a result rather
 * than throwing so callers keep their existing response shapes. */
export function checkLinkAccess(
	state: AppState,
	/** The key scope being guessed against -- `crypto/effectiveEncryption.ts`'s
	 * `keyScopeOf`, never a link slug. */
	scope: string,
	eff: EffectiveEncryption,
	presented: string | null,
	opts: {
		/** Old server-encrypted *files* may carry no access blob at all, and the
		 * slug has always been their only credential. Folders have never had that
		 * allowance and stay fail-closed. */
		allowMissingSecret?: boolean;
	} = {},
): AccessCheck {
	if (eff.mode !== "server") return { ok: true, status: 401, detail: "" };
	const expected = recoverAccessSecret(getMasterKey(state.settings), eff);
	if (expected === null) {
		return !eff.accessBlob && opts.allowMissingSecret
			? { ok: true, status: 401, detail: "" }
			: {
					ok: false,
					status: 401,
					detail: "missing or invalid access key (?ek=)",
				};
	}
	if (!eff.passwordLocked) {
		return accessSecretMatches(expected, presented)
			? { ok: true, status: 401, detail: "" }
			: {
					ok: false,
					status: 401,
					detail: "missing or invalid access key (?ek=)",
				};
	}

	const { db, lockout } = state;
	if (lockout.isIdentifierLocked(db, scope, IDENTIFIER_TYPE)) {
		return {
			ok: false,
			status: 429,
			detail: "too many incorrect passwords; try again later",
		};
	}
	if (accessSecretMatches(expected, presented)) {
		lockout.resetIdentifier(db, scope, IDENTIFIER_TYPE);
		return { ok: true, status: 401, detail: "" };
	}
	// A missing password is a failed attempt like any other -- otherwise the
	// counter could be avoided entirely by omitting the parameter.
	lockout.recordFailure(db, scope, IDENTIFIER_TYPE);
	return lockout.isIdentifierLocked(db, scope, IDENTIFIER_TYPE)
		? {
				ok: false,
				status: 429,
				detail: "too many incorrect passwords; try again later",
			}
		: { ok: false, status: 401, detail: "incorrect password" };
}

/** Owner-supplied access secrets. Kept deliberately short so a memorable
 * passphrase is usable, but not so short that the lockout is the only defence. */
export const MIN_ACCESS_PASSWORD = 8;
export const MAX_ACCESS_PASSWORD = 256;

export function validateAccessPassword(password: unknown): string {
	if (typeof password !== "string") {
		throw new HttpError(400, "password must be a string");
	}
	if (password.length < MIN_ACCESS_PASSWORD) {
		throw new HttpError(
			400,
			`password must be at least ${MIN_ACCESS_PASSWORD} characters`,
		);
	}
	if (password.length > MAX_ACCESS_PASSWORD) {
		throw new HttpError(
			400,
			`password must be at most ${MAX_ACCESS_PASSWORD} characters`,
		);
	}
	return password;
}
