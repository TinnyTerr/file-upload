import { beforeAll, describe, expect, test } from "bun:test";

beforeAll(() => {
	// shareUrl helpers read window.location.origin.
	(
		globalThis as unknown as { window: { location: { origin: string } } }
	).window = {
		location: { origin: "https://host.test" },
	};
});

const mod = await import("../src/features/files/lib/shareUrl");

describe("shareUrl", () => {
	test("none mode → bare base", () => {
		expect(mod.shareUrl("https://host.test/file/abc", "none", {})).toBe(
			"https://host.test/file/abc",
		);
	});
	test("server mode appends ?ek=", () => {
		expect(
			mod.shareUrl("https://host.test/file/abc", "server", { accessKey: "k1" }),
		).toBe("https://host.test/file/abc?ek=k1");
	});
	test("client mode appends #ek= fragment", () => {
		expect(
			mod.shareUrl("https://host.test/file/abc", "client", {
				clientKeyB64: "zzz",
			}),
		).toBe("https://host.test/file/abc#ek=zzz");
	});
	test("missing key falls back to base", () => {
		expect(mod.shareUrl("https://host.test/file/abc", "server", {})).toBe(
			"https://host.test/file/abc",
		);
		expect(mod.shareUrl("https://host.test/file/abc", "client", {})).toBe(
			"https://host.test/file/abc",
		);
	});
	test("server keys are URL-encoded", () => {
		expect(
			mod.shareUrl("https://host.test/file/abc", "server", {
				accessKey: "a b&c",
			}),
		).toContain("?ek=a%20b%26c");
	});
});

describe("url builders", () => {
	test("file/folder URLs use the origin", () => {
		expect(mod.fileUrl("slug1")).toBe("https://host.test/file/slug1");
		// rawUrl is the backend download endpoint, so it lives under /api.
		expect(mod.rawUrl("slug1")).toBe("https://host.test/api/file/slug1/raw");
		expect(mod.folderUrl("d1")).toBe("https://host.test/d/d1");
	});
});
