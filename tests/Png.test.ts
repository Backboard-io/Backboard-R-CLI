import { describe, expect, it } from "bun:test";
import { pngSize, resizeWithCandidates } from "../src/core/platform/png.ts";
import type { ScreenSize } from "../src/core/platform/types.ts";

function makePng(width: number, height = 10, pad = 0): Buffer {
	const buf = Buffer.alloc(24 + pad);
	buf.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
	buf.writeUInt32BE(13, 8);
	buf.write("IHDR", 12);
	buf.writeUInt32BE(width, 16);
	buf.writeUInt32BE(height, 20);
	return buf;
}

describe("pngSize", () => {
	it("reads width and height from a valid PNG header", () => {
		const size = pngSize(makePng(256, 128), "img");
		expect(size).toEqual({ width: 256, height: 128 });
	});

	it("throws on a buffer shorter than 24 bytes", () => {
		expect(() => pngSize(Buffer.alloc(20), "img")).toThrow("not a valid PNG");
	});

	it("throws when the magic bytes are not PNG", () => {
		const buf = makePng(10, 10);
		buf.write("GIF8", 0);
		expect(() => pngSize(buf, "img")).toThrow("not a valid PNG");
	});

	it("throws when the chunk type is not IHDR", () => {
		const buf = makePng(10, 10);
		buf.write("IEND", 12);
		expect(() => pngSize(buf, "img")).toThrow("not a valid PNG");
	});
});

describe("resizeWithCandidates", () => {
	const screenSize: ScreenSize = { width: 2000, height: 1000 };

	it("returns the first candidate width that fits within maxBytes", async () => {
		const widths: number[] = [];
		const result = await resizeWithCandidates(
			{
				path: "/tmp/in.png",
				screenSize,
				maxBytes: 50,
				signal: new AbortController().signal,
			},
			async (width, out) => {
				widths.push(width);
				// Each candidate is 5 bytes of extra padding + 24-byte header,
				// so byteLength is identical; the first tried width wins.
				const { writeFile } = await import("node:fs/promises");
				await writeFile(out, makePng(width, 10, 5));
			},
		);
		expect(result).not.toBeNull();
		expect(widths[0]).toBe(1280);
		expect(result?.scale).toBeCloseTo(1280 / 2000);
		expect(result?.compressed).toBe(true);
	});

	it("returns null when every candidate exceeds maxBytes", async () => {
		const result = await resizeWithCandidates(
			{
				path: "/tmp/in.png",
				screenSize,
				maxBytes: 1,
				signal: new AbortController().signal,
			},
			async (_width, out) => {
				const { writeFile } = await import("node:fs/promises");
				await writeFile(out, makePng(_width, 10, 100));
			},
		);
		expect(result).toBeNull();
	});

	it("skips candidate widths that are not smaller than the source", async () => {
		const widths: number[] = [];
		// At 300px wide, none of [1280,960,720,540,360] are smaller, so nothing runs.
		const result = await resizeWithCandidates(
			{
				path: "/tmp/in.png",
				screenSize: { width: 300, height: 300 },
				maxBytes: 10_000,
				signal: new AbortController().signal,
			},
			async (width, out) => {
				widths.push(width);
				const { writeFile } = await import("node:fs/promises");
				await writeFile(out, makePng(width, 10, 10));
			},
		);
		expect(result).toBeNull();
		expect(widths).toEqual([]);
	});

	it("returns the first candidate that fits, with its computed scale", async () => {
		const result = await resizeWithCandidates(
			{
				path: "/tmp/in.png",
				screenSize,
				maxBytes: 1_000,
				signal: new AbortController().signal,
			},
			async (width, out) => {
				const { writeFile } = await import("node:fs/promises");
				await writeFile(out, makePng(width, 10, 1));
			},
		);
		// The first tried width (1280) already fits, so it is returned.
		expect(result?.imageSize.width).toBe(1280);
		expect(result?.scale).toBeCloseTo(1280 / 2000);
		expect(result?.compressed).toBe(true);
	});
});
