import { describe, expect, it } from "bun:test";
import {
	activeSegment,
	completeSegment,
	filterSuggestions,
} from "../src/ui/components/matcherSuggestions.ts";

const TOOLS = ["Bash", "Edit", "Read", "Write", "WebFetch"];

describe("activeSegment", () => {
	it("returns the whole value when there is no pipe", () => {
		expect(activeSegment("Bash")).toBe("Bash");
	});
	it("returns the text after the last pipe", () => {
		expect(activeSegment("Edit|Wr")).toBe("Wr");
	});
	it("returns empty for a trailing pipe", () => {
		expect(activeSegment("Edit|")).toBe("");
	});
	it("trims surrounding whitespace", () => {
		expect(activeSegment("Edit| Wr ")).toBe("Wr");
	});
	it("returns empty for an empty value", () => {
		expect(activeSegment("")).toBe("");
	});
});

describe("filterSuggestions", () => {
	it("returns the all-tools option plus every tool when value is empty", () => {
		expect(filterSuggestions("", TOOLS)).toEqual([
			"*",
			"Bash",
			"Edit",
			"Read",
			"Write",
			"WebFetch",
		]);
	});
	it("filters by case-insensitive substring of the active segment", () => {
		expect(filterSuggestions("wr", TOOLS)).toEqual(["Write"]);
	});
	it("matches a substring anywhere in the name", () => {
		expect(filterSuggestions("web", TOOLS)).toEqual(["WebFetch"]);
	});
	it("shows all tools after a trailing pipe without the all-tools option", () => {
		expect(filterSuggestions("Edit|", TOOLS)).toEqual([
			"Bash",
			"Edit",
			"Read",
			"Write",
			"WebFetch",
		]);
	});
	it("filters only the active segment after a pipe", () => {
		expect(filterSuggestions("Edit|Wr", TOOLS)).toEqual(["Write"]);
	});
	it("returns an empty list when nothing matches", () => {
		expect(filterSuggestions("zzz", TOOLS)).toEqual([]);
	});
});

describe("completeSegment", () => {
	it("replaces the whole value when there is no pipe", () => {
		expect(completeSegment("Ba", "Bash")).toBe("Bash");
	});
	it("returns the suggestion for an empty value", () => {
		expect(completeSegment("", "Bash")).toBe("Bash");
	});
	it("preserves the prefix up to and including the last pipe", () => {
		expect(completeSegment("Edit|Wr", "Write")).toBe("Edit|Write");
	});
	it("appends after a trailing pipe", () => {
		expect(completeSegment("Edit|", "Write")).toBe("Edit|Write");
	});
});
