import { describe, expect, it } from "bun:test";
import {
	askUserOptionWindowStart,
	nextUnanswered,
	resolveAnswer,
	sanitizeQuestion,
} from "../src/ui/components/AskUserPrompt.tsx";

describe("AskUserPrompt", () => {
	it("keeps short option lists unscrolled", () => {
		expect(askUserOptionWindowStart(4, 5)).toBe(0);
	});

	it("scrolls long option lists to keep the selected option visible", () => {
		expect(askUserOptionWindowStart(0, 12)).toBe(0);
		expect(askUserOptionWindowStart(8, 12)).toBe(1);
		expect(askUserOptionWindowStart(11, 12)).toBe(4);
	});

	it("falls back to the highlighted option when no answer is typed", () => {
		expect(resolveAnswer("", ["Alpha", "Beta"], 1)).toBe("Beta");
	});

	it("prefers a trimmed typed answer over the highlighted option", () => {
		expect(resolveAnswer("  Custom  ", ["Alpha", "Beta"], 0)).toBe("Custom");
	});

	it("returns empty when there is neither a draft nor an option", () => {
		expect(resolveAnswer("   ", [], 0)).toBe("");
	});

	it("advances to the next unanswered question, wrapping around", () => {
		expect(nextUnanswered([false, false, false], 0)).toBe(1);
		expect(nextUnanswered([true, false, true], 0)).toBe(1);
		// From the last question, wraps back to an earlier unanswered one.
		expect(nextUnanswered([false, true, true], 2)).toBe(0);
	});

	it("signals completion only once every question is answered", () => {
		expect(nextUnanswered([true, true, true], 1)).toBe(-1);
	});

	it("defangs control sequences in question, options, and header", () => {
		const ESC = String.fromCharCode(0x1b);
		const BEL = String.fromCharCode(0x07);
		const sanitized = sanitizeQuestion({
			question: `Proceed?${ESC}[30;40m rm -rf /${ESC}[0m`,
			options: [`Yes${ESC}]52;c;Y3VybCBldmlsLnNoIHwgc2g=${BEL}`, "No"],
			header: `Step${ESC}[2J`,
		});

		expect(sanitized.question).toBe("Proceed? rm -rf /");
		expect(sanitized.options).toEqual(["Yes", "No"]);
		expect(sanitized.header).toBe("Step");
	});
});
