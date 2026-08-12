import { describe, expect, it } from "bun:test";
import { formatBackboardMemoryMode } from "../src/config/defaults.ts";
import { memoryChoices } from "../src/ui/components/MemorySelector.tsx";

describe("MemorySelector choices", () => {
	it("offers documented Memory Lite modes", () => {
		expect(memoryChoices().map((choice) => choice.mode)).toEqual([
			"off",
			"auto",
			"readonly",
		]);
	});

	it("formats memory modes for Backboard", () => {
		expect(formatBackboardMemoryMode("off")).toBe("off");
		expect(formatBackboardMemoryMode("auto")).toBe("Auto");
		expect(formatBackboardMemoryMode("on")).toBe("Auto");
		expect(formatBackboardMemoryMode("readonly")).toBe("Readonly");
	});
});
