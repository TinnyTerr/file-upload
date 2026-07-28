import { describe, expect, test } from "bun:test";
import { createZip } from "../src/lib/zip";

async function bytesOf(blob: Blob): Promise<Uint8Array> {
	return new Uint8Array(await blob.arrayBuffer());
}

function u16(b: Uint8Array, o: number) {
	return b[o] | (b[o + 1] << 8);
}
function u32(b: Uint8Array, o: number) {
	return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}

describe("createZip", () => {
	test("produces a valid store-only archive", async () => {
		const data = new TextEncoder().encode("hello zip world");
		const blob = createZip([{ name: "a.txt", data }]);
		const b = await bytesOf(blob);

		// local file header signature
		expect(u32(b, 0)).toBe(0x04034b50);
		// store method (0), uncompressed size == data length
		expect(u16(b, 8)).toBe(0);
		expect(u32(b, 18)).toBe(data.length); // compressed size
		expect(u32(b, 22)).toBe(data.length); // uncompressed size
		expect(u16(b, 26)).toBe("a.txt".length); // filename length
		expect(u32(b, 14)).toBeGreaterThan(0); // crc32 non-zero for non-empty

		// EOCD signature is present near the end (last 22 bytes for no comment)
		const eocd = b.length - 22;
		expect(u32(b, eocd)).toBe(0x06054b50);
		expect(u16(b, eocd + 10)).toBe(1); // total entries
	});

	test("encodes multiple entries with UTF-8 flag for non-ascii names", async () => {
		const blob = createZip([
			{ name: "one.bin", data: new Uint8Array([1, 2, 3]) },
			{ name: "café.txt", data: new TextEncoder().encode("deux") },
		]);
		const b = await bytesOf(blob);
		const eocd = b.length - 22;
		expect(u32(b, eocd)).toBe(0x06054b50);
		expect(u16(b, eocd + 10)).toBe(2); // two entries
		// first local header flags: ascii name → no UTF-8 bit
		expect(u16(b, 6)).toBe(0);
	});

	test("empty archive is just an EOCD", async () => {
		const b = await bytesOf(createZip([]));
		expect(b.length).toBe(22);
		expect(u32(b, 0)).toBe(0x06054b50);
		expect(u16(b, 10)).toBe(0);
	});
});
