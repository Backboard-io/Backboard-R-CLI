import { describe, expect, it } from "bun:test";
import {
	cardHeaderWidths,
	sessionCardLayout,
} from "../src/ui/components/SessionCard.tsx";
import { clipEnd } from "../src/utils/string.ts";

describe("SessionCard responsive layout", () => {
	it("keeps the full startup card on wide terminals", () => {
		expect(sessionCardLayout(120)).toMatchObject({
			cardWidth: 74,
			paddingX: 2,
			rowLabelWidth: 13,
			showMascot: true,
			showWorkspace: true,
			showSessionHeading: true,
			showModeRow: true,
			showContextRow: true,
			showHelpRow: true,
			showHelpDescription: true,
		});
	});

	it("keeps the mascot through medium terminals", () => {
		expect(sessionCardLayout(80)).toMatchObject({
			showMascot: true,
			showWorkspace: true,
			showSessionHeading: true,
		});
	});

	it("keeps the mascot until the compact cutoff", () => {
		expect(sessionCardLayout(48)).toMatchObject({
			showMascot: true,
			showWorkspace: false,
			showSessionHeading: true,
		});
	});

	it("uses a compact card on narrow terminals", () => {
		expect(sessionCardLayout(46)).toMatchObject({
			cardWidth: 40,
			rowLabelWidth: 8,
			showMascot: false,
			showWorkspace: false,
			showSessionHeading: false,
			showModeRow: true,
			showContextRow: true,
			showHelpDescription: false,
		});
	});

	it("keeps only the essential model line on very tight terminals", () => {
		expect(sessionCardLayout(34)).toMatchObject({
			cardWidth: 28,
			paddingX: 1,
			showModeRow: false,
			showContextRow: false,
			showHelpRow: false,
		});
	});
});

describe("clipEnd", () => {
	it("clips long values to the requested width", () => {
		expect(clipEnd("openai/gpt-5.5-high-fast", 12)).toBe("openai/gp...");
	});

	it("does not add dots when the width is too small", () => {
		expect(clipEnd("abcdef", 2)).toBe("ab");
	});
});

describe("cardHeaderWidths", () => {
	it("reserves mascot space and borders inside the default card", () => {
		expect(cardHeaderWidths(sessionCardLayout(80))).toEqual({
			contentWidth: 68,
			headerTextWidth: 53,
		});
	});

	it("gives the header the full card when the mascot is hidden", () => {
		expect(cardHeaderWidths(sessionCardLayout(40))).toEqual({
			contentWidth: 28,
			headerTextWidth: 28,
		});
	});
});
