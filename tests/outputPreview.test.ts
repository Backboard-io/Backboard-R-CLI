import { describe, expect, it } from "bun:test";
import { buildOutputPreview } from "../src/core/tools/outputPreview.ts";

describe("buildOutputPreview", () => {
	it("returns undefined for empty or whitespace-only input", () => {
		expect(buildOutputPreview(undefined)).toBeUndefined();
		expect(buildOutputPreview("")).toBeUndefined();
		expect(buildOutputPreview("   \n  \n")).toBeUndefined();
	});

	it("returns short input unchanged", () => {
		expect(buildOutputPreview("a\nb\nc")).toBe("a\nb\nc");
	});

	it("collapses extra lines behind a pluralized footer", () => {
		const text = Array.from({ length: 5 }, (_, i) => `line ${i + 1}`).join(
			"\n",
		);
		expect(buildOutputPreview(text, { maxLines: 3 })).toBe(
			"line 1\nline 2\nline 3\n… +2 more lines",
		);
	});

	it("uses the singular footer when exactly one line is hidden", () => {
		const text = "one\ntwo\nthree";
		expect(buildOutputPreview(text, { maxLines: 2 })).toBe(
			"one\ntwo\n… +1 more line",
		);
	});

	it("truncates each line to maxLineWidth", () => {
		expect(buildOutputPreview("abcdef", { maxLineWidth: 4 })).toBe("abc…");
	});
});
