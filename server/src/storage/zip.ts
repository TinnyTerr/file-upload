import { randomBytes } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decryptStream, decryptStreamFrom } from "../crypto/aead.ts";
import { resolveFileEncryption } from "../crypto/effectiveEncryption.ts";
import { openBox } from "../crypto/secretbox.ts";
import type { FileRow } from "../db/rows.ts";
import type { Db } from "../db/types.ts";
import { HttpError } from "../httpError.ts";
import { decompressGuarded, decompressStream } from "./compress.ts";
import { safeJoin, storageRoot } from "./paths.ts";

/** Mirrors app/routes/directories.py::_safe_arcname -- flatten to a safe
 * in-zip name and de-duplicate collisions against everything already emitted. */
export function safeArcname(name: string, seen: Set<string>): string {
	let base = name.replace(/\\/g, "/").split("/").pop() ?? "";
	base = base
		.split("")
		.filter((c) => c.codePointAt(0)! >= 0x20)
		.join("")
		.trim();
	// Separators are already stripped, so a bare "." / ".." can't traverse --
	// but a member literally named ".." still trips naive extractors.
	if (!base || base === "." || base === "..") base = "file";
	const dotIdx = base.indexOf(".");
	let stem = dotIdx === -1 ? base : base.slice(0, dotIdx);
	let dot = dotIdx === -1 ? "" : ".";
	let ext = dotIdx === -1 ? "" : base.slice(dotIdx + 1);
	if (!stem) {
		stem = base;
		dot = "";
		ext = "";
	}
	let candidate = base;
	let counter = 1;
	while (seen.has(candidate)) {
		candidate = dot ? `${stem} (${counter}).${ext}` : `${stem} (${counter})`;
		counter += 1;
	}
	seen.add(candidate);
	return candidate;
}

/** One folder component of an in-zip path. Same character rules as
 * `safeArcname`, but for a directory name rather than a leaf -- a shared folder
 * can nest now, and its structure has to survive into the archive without a
 * title being able to smuggle a separator or a traversal segment in. */
export function safeArcsegment(name: string): string {
	const cleaned = name
		.replace(/[\\/]/g, "_")
		.split("")
		.filter((c) => c.codePointAt(0)! >= 0x20)
		.join("")
		.trim();
	if (!cleaned || cleaned === "." || cleaned === "..") return "folder";
	return cleaned;
}

function newTempfile(suffix: string): string {
	return join(tmpdir(), `fu-${randomBytes(16).toString("hex")}${suffix}`);
}

/** Streams an async chunk generator into a file, honoring backpressure.
 * Exported for reuse by routes/public.ts's raw-download decompress/decrypt
 * helpers, which used to buffer the whole file in memory before this. */
export async function writeStreamToFile(
	stream: AsyncIterable<Buffer>,
	dest: string,
): Promise<void> {
	const out = createWriteStream(dest);
	try {
		for await (const chunk of stream) {
			if (!out.write(chunk))
				await new Promise<void>((resolve) => out.once("drain", resolve));
		}
		await new Promise<void>((resolve, reject) => {
			out.end((err: unknown) => (err ? reject(err) : resolve()));
		});
	} catch (err) {
		out.destroy();
		throw err;
	}
}

/** Mirrors app/routes/directories.py::_member_source. Resolves a file row to a
 * path holding its plaintext bytes. Returns [path, isTemp] -- caller must
 * unlink when isTemp is true.
 *
 * Two different producers wrap a file's bytes in opposite transform orders:
 *  - finalizeStoredFile (upload-time, routes/files.ts) compresses THEN
 *    encrypts -> ENC(ZSTD(x)), and sets `compressed = 1`.
 *  - the archive job (jobs/lifecycle.ts) only ever recompresses a file that
 *    was NOT already compressed at upload time -- it wraps an already
 *    *encrypted* file -> ZSTD(ENC(x)), leaving `compressed = 0` (see
 *    archiveFileCore's early-out when `f.compressed` is already true).
 * So `archived && !compressed` is the only layout stored as ZSTD(ENC(x))
 * (decompress-then-decrypt); every other compressed+encrypted combination is
 * ENC(ZSTD(x)) (decrypt-then-decompress). Mirrors routes/public.ts's raw
 * handler (`f.archived && !f.compressed` branch). */
export async function memberSource(
	db: Db,
	masterKey: Buffer,
	f: FileRow,
): Promise<[path: string, isTemp: boolean]> {
	const full = safeJoin(storageRoot(), f.storage_path);
	if (!existsSync(full)) throw new HttpError(500, "file missing from storage");

	// An inheriting file's key lives on an ancestor folder, not on its own row.
	const eff = resolveFileEncryption(db, f);
	const needsDecompress = !!(f.compressed || f.archived);
	const needsDecrypt = eff.mode === "server";
	if (!needsDecompress && !needsDecrypt) return [full, false];

	let key: Buffer | null = null;
	if (needsDecrypt) {
		if (!eff.keyBlob) throw new HttpError(500, "encryption key not stored");
		key = openBox(masterKey, Buffer.from(eff.keyBlob));
	}

	// zip streaming needs a real file to seek in, so one temp copy is
	// unavoidable -- but only one. Both transforms used to be materialized
	// separately, so a compressed *and* encrypted member cost two full-size
	// temp files and two extra passes; composed, the intermediate never exists.
	// The order rule is the same one storage/streaming.ts documents: the
	// archive job produces ZSTD(ENC(x)), everything else ENC(ZSTD(x)).
	let source: AsyncIterable<Buffer>;
	if (f.archived && !f.compressed) {
		source = decompressStream(full, f.size_bytes);
		if (key) source = decryptStreamFrom(key, source);
	} else {
		source = key ? decryptStream(key, full) : createReadStream(full);
		if (needsDecompress) source = decompressGuarded(source, f.size_bytes);
	}

	const plain = newTempfile(".plain");
	try {
		await writeStreamToFile(source, plain);
	} catch (err) {
		await unlink(plain).catch(() => {});
		throw err;
	}
	return [plain, true];
}
