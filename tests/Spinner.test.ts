import { describe, expect, it } from "bun:test";
import {
	formatElapsedDuration,
	formatSpinnerMeta,
	spinnerSegmentDisplayText,
	spinnerShadowRange,
	spinnerTextSegments,
} from "../src/ui/components/SpinnerFormatting.ts";

describe("Spinner formatting", () => {
	it("formats elapsed time as whole seconds", () => {
		expect(formatElapsedDuration(0)).toBe("0s");
		expect(formatElapsedDuration(999)).toBe("0s");
		expect(formatElapsedDuration(4_000)).toBe("4s");
		expect(formatElapsedDuration(59_000)).toBe("59s");
		expect(formatElapsedDuration(63_000)).toBe("1m 03s");
		expect(formatElapsedDuration(125_000)).toBe("2m 05s");
		expect(formatElapsedDuration(3_600_000)).toBe("1h 00m 00s");
		expect(formatElapsedDuration(3_723_000)).toBe("1h 02m 03s");
		expect(formatElapsedDuration(86_400_000)).toBe("1d 00h 00m 00s");
		expect(formatElapsedDuration(90_123_000)).toBe("1d 01h 02m 03s");
	});

	it("formats spinner metadata inside one bracketed hint", () => {
		expect(formatSpinnerMeta(null, false)).toBeNull();
		expect(formatSpinnerMeta(7_000, false)).toBe("(7s)");
		expect(formatSpinnerMeta(null, true)).toBe("(esc to interrupt)");
		expect(formatSpinnerMeta(63_000, true)).toBe("(1m 03s · esc to interrupt)");
	});

	it("moves the shadow across the label before leaving a gap", () => {
		expect(spinnerShadowRange("Working", 0)).toEqual({ start: 0, end: 6 });
		expect(spinnerShadowRange("Working", 5)).toEqual({ start: 5, end: 7 });
		expect(spinnerShadowRange("Working", 6)).toEqual({ start: 6, end: 7 });
		expect(spinnerShadowRange("Working", 7)).toBeNull();
		expect(spinnerShadowRange("Working", 8)).toEqual({ start: 0, end: 6 });
	});

	it("starts marker loader shadows at the diamond", () => {
		expect(spinnerShadowRange("◆Working", 0)).toEqual({ start: 0, end: 6 });
		expect(spinnerShadowRange("◆Working", 1)).toEqual({ start: 1, end: 7 });
	});

	it("balances the loader gradient around a transparent core", () => {
		const range = spinnerShadowRange("◆Working", 0);

		expect(spinnerTextSegments("Working", 1, range)).toEqual([
			{ start: 1, text: "W", tone: "shadowTrail" },
			{ start: 2, text: "or", tone: "shadowCore" },
			{ start: 4, text: "ki", tone: "shadowLead" },
			{ start: 6, text: "ng", tone: "normal" },
		]);
	});

	it("renders the gradient core as terminal background space", () => {
		expect(
			spinnerSegmentDisplayText({ start: 2, text: "or", tone: "shadowCore" }),
		).toBe("  ");
		expect(
			spinnerSegmentDisplayText({ start: 4, text: "ki", tone: "shadowLead" }),
		).toBe("ki");
	});

	it("lets marker loader shadows pass through the diamond", () => {
		const range = spinnerShadowRange("◆Working", 1);

		expect(spinnerTextSegments("◆Working", 0, range)).toEqual([
			{ start: 0, text: "◆", tone: "normal" },
			{ start: 1, text: "Wo", tone: "shadowTrail" },
			{ start: 3, text: "rk", tone: "shadowCore" },
			{ start: 5, text: "in", tone: "shadowLead" },
			{ start: 7, text: "g", tone: "normal" },
		]);
	});
});
