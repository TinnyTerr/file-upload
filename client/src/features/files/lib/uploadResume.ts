import type { UploadOptions } from "../types";

/**
 * Remembers chunked-upload sessions across a reload so the same file, picked
 * again, continues from the chunks the server already holds instead of
 * starting over.
 *
 * A `File` can't outlive the page, so "resume" means: the user re-selects the
 * file, and we recognise it by name + size + mtime + the options that are baked
 * into the server's session token. The token itself is the only thing stored;
 * the server stays the authority on which chunks arrived (`/upload/status`)
 * and on whether the session still exists.
 *
 * Client-encrypted uploads are never resumable: each attempt draws a fresh key
 * and nonce, so a second encryption of the same file is different bytes and
 * splicing it onto the first attempt's chunks would corrupt the file.
 */

const STORAGE_KEY = "fu_upload_sessions";
/** Matches the server's CHUNK_SESSION_TTL (12 h); a token older than this is dead. */
const MAX_AGE_MS = 12 * 3600 * 1000;
const MAX_ENTRIES = 50;

interface Entry {
	uploadId: string;
	savedAt: number;
}

type Store = Pick<Storage, "getItem" | "setItem">;

function defaultStore(): Store | null {
	try {
		return typeof localStorage === "undefined" ? null : localStorage;
	} catch {
		return null; // storage blocked (private mode, policy)
	}
}

export function isResumable(options: UploadOptions): boolean {
	return options.encryption_mode !== "client";
}

/** Everything the server pins into the session token at init, plus the file's identity. */
export function resumeKey(
	file: Pick<File, "name" | "size" | "lastModified">,
	payloadSize: number,
	o: UploadOptions,
): string {
	return JSON.stringify([
		file.name,
		file.size,
		file.lastModified,
		payloadSize,
		o.encryption_mode,
		o.directory_id ?? null,
		!!o.compress,
		!!o.randomize_filename,
	]);
}

function read(store: Store, now: number): Record<string, Entry> {
	try {
		const parsed = JSON.parse(store.getItem(STORAGE_KEY) ?? "{}");
		const live: Record<string, Entry> = {};
		for (const [k, v] of Object.entries(parsed as Record<string, Entry>)) {
			if (
				v &&
				typeof v.uploadId === "string" &&
				typeof v.savedAt === "number" &&
				now - v.savedAt < MAX_AGE_MS
			) {
				live[k] = v;
			}
		}
		return live;
	} catch {
		return {};
	}
}

function write(store: Store, entries: Record<string, Entry>): void {
	const keep = Object.entries(entries)
		.sort((a, b) => b[1].savedAt - a[1].savedAt)
		.slice(0, MAX_ENTRIES);
	try {
		store.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(keep)));
	} catch {
		/* quota / blocked: resuming is a nicety, never an error */
	}
}

export function loadSession(
	key: string,
	store: Store | null = defaultStore(),
	now = Date.now(),
): string | null {
	if (!store) return null;
	return read(store, now)[key]?.uploadId ?? null;
}

export function saveSession(
	key: string,
	uploadId: string,
	store: Store | null = defaultStore(),
	now = Date.now(),
): void {
	if (!store) return;
	const entries = read(store, now);
	entries[key] = { uploadId, savedAt: now };
	write(store, entries);
}

export function forgetSession(
	key: string,
	store: Store | null = defaultStore(),
	now = Date.now(),
): void {
	if (!store) return;
	const entries = read(store, now);
	if (!(key in entries)) return;
	delete entries[key];
	write(store, entries);
}
