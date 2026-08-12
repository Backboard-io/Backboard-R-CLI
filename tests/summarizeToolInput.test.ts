import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { summarizeToolInput } from "../src/core/tools/ToolEventFactory.ts";
import { ExecuteTool } from "../src/tools/ExecuteTool.tsx";
import { GlobTool } from "../src/tools/GlobTool.tsx";
import { GrepTool } from "../src/tools/GrepTool.tsx";
import { ReadTool } from "../src/tools/ReadTool.tsx";

describe("summarizeToolInput", () => {
	it("returns empty string for missing or unknown shapes", () => {
		expect(summarizeToolInput(undefined)).toBe("");
		expect(summarizeToolInput({})).toBe("");
		expect(summarizeToolInput({ value: "v" })).toBe("");
		// A tool with no override / no matching field falls back to empty.
		expect(summarizeToolInput({ value: "v" }, new ReadTool())).toBe("");
	});

	it("joins Glob patterns and appends scope metadata via the tool hook", () => {
		expect(
			summarizeToolInput(
				{
					patterns: ["src/**/*.ts", "src/**/*.tsx"],
					excludePatterns: ["**/node_modules/**"],
				},
				new GlobTool(),
			),
		).toBe("src/**/*.ts, src/**/*.tsx (excl **/node_modules/**)");
	});

	it("renders Grep pattern with its filters in one group via the tool hook", () => {
		expect(
			summarizeToolInput(
				{ pattern: "needle", glob: "*.ts", type: "ts" },
				new GrepTool(),
			),
		).toBe("needle (in *.ts, ts)");
	});

	it("relativizes a Read path and shows the line range via the tool hook", () => {
		const filePath = join(process.cwd(), "src/state/Store.ts");
		expect(
			summarizeToolInput(
				{ file_path: filePath, offset: 0, limit: 220 },
				new ReadTool(),
			),
		).toBe("src/state/Store.ts (lines 1–220)");
	});

	it("shows only the first line of a multi-line command via the tool hook", () => {
		expect(
			summarizeToolInput(
				{ command: "bun test\ngrep foo bar" },
				new ExecuteTool(),
			),
		).toBe("bun test …");
	});

	it("collapses interior whitespace in free-form prompts (generic fallback)", () => {
		expect(summarizeToolInput({ prompt: "Do X.\n\nContext: Y" })).toBe(
			"Do X. Context: Y",
		);
	});

	it("relativizes a file path via the generic fallback for tools without an override", () => {
		// e.g. Write/Edit/ApplyPatch: no summarizeInput override, but their shared
		// file_path field must still surface (no line range - that's Read-only).
		const filePath = join(process.cwd(), "src/state/Store.ts");
		expect(summarizeToolInput({ file_path: filePath })).toBe(
			"src/state/Store.ts",
		);
	});

	it("clamps very long summaries", () => {
		const long = "x".repeat(300);
		const summary = summarizeToolInput({ query: long });
		expect(summary.length).toBeLessThanOrEqual(140);
		expect(summary.endsWith("…")).toBe(true);
	});
});
