import { base64UrlToBytes, bytesToBase64Url, randomKey } from "@/lib/base64url";
import { decryptBlob, encryptBlob } from "@/workers/aeadClient";

const KEY_CHECK_TEXT = "fileupload:directory-key-check:v1";

export async function createFolderKeyMaterial() {
	const key = randomKey();
	return {
		key,
		clientKeyB64: bytesToBase64Url(key),
		keyCheckBlob: await createFolderKeyCheckBlob(key),
	};
}

export async function createFolderKeyCheckBlob(
	key: Uint8Array,
): Promise<string> {
	const marker = new Blob([KEY_CHECK_TEXT], { type: "text/plain" });
	const encrypted = await encryptBlob(marker, key);
	return bytesToBase64Url(new Uint8Array(await encrypted.arrayBuffer()));
}

export async function verifyFolderKey(
	keyB64: string,
	keyCheckBlob: string,
): Promise<Uint8Array> {
	const key = base64UrlToBytes(keyB64.trim());
	if (key.byteLength !== 32) {
		throw new Error("Folder key must be a 32-byte base64url key.");
	}
	const bytes = base64UrlToBytes(keyCheckBlob);
	const encrypted = new Blob(
		[
			bytes.buffer.slice(
				bytes.byteOffset,
				bytes.byteOffset + bytes.byteLength,
			) as ArrayBuffer,
		],
		{ type: "application/octet-stream" },
	);
	const plain = await decryptBlob(encrypted, key);
	if ((await plain.text()) !== KEY_CHECK_TEXT) {
		throw new Error("Folder key check failed.");
	}
	return key;
}
