import { describe, expect, it } from "bun:test";
import { expandTabs } from "../src/utils/string.ts";

describe("expandTabs", () => {
	it("expands tabs to the next tab stop", () => {
		expect(expandTabs("\tx")).toBe("    x");
		expect(expandTabs("ab\tx")).toBe("ab  x");
		expect(expandTabs("\t\tif (a) {")).toBe("        if (a) {");
	});

	it("returns tab-free strings unchanged", () => {
		const value = "const a = 1;";
		expect(expandTabs(value)).toBe(value);
	});

	it("honors a custom tab width", () => {
		expect(expandTabs("\tx", 8)).toBe("        x");
	});
});
