import { base64UrlToBytes } from "@/lib/base64url";

/**
 * Rederiving a Seal & Forget key from the password it was sealed with.
 *
 * Must stay byte-for-byte in step with `server/src/crypto/passwordKey.ts`. The
 * server hands out `seal_kdf` (an id carrying the algorithm *and* the iteration
 * count) alongside the salt precisely so this side doesn't hardcode the
 * parameters — a sealed file that predates a parameter change still has to
 * open, and the server keeps nothing that could open it for us.
 */
const SEAL_KEY_BITS = 256;

interface SealParams {
	iterations: number;
}

/** Parse ids of the form `pbkdf2-sha256-600000`. */
function parseKdf(kdf: string): SealParams {
	const match = /^pbkdf2-sha256-(\d+)$/.exec(kdf.trim());
	if (!match) {
		throw new Error(`Unsupported key derivation: ${kdf}`);
	}
	return { iterations: Number(match[1]) };
}

export function isSupportedSealKdf(kdf: string | null | undefined): boolean {
	if (!kdf) return false;
	try {
		parseKdf(kdf);
		return true;
	} catch {
		return false;
	}
}

export async function deriveSealKey(
	password: string,
	saltB64Url: string,
	kdf: string,
): Promise<Uint8Array> {
	const { iterations } = parseKdf(kdf);
	const salt = base64UrlToBytes(saltB64Url);
	const material = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(password),
		"PBKDF2",
		false,
		["deriveBits"],
	);
	const bits = await crypto.subtle.deriveBits(
		{
			name: "PBKDF2",
			salt: salt as BufferSource,
			iterations,
			hash: "SHA-256",
		},
		material,
		SEAL_KEY_BITS,
	);
	return new Uint8Array(bits);
}
