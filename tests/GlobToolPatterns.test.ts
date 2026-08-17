import { describe, expect, it } from "bun:test";
import { GlobTool } from "../src/tools/GlobTool.tsx";

describe("GlobTool.normalizePatterns (via parseInput)", () => {
	const tool = new GlobTool();

	it("coerces a bare non-JSON string pattern to a single-element array", () => {
		const input = tool.parseInput({ patterns: "*.ts" }) as {
			patterns?: string[];
			pattern?: string;
		};
		expect(input.patterns).toEqual(["*.ts"]);
	});

	it("parses a JSON-encoded array string into an array", () => {
		const input = tool.parseInput({ patterns: '["a.ts", "b.ts"]' }) as {
			patterns?: string[];
		};
		expect(input.patterns).toEqual(["a.ts", "b.ts"]);
	});

	it("falls back to a single-element array on malformed JSON", () => {
		const input = tool.parseInput({ patterns: "[not-json" }) as {
			patterns?: unknown;
		};
		expect(input.patterns).toEqual(["[not-json"]);
	});

	it("leaves an already-array pattern untouched", () => {
		const input = tool.parseInput({ patterns: ["a.ts", "b.ts"] }) as {
			patterns?: string[];
		};
		expect(input.patterns).toEqual(["a.ts", "b.ts"]);
	});

	it("keeps the legacy pattern alias separate from patterns", () => {
		const input = tool.parseInput({ pattern: "legacy.ts" }) as {
			pattern?: string;
			patterns?: string[];
		};
		expect(input.pattern).toBe("legacy.ts");
		expect(input.patterns).toBeUndefined();
	});
});
