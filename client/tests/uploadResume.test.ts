import { describe, expect, test } from "bun:test";
import {
	forgetSession,
	isResumable,
	loadSession,
	resumeKey,
	saveSession,
} from "../src/features/files/lib/uploadResume";

function memStore() {
	const m = new Map<string, string>();
	return {
		getItem: (k: string) => m.get(k) ?? null,
		setItem: (k: string, v: string) => void m.set(k, v),
	};
}

const file = { name: "a.bin", size: 100, lastModified: 5 };
const opts = { encryption_mode: "none" as const, directory_id: 3 };

describe("upload resume store", () => {
	test("round-trips and forgets", () => {
		const s = memStore();
		const k = resumeKey(file, 100, opts);
		expect(loadSession(k, s)).toBeNull();
		saveSession(k, "tok", s);
		expect(loadSession(k, s)).toBe("tok");
		forgetSession(k, s);
		expect(loadSession(k, s)).toBeNull();
	});

	test("a different destination or encryption is a different session", () => {
		const a = resumeKey(file, 100, opts);
		expect(resumeKey(file, 100, { ...opts, directory_id: 4 })).not.toBe(a);
		expect(
			resumeKey(file, 100, { ...opts, encryption_mode: "server" }),
		).not.toBe(a);
		expect(resumeKey({ ...file, lastModified: 6 }, 100, opts)).not.toBe(a);
	});

	test("sessions past the server's TTL are dropped", () => {
		const s = memStore();
		const k = resumeKey(file, 100, opts);
		saveSession(k, "tok", s, 1_000);
		expect(loadSession(k, s, 1_000 + 13 * 3600 * 1000)).toBeNull();
	});

	test("corrupt storage reads as empty rather than throwing", () => {
		const s = memStore();
		s.setItem("fu_upload_sessions", "{not json");
		expect(loadSession("x", s)).toBeNull();
	});

	test("client-encrypted uploads are never resumable", () => {
		expect(isResumable({ encryption_mode: "client" })).toBe(false);
		expect(isResumable({ encryption_mode: "server" })).toBe(true);
	});
});
