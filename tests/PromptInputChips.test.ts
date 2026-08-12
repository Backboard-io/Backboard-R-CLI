import { describe, expect, it } from "bun:test";
import { emptyPromptHistoryState } from "../src/ui/components/PromptInput.tsx";
import {
	droppedAttachmentChipIds,
	insertAttachmentChipLabels,
	preserveAttachmentChips,
	resolveAttachmentSubmit,
} from "../src/ui/input/PromptInputChips.ts";
import {
	applyPromptInputAction,
	applyPromptInputAttachments,
	type PromptInputState,
} from "../src/ui/input/PromptInputState.ts";

const chipA = {
	id: "att-1-ab12",
	label: "[file: a.png #ab12]",
	fileName: "a.png",
	filePath: "/Users/me/Desktop/a.png",
};
const chipB = {
	id: "att-2-cd34",
	label: "[file: b.pdf #cd34]",
	fileName: "b.pdf",
	filePath: "/Users/me/Downloads/b.pdf",
};

function state(value: string, cursorOffset?: number): PromptInputState {
	return {
		edit: { value, cursorOffset: cursorOffset ?? value.length },
		history: emptyPromptHistoryState(),
		pastePreviews: [],
		attachments: [chipA, chipB].filter((chip) => value.includes(chip.label)),
		selectedIndex: 0,
	};
}

function context(
	action: Parameters<typeof applyPromptInputAction>[1]["action"],
) {
	return { action, selectedSuggestion: undefined, suggestionsLength: 0 };
}

describe("attachment chips in prompt state", () => {
	it("inserts labels at the cursor with separating spaces", () => {
		const next = applyPromptInputAttachments(state("look at"), [chipA, chipB]);
		expect(next.edit.value).toBe(
			"look at [file: a.png #ab12] [file: b.pdf #cd34] ",
		);
		expect(next.attachments).toEqual([chipA, chipB]);
	});

	it("backspace at the end of a chip deletes the whole label", () => {
		const value = `hi ${chipA.label}`;
		const result = applyPromptInputAction(
			state(value),
			context({ kind: "deletePreviousCharacter" }),
		);
		expect(result.state.edit.value).toBe("hi ");
	});

	it("cursor moves jump over a chip label", () => {
		const value = `hi ${chipA.label} x`;
		const inside = state(value, 3 + Math.floor(chipA.label.length / 2));
		const result = applyPromptInputAction(
			inside,
			context({ kind: "moveCursor", direction: "right" }),
		);
		expect(result.state.edit.cursorOffset).toBe(3 + chipA.label.length);
	});

	it("typing inside a chip is blocked", () => {
		const value = `hi ${chipA.label}`;
		const inside = state(value, 5);
		const result = applyPromptInputAction(
			inside,
			context({ kind: "insertText", text: "zz" }),
		);
		expect(result.state.edit.value).toBe(value);
	});

	it("submit substitutes filenames and carries ordered attachment ids", () => {
		const value = `${chipB.label} then ${chipA.label} please`;
		const result = applyPromptInputAction(
			state(value),
			context({ kind: "submit", intent: "send" }),
		);
		expect(result.effect).toEqual({
			kind: "submit",
			intent: "send",
			value:
				"[attached: /Users/me/Downloads/b.pdf] then [attached: /Users/me/Desktop/a.png] please",
			attachmentIds: [chipB.id, chipA.id],
		});
		expect(result.state.attachments).toEqual([]);
	});

	it("attachment-only submit sends the filenames as text", () => {
		const result = applyPromptInputAction(
			state(`${chipA.label} `),
			context({ kind: "submit", intent: "send" }),
		);
		expect(result.effect).toEqual({
			kind: "submit",
			intent: "send",
			value: "[attached: /Users/me/Desktop/a.png]",
			attachmentIds: [chipA.id],
		});
	});

	it("submit ignores chips whose labels were deleted from the text", () => {
		const withBoth = state(`${chipA.label} ${chipB.label}`);
		const edited = {
			...withBoth,
			edit: { value: chipB.label, cursorOffset: chipB.label.length },
		};
		const result = applyPromptInputAction(
			edited,
			context({ kind: "submit", intent: "send" }),
		);
		expect(result.effect).toEqual({
			kind: "submit",
			intent: "send",
			value: "[attached: /Users/me/Downloads/b.pdf]",
			attachmentIds: [chipB.id],
		});
	});

	it("history recall clears attachments", () => {
		const withChip = applyPromptInputAttachments(state(""), [chipA]);
		const withHistory = {
			...withChip,
			history: { entries: ["older"], index: null, draft: "" },
		};
		const result = applyPromptInputAction(
			withHistory,
			context({ kind: "historyOrMoveUp" }),
		);
		expect(result.state.attachments).toEqual([]);
	});
});

describe("chip helpers", () => {
	it("insertAttachmentChipLabels adds no leading space at start of input", () => {
		const edit = insertAttachmentChipLabels({ value: "", cursorOffset: 0 }, [
			chipA,
		]);
		expect(edit.value).toBe(`${chipA.label} `);
	});

	it("preserveAttachmentChips drops chips missing from the value", () => {
		expect(preserveAttachmentChips(chipA.label, [chipA, chipB])).toEqual([
			chipA,
		]);
	});

	it("droppedAttachmentChipIds diffs by id", () => {
		expect(droppedAttachmentChipIds([chipA, chipB], [chipB])).toEqual([
			chipA.id,
		]);
	});

	it("resolveAttachmentSubmit keeps multi-line text intact", () => {
		const value = `line one\n${chipA.label}\nline two`;
		expect(resolveAttachmentSubmit(value, [chipA])).toEqual({
			value: "line one\n[attached: /Users/me/Desktop/a.png]\nline two",
			attachmentIds: [chipA.id],
		});
	});
});
