/**
 * The remote-upload chunked decoder is fed socket reads of arbitrary size, so
 * every framing element -- size line, payload, CRLF, terminator, trailers --
 * has to survive being split at any byte.
 */
import { describe, expect, test } from "bun:test";
import { ChunkedDecoder } from "../src/routes/remoteUpload.ts";

function encode(pieces: string[], trailers = ""): Buffer {
	const body = pieces
		.map((p) => `${p.length.toString(16)};ext=1\r\n${p}\r\n`)
		.join("");
	return Buffer.from(`${body}0\r\n${trailers}\r\n`, "latin1");
}

function decodeSplit(
	raw: Buffer,
	step: number,
): { out: string; done: boolean } {
	const dec = new ChunkedDecoder();
	const parts: Buffer[] = [];
	for (let i = 0; i < raw.length; i += step) {
		parts.push(...dec.push(raw.subarray(i, Math.min(raw.length, i + step))));
	}
	return { out: Buffer.concat(parts).toString("latin1"), done: dec.done };
}

describe("ChunkedDecoder", () => {
	const raw = encode(["hello ", "world", "!".repeat(300)], "X-Trailer: 1\r\n");
	const expected = `hello world${"!".repeat(300)}`;

	test("decodes whole and byte-at-a-time identically", () => {
		for (const step of [raw.length, 1, 2, 7, 64]) {
			const { out, done } = decodeSplit(raw, step);
			expect(out).toBe(expected);
			expect(done).toBe(true);
		}
	});

	test("is not done until the terminator arrives", () => {
		const dec = new ChunkedDecoder();
		dec.push(raw.subarray(0, raw.length - 5));
		expect(dec.done).toBe(false);
	});

	test("rejects a non-hex size line", () => {
		const dec = new ChunkedDecoder();
		expect(() => dec.push(Buffer.from("zz\r\nabc\r\n"))).toThrow();
	});

	test("rejects a chunk not followed by CRLF", () => {
		const dec = new ChunkedDecoder();
		expect(() => dec.push(Buffer.from("3\r\nabcXX"))).toThrow();
	});
});
