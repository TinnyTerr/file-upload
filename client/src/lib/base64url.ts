/**
 * base64url (RFC 4648 §5) without padding — the transport format the backend
 * uses for encryption keys in `#ek=` / `?ek=`.
 */

export function bytesToBase64Url(bytes: Uint8Array): string {
	let bin = "";
	for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
	return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlToBytes(s: string): Uint8Array {
	const norm = s.replace(/-/g, "+").replace(/_/g, "/");
	const pad = norm.length % 4 === 0 ? "" : "=".repeat(4 - (norm.length % 4));
	const bin = atob(norm + pad);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

/** Generate a fresh 32-byte (AES-256) key. */
export function randomKey(): Uint8Array {
	const k = new Uint8Array(32);
	crypto.getRandomValues(k);
	return k;
}
