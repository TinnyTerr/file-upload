/**
 * FUPL v1 interop verification: proves the browser worker's crypto core is
 * byte-compatible with the server (app/crypto/aead.py).
 *
 *   1. JS encrypts  -> Python decrypts -> must equal original plaintext
 *   2. Python encrypts -> JS decrypts  -> must equal original plaintext
 *
 * Run from client/: `node scripts/fupl-vectors.mjs`
 * Requires Node >= 20 (global WebCrypto) and Python with `cryptography`.
 *
 * The JS side imports the SAME primitives the worker uses, transpiled on the
 * fly via a tiny esbuild-free shim: we import the .ts core through Node's
 * built-in TS stripping (Node >= 22.6 with --experimental-strip-types) OR fall
 * back to a local re-implementation guard. To keep this dependency-free we
 * re-derive bytes through a child Python process for the server side.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");

// Load the worker's crypto core (TS) via Node native type stripping.
const core = await import("../src/workers/fuplCore.ts");
const { encryptBytes, decryptBytes } = core;

const PY_DECRYPT = `
import sys, pathlib
sys.path.insert(0, sys.argv[1])
from app.crypto.aead import decrypt_stream
key = pathlib.Path(sys.argv[2]).read_bytes()
src = pathlib.Path(sys.argv[3])
out = pathlib.Path(sys.argv[4])
import app.crypto.aead as a
# write key to a temp and decrypt
data = b"".join(decrypt_stream(key, src))
out.write_bytes(data)
`;

const PY_ENCRYPT = `
import sys, pathlib
sys.path.insert(0, sys.argv[1])
from app.crypto.aead import encrypt_file
key = pathlib.Path(sys.argv[2]).read_bytes()
src = pathlib.Path(sys.argv[3])
out = pathlib.Path(sys.argv[4])
encrypt_file(key, src, out)
`;

function python(code, args, work) {
	const scriptPath = join(work, "snippet.py");
	writeFileSync(scriptPath, code);
	const py = process.platform === "win32" ? "python" : "python3";
	const res = spawnSync(py, [scriptPath, ...args], { encoding: "utf8" });
	if (res.status !== 0) {
		throw new Error(`python failed: ${res.stderr || res.stdout}`);
	}
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
		const keyPath = join(work, "key.bin");
		writeFileSync(keyPath, key);

		// --- Case A: JS encrypt -> Python decrypt ---
		const jsCipher = await encryptBytes(key, plaintext);
		const ctPath = join(work, "a.fupl");
		const ptOut = join(work, "a.out");
		writeFileSync(ctPath, jsCipher);
		python(PY_DECRYPT, [REPO_ROOT, keyPath, ctPath, ptOut], work);
		const aResult = new Uint8Array(readFileSync(ptOut));
		const aOk = eq(aResult, plaintext);

		// --- Case B: Python encrypt -> JS decrypt ---
		const ptPath = join(work, "b.in");
		const pyCt = join(work, "b.fupl");
		writeFileSync(ptPath, plaintext);
		python(PY_ENCRYPT, [REPO_ROOT, keyPath, ptPath, pyCt], work);
		const bResult = await decryptBytes(key, new Uint8Array(readFileSync(pyCt)));
		const bOk = eq(bResult, plaintext);

		const ok = aOk && bOk;
		if (!ok) failures++;
		console.log(
			`${ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${name.padEnd(12)} ` +
				`JS→PY:${aOk ? "ok" : "FAIL"}  PY→JS:${bOk ? "ok" : "FAIL"}  (${plaintext.length} bytes)`,
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
