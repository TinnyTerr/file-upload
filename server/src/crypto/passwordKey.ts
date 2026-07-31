/**
 * Deriving a file key from a chosen password.
 *
 * Used by Seal & Forget (`POST /files/:id/seal`) when the owner would rather
 * remember a password than write down a random key. The derivation has to be
 * reproducible in a *browser*, since a sealed file is decrypted client-side
 * exactly like a `client`-mode one -- so it is PBKDF2-HMAC-SHA256, which
 * WebCrypto's `deriveBits` implements natively, rather than scrypt/argon2,
 * which it does not.
 *
 * The salt is stored in the clear on the file row and handed out with the
 * public file info. That is deliberate: a salt is not a secret, and the server
 * must keep *nothing* that opens a sealed file. The password's own entropy is
 * the only thing protecting it, which is why the iteration count is high and
 * why the UI has to be honest that a weak password means a weak seal.
 */

import { pbkdf2 } from "node:crypto";

export const SEAL_KDF = "pbkdf2-sha256";
export const SEAL_KDF_ITERATIONS = 600_000; // OWASP's PBKDF2-SHA256 floor
export const SEAL_SALT_BYTES = 16;
export const SEAL_KEY_BYTES = 32; // AES-256

/** The identifier handed to clients so they derive with the same parameters
 * instead of hardcoding them. */
export function sealKdfId(): string {
	return `${SEAL_KDF}-${SEAL_KDF_ITERATIONS}`;
}

export function deriveSealKey(
	password: string,
	salt: Uint8Array,
): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		pbkdf2(
			Buffer.from(password, "utf-8"),
			Buffer.from(salt),
			SEAL_KDF_ITERATIONS,
			SEAL_KEY_BYTES,
			"sha256",
			(err, derived) => (err ? reject(err) : resolve(derived)),
		);
	});
}
