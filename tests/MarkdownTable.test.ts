import { describe, expect, it } from "bun:test";
import { parseMarkdownBlocks } from "../src/ui/components/MarkdownText.tsx";
import {
	clampFlushLengthForOpenTable,
	findOpenTableStart,
	isTableSeparatorRow,
	isTableStart,
	parseTableAlignment,
	splitTableRow,
} from "../src/utils/markdownTable.ts";

describe("markdownTable utils", () => {
	it("splits pipe rows, honoring escaped pipes and optional outer pipes", () => {
		expect(splitTableRow("| a | b |")).toEqual(["a", "b"]);
		expect(splitTableRow("a | b")).toEqual(["a", "b"]);
		expect(splitTableRow("a \\| b | c")).toEqual(["a | b", "c"]);
		expect(splitTableRow("no pipes here")).toEqual([]);
	});

	it("recognizes delimiter rows and their alignment", () => {
		expect(isTableSeparatorRow("---|---")).toBe(true);
		expect(isTableSeparatorRow(":---|:---:|---:")).toBe(true);
		expect(isTableSeparatorRow("a | b")).toBe(false);

		expect(parseTableAlignment(splitTableRow(":---|:---:|---:"))).toEqual([
			"left",
			"center",
			"right",
		]);
	});

	it("detects a table start only when header and delimiter cell counts match", () => {
		expect(isTableStart("a | b", "---|---")).toBe(true);
		expect(isTableStart("a | b", "---|---|---")).toBe(false);
		expect(isTableStart("a | b", "just text")).toBe(false);
	});

	it("finds the start of a table that hasn't been closed off yet", () => {
		const text = "before\n\nName | Score\n---|---\nAlice | 92\nBob | 88";
		const openStart = findOpenTableStart(text);
		expect(openStart).toBe(text.indexOf("Name"));
	});

	it("does not treat a table followed by a blank line as open", () => {
		const text = "Name | Score\n---|---\nAlice | 92\n\nsome more text";
		expect(findOpenTableStart(text)).toBeNull();
	});

	it("holds back a trailing pipe row that could still become a table header", () => {
		const text = "intro\n| Name | Score |\n";
		expect(findOpenTableStart(text)).toBe(text.indexOf("| Name"));
	});

	it("holds back a header followed by a partial delimiter row", () => {
		const text = "intro\n| Name | Score |\n| --- | -";
		expect(findOpenTableStart(text)).toBe(text.indexOf("| Name"));
	});

	it("releases held-back lines once the next line rules a table out", () => {
		const text = "intro\n| Name | Score |\nnot a delimiter | row\nplain\n";
		expect(findOpenTableStart(text)).toBeNull();
	});

	it("releases a header when the delimiter row has too many cells", () => {
		const text = "| Name | Score |\n| --- | --- | --- |\n";
		expect(findOpenTableStart(text)).toBeNull();
	});

	it("keeps a whole table in one flush when the header streams in first", () => {
		// Simulates streaming: each delta ends at a newline, so the naive
		// flush would cut right after the header before the delimiter row
		// ever arrives.
		const full =
			"Intro:\n\n| Name | Role |\n| --- | --- |\n| Alice | Eng |\n\nafter";
		let pending = "";
		const chunks: string[] = [];
		for (let i = 0; i < full.length; i += 7) {
			pending += full.slice(i, i + 7);
			const newlineIndex = pending.lastIndexOf("\n");
			const raw = newlineIndex >= 0 ? newlineIndex + 1 : 0;
			const clamped = clampFlushLengthForOpenTable(pending, raw, 800);
			if (clamped > 0) {
				chunks.push(pending.slice(0, clamped));
				pending = pending.slice(clamped);
			}
		}
		if (pending) chunks.push(pending);
		const tableChunk = chunks.find((chunk) => chunk.includes("| Name"));
		expect(tableChunk).toContain("| Alice | Eng |");
	});

	it("clamps a flush length so it never lands inside an open table", () => {
		const text = "Name | Score\n---|---\nAlice | 92\n";
		const naiveFlush = text.length; // last "\n" is at the very end
		const clamped = clampFlushLengthForOpenTable(text, naiveFlush, 800);
		expect(clamped).toBe(0);
	});

	it("flushes an open table anyway once it exceeds the safety cap", () => {
		const text = `Name | Score\n---|---\n${"Alice | 92\n".repeat(100)}`;
		const naiveFlush = text.length;
		const clamped = clampFlushLengthForOpenTable(text, naiveFlush, 200);
		expect(clamped).toBe(naiveFlush);
	});

	it("leaves a flush length untouched when there's no open table", () => {
		const text = "just a sentence\n";
		expect(clampFlushLengthForOpenTable(text, text.length, 800)).toBe(
			text.length,
		);
	});
});

describe("MarkdownText table parsing", () => {
	it("parses a GFM table into a table block with aligned columns", () => {
		const blocks = parseMarkdownBlocks(
			"| Name | Score |\n| :--- | ---: |\n| Alice | 92 |\n| Bob | 88 |",
		);

		expect(blocks).toHaveLength(1);
		const table = blocks[0];
		expect(table?.kind).toBe("table");
		if (table?.kind !== "table") throw new Error("Expected table block");
		expect(table.align).toEqual(["left", "right"]);
		expect(
			table.header.map((cell) => cell.map((i) => i.text).join("")),
		).toEqual(["Name", "Score"]);
		expect(table.rows).toHaveLength(2);
		expect(
			table.rows[0]?.cells.map((cell) => cell.map((i) => i.text).join("")),
		).toEqual(["Alice", "92"]);
	});

	it("pads a ragged final row to the header's column count", () => {
		const blocks = parseMarkdownBlocks(
			"| A | B | C |\n| --- | --- | --- |\n| 1 | 2 |",
		);
		const table = blocks[0];
		if (table?.kind !== "table") throw new Error("Expected table block");
		expect(table.rows[0]?.cells).toHaveLength(3);
		expect(table.rows[0]?.cells[2]?.map((i) => i.text).join("")).toBe("");
	});

	it("stops a table at the first non-row line", () => {
		const blocks = parseMarkdownBlocks(
			"| A | B |\n| --- | --- |\n| 1 | 2 |\n\nafter the table",
		);
		expect(blocks.map((block) => block.kind)).toEqual(["table", "paragraph"]);
	});

	it("does not treat a bare paragraph containing '|' as a table", () => {
		const blocks = parseMarkdownBlocks(
			"this has a | pipe but no delimiter row",
		);
		expect(blocks[0]?.kind).toBe("paragraph");
	});

	it("stops paragraph accumulation right before a following table", () => {
		const blocks = parseMarkdownBlocks(
			"intro text\n| A | B |\n| --- | --- |\n| 1 | 2 |",
		);
		expect(blocks.map((block) => block.kind)).toEqual(["paragraph", "table"]);
	});
});
