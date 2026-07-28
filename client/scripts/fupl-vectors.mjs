/**
 * FUPL v1 interop verification: proves the browser worker's crypto core is
 * byte-compatible with the server's container (server/src/crypto/aead.ts).
 *
 *   1. JS(worker) encrypts -> server decrypts -> must equal original plaintext
 *   2. server encrypts -> JS(worker) decrypts -> must equal original plaintext
 *
 * Run from client/: `bun scripts/fupl-vectors.mjs`
 *
 * Both sides are TypeScript imported directly (Bun transpiles on the fly), so
 * this exercises the real primitives rather than a re-implementation. The
 * server side is file-oriented, hence the temp-directory round trips.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { encryptBytes, decryptBytes } = await import(
	"../src/workers/fuplCore.ts"
);
const { encryptFile, decryptStream } = await import(
	"../../server/src/crypto/aead.ts"
);

/** Server-side decrypt of a .fupl file into one buffer. */
async function serverDecrypt(key, path) {
	const parts = [];
	for await (const chunk of decryptStream(Buffer.from(key), path)) {
		parts.push(chunk);
	}
	return new Uint8Array(Buffer.concat(parts));
}

function eq(a, b) {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

/** crypto.getRandomValues caps at 64 KiB per call; fill larger buffers in slices. */
function randomBytes(n) {
	const buf = new Uint8Array(n);
	for (let off = 0; off < n; off += 65536) {
		crypto.getRandomValues(buf.subarray(off, Math.min(off + 65536, n)));
	}
	return buf;
}

const CASES = {
	empty: new Uint8Array(0),
	small: new TextEncoder().encode("hello fupl 🔐 interop"),
	"sub-chunk": randomBytes(1024 * 1024), // 1 MiB
	"exact-2MiB": randomBytes(2 * 1024 * 1024),
	multi: randomBytes(5 * 1024 * 1024 + 123), // 3 chunks
};

const work = mkdtempSync(join(tmpdir(), "fupl-"));
let failures = 0;

try {
	for (const [name, plaintext] of Object.entries(CASES)) {
		const key = crypto.getRandomValues(new Uint8Array(32));

		// --- Case A: JS encrypt -> server decrypt ---
		const ctPath = join(work, "a.fupl");
		writeFileSync(ctPath, await encryptBytes(key, plaintext));
		const aOk = eq(await serverDecrypt(key, ctPath), plaintext);

		// --- Case B: server encrypt -> JS decrypt ---
		const ptPath = join(work, "b.in");
		const serverCt = join(work, "b.fupl");
		writeFileSync(ptPath, plaintext);
		await encryptFile(Buffer.from(key), ptPath, serverCt);
		const bResult = await decryptBytes(
			key,
			new Uint8Array(readFileSync(serverCt)),
		);
		const bOk = eq(bResult, plaintext);

		const ok = aOk && bOk;
		if (!ok) failures++;
		console.log(
			`${ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${name.padEnd(12)} ` +
				`JS→SRV:${aOk ? "ok" : "FAIL"}  SRV→JS:${bOk ? "ok" : "FAIL"}  (${plaintext.length} bytes)`,
		);
	}
} finally {
	rmSync(work, { recursive: true, force: true });
}

if (failures > 0) {
	console.error(
		`\n\x1b[31m${failures} case(s) failed — crypto is NOT interoperable.\x1b[0m`,
	);
	process.exit(1);
}
console.log("\n\x1b[32mAll FUPL interop vectors passed.\x1b[0m");
