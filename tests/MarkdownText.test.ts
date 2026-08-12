import { describe, expect, it } from "bun:test";
import {
	parseMarkdownBlocks,
	parseMarkdownInlines,
} from "../src/ui/components/MarkdownText.tsx";

describe("MarkdownText parsing", () => {
	it("parses headings, paragraphs, and inline formatting", () => {
		const blocks = parseMarkdownBlocks(
			"# Title\n\nUse **bold**, *emphasis*, `code`, and [docs](https://example.com).",
		);

		expect(blocks[0]).toMatchObject({
			kind: "heading",
			level: 1,
		});
		expect(blocks[1]).toMatchObject({
			kind: "paragraph",
		});
		if (blocks[1]?.kind !== "paragraph") throw new Error("Expected paragraph");
		expect(blocks[1].inlines.map((inline) => inline.kind)).toContain("strong");
		expect(blocks[1].inlines.map((inline) => inline.kind)).toContain(
			"emphasis",
		);
		expect(blocks[1].inlines.map((inline) => inline.kind)).toContain("code");
		expect(blocks[1].inlines.map((inline) => inline.kind)).toContain("link");
	});

	it("parses lists and code fences", () => {
		const blocks = parseMarkdownBlocks(
			"- one\n- two\n\n```ts\nconst value = 1;\n```",
		);

		expect(blocks[0]?.kind).toBe("unorderedList");
		if (blocks[0]?.kind !== "unorderedList") throw new Error("Expected list");
		expect(blocks[0].items).toHaveLength(2);
		expect(blocks[1]).toMatchObject({
			kind: "code",
			language: "ts",
		});
	});

	it("parses inline tokens without dropping surrounding text", () => {
		const inlines = parseMarkdownInlines("a **b** c `d`");

		expect(inlines.map((inline) => inline.text).join("")).toBe("a b c d");
		expect(inlines.map((inline) => inline.kind)).toEqual([
			"text",
			"strong",
			"text",
			"code",
		]);
	});
});
