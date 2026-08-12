import { describe, expect, it } from "bun:test";
import type { Key } from "ink";
import {
	emptyPromptHistoryState,
	formatQueuedPrompt,
	nextPromptHistory,
	previousPromptHistory,
	recordPromptHistory,
	shouldRecallPromptHistoryOnUp,
} from "../src/ui/components/PromptInput.tsx";
import {
	deletePromptInputBeforeCursorOnLine,
	deletePromptInputCharacterBeforeCursor,
	deletePromptInputWordBeforeCursor,
	insertPromptInputText,
	movePromptInputCursorDown,
	movePromptInputCursorLeft,
	movePromptInputCursorRight,
	movePromptInputCursorToLineEnd,
	movePromptInputCursorToLineStart,
	movePromptInputCursorUp,
	movePromptInputCursorWordLeft,
	movePromptInputCursorWordRight,
	normalizePromptInputText,
	promptInputCursorPosition,
	promptInputLines,
	promptInputOffsetAtPosition,
	replaceBackslashBeforeCursorWithNewline,
} from "../src/ui/input/PromptInputEditing.ts";
import { resolvePromptInputKeyAction } from "../src/ui/input/PromptInputKeyRouter.ts";
import {
	createPromptInputPastePreview,
	preservePromptInputPastePreview,
	resolvePromptInputPasteValue,
	resolvePromptInputSubmitValue,
	shouldShowPromptInputPastePreview,
} from "../src/ui/input/PromptInputPastePreview.ts";
import {
	applyPromptInputAction,
	applyPromptInputPaste,
	type PromptInputState,
} from "../src/ui/input/PromptInputState.ts";

function emptyPromptInputState(): PromptInputState {
	return {
		edit: { value: "", cursorOffset: 0 },
		history: emptyPromptHistoryState(),
		pastePreviews: [],
		attachments: [],
		selectedIndex: 0,
	};
}

function stateWithPaste(text: string): PromptInputState {
	return applyPromptInputPaste(emptyPromptInputState(), text);
}

function actionContext(
	action: Parameters<typeof applyPromptInputAction>[1]["action"],
): Parameters<typeof applyPromptInputAction>[1] {
	return {
		action,
		selectedSuggestion: undefined,
		suggestionsLength: 0,
	};
}

describe("PromptInput editing", () => {
	it("inserts Shift+Enter newlines at the cursor", () => {
		const edit = insertPromptInputText(
			{ value: "hello world", cursorOffset: 5 },
			"\n",
		);

		expect(edit).toEqual({
			value: "hello\n world",
			cursorOffset: 6,
		});
		expect(promptInputLines(edit.value)).toEqual(["hello", " world"]);
	});

	it("normalizes pasted CRLF text into prompt newlines", () => {
		expect(
			insertPromptInputText({ value: "a", cursorOffset: 1 }, "\r\nb"),
		).toEqual({
			value: "a\nb",
			cursorOffset: 3,
		});
	});

	it("normalizes pasted control characters before insertion", () => {
		expect(normalizePromptInputText("a\tb\u001Bc\u0007d")).toBe("a bcd");
		expect(
			insertPromptInputText(
				{ value: "hello", cursorOffset: 5 },
				"\tthere\u001B",
			),
		).toEqual({
			value: "hello there",
			cursorOffset: 11,
		});
	});

	it("backs across line breaks", () => {
		expect(
			deletePromptInputCharacterBeforeCursor({
				value: "hello\nworld",
				cursorOffset: 6,
			}),
		).toEqual({
			value: "helloworld",
			cursorOffset: 5,
		});
	});

	it("deletes the previous word for modified Backspace", () => {
		expect(
			deletePromptInputWordBeforeCursor({
				value: "hello world  ",
				cursorOffset: "hello world  ".length,
			}),
		).toEqual({
			value: "hello ",
			cursorOffset: 6,
		});

		expect(
			deletePromptInputWordBeforeCursor({
				value: "foo.bar",
				cursorOffset: "foo.bar".length,
			}),
		).toEqual({
			value: "foo.",
			cursorOffset: 4,
		});
	});

	it("deletes to the start of the current line for macOS Command+Backspace fallback", () => {
		expect(
			deletePromptInputBeforeCursorOnLine({
				value: "first line\nsecond line",
				cursorOffset: "first line\nsecond".length,
			}),
		).toEqual({
			value: "first line\n line",
			cursorOffset: "first line\n".length,
		});
	});

	it("turns backslash Enter fallback into a newline", () => {
		expect(
			replaceBackslashBeforeCursorWithNewline({
				value: "first\\second",
				cursorOffset: "first\\".length,
			}),
		).toEqual({
			value: "first\nsecond",
			cursorOffset: 6,
		});
	});

	it("moves within and across multiline input", () => {
		const edit = { value: "one\ntwo\nthree", cursorOffset: 5 };

		expect(promptInputCursorPosition(edit.value, edit.cursorOffset)).toEqual({
			lineIndex: 1,
			column: 1,
		});
		expect(movePromptInputCursorUp(edit).cursorOffset).toBe(1);
		expect(movePromptInputCursorDown(edit).cursorOffset).toBe(9);
		expect(movePromptInputCursorLeft(edit).cursorOffset).toBe(4);
		expect(movePromptInputCursorRight(edit).cursorOffset).toBe(6);
	});

	it("moves to line boundaries", () => {
		const edit = { value: "one\ntwo\nthree", cursorOffset: 5 };

		expect(movePromptInputCursorToLineStart(edit).cursorOffset).toBe(4);
		expect(movePromptInputCursorToLineEnd(edit).cursorOffset).toBe(7);
		expect(promptInputOffsetAtPosition(edit.value, 2, 100)).toBe(13);
	});

	it("moves by words", () => {
		const edit = { value: "one two three", cursorOffset: "one two".length };

		expect(movePromptInputCursorWordLeft(edit).cursorOffset).toBe(4);
		expect(movePromptInputCursorWordRight(edit).cursorOffset).toBe(8);
	});
});

describe("PromptInput key router", () => {
	it("maps Windows and Linux Ctrl+Backspace to previous-word deletion", () => {
		expect(
			resolvePromptInputKeyAction("", key({ ctrl: true, backspace: true }), {
				busy: false,
				cursorOffset: 0,
				platform: "win32",
				suggestionsVisible: false,
				value: "hello world",
			}),
		).toEqual({ kind: "deletePreviousWord" });
		expect(
			resolvePromptInputKeyAction("", key({ ctrl: true, backspace: true }), {
				busy: false,
				cursorOffset: 0,
				platform: "linux",
				suggestionsVisible: false,
				value: "hello world",
			}),
		).toEqual({ kind: "deletePreviousWord" });
	});

	it("maps macOS command-style Backspace to previous-word deletion", () => {
		expect(
			resolvePromptInputKeyAction("", key({ super: true, backspace: true }), {
				busy: false,
				cursorOffset: 0,
				platform: "darwin",
				suggestionsVisible: false,
				value: "hello world",
			}),
		).toEqual({ kind: "deletePreviousWord" });
		expect(
			resolvePromptInputKeyAction("", key({ meta: true, backspace: true }), {
				busy: false,
				cursorOffset: 0,
				platform: "darwin",
				suggestionsVisible: false,
				value: "hello world",
			}),
		).toEqual({ kind: "deletePreviousWord" });
	});

	it("maps macOS Ctrl+U bytes from Command+Backspace to line deletion", () => {
		expect(
			resolvePromptInputKeyAction("u", key({ ctrl: true }), {
				busy: false,
				cursorOffset: 0,
				platform: "darwin",
				suggestionsVisible: false,
				value: "hello world",
			}),
		).toEqual({ kind: "deleteBeforeCursorOnLine" });
	});

	it("maps Ctrl+V to clipboard image paste on macOS and Linux", () => {
		for (const platform of ["darwin", "linux"] as const) {
			expect(
				resolvePromptInputKeyAction("v", key({ ctrl: true }), {
					busy: false,
					cursorOffset: 0,
					platform,
					suggestionsVisible: false,
					value: "",
				}),
			).toEqual({ kind: "pasteClipboardImage" });
		}
	});

	it("maps Ctrl+V to clipboard image paste on Windows", () => {
		expect(
			resolvePromptInputKeyAction("v", key({ ctrl: true }), {
				busy: false,
				cursorOffset: 0,
				platform: "win32",
				suggestionsVisible: false,
				value: "",
			}),
		).toEqual({ kind: "pasteClipboardImage" });
		expect(
			resolvePromptInputKeyAction("v", key({ meta: true }), {
				busy: false,
				cursorOffset: 0,
				platform: "win32",
				suggestionsVisible: false,
				value: "",
			}),
		).not.toEqual({ kind: "pasteClipboardImage" });
	});

	it("does not treat plain v as clipboard image paste", () => {
		expect(
			resolvePromptInputKeyAction("v", key({}), {
				busy: false,
				cursorOffset: 0,
				platform: "darwin",
				suggestionsVisible: false,
				value: "",
			}),
		).toEqual({ kind: "insertText", text: "v" });
	});

	it("maps Shift+Enter and backslash Enter to newline actions", () => {
		expect(
			resolvePromptInputKeyAction("", key({ return: true, shift: true }), {
				busy: false,
				cursorOffset: 0,
				platform: "linux",
				suggestionsVisible: false,
				value: "hello",
			}),
		).toEqual({ kind: "insertNewline" });
		expect(
			resolvePromptInputKeyAction("", key({ return: true }), {
				busy: false,
				cursorOffset: "hello\\".length,
				platform: "linux",
				suggestionsVisible: false,
				value: "hello\\",
			}),
		).toEqual({ kind: "backslashEnterNewline" });
	});

	it("routes backslash Enter using the cursor position", () => {
		expect(
			resolvePromptInputKeyAction("", key({ return: true }), {
				busy: false,
				cursorOffset: "a\\".length,
				platform: "linux",
				suggestionsVisible: false,
				value: "a\\b",
			}),
		).toEqual({ kind: "backslashEnterNewline" });
		expect(
			resolvePromptInputKeyAction("", key({ return: true }), {
				busy: false,
				cursorOffset: 1,
				platform: "linux",
				suggestionsVisible: false,
				value: "a\\",
			}),
		).toEqual({ kind: "submit", intent: "send" });
	});

	it("preserves Ctrl+W previous-word deletion on macOS", () => {
		expect(
			resolvePromptInputKeyAction("w", key({ ctrl: true }), {
				busy: false,
				cursorOffset: "hello world".length,
				platform: "darwin",
				suggestionsVisible: false,
				value: "hello world",
			}),
		).toEqual({ kind: "deletePreviousWord" });
	});

	it("maps option/control arrows to word movement and command arrows to line movement", () => {
		expect(
			resolvePromptInputKeyAction("", key({ leftArrow: true, meta: true }), {
				busy: false,
				cursorOffset: 0,
				platform: "darwin",
				suggestionsVisible: false,
				value: "hello world",
			}),
		).toEqual({ kind: "moveCursor", direction: "wordLeft" });
		expect(
			resolvePromptInputKeyAction("", key({ rightArrow: true, ctrl: true }), {
				busy: false,
				cursorOffset: 0,
				platform: "linux",
				suggestionsVisible: false,
				value: "hello world",
			}),
		).toEqual({ kind: "moveCursor", direction: "wordRight" });
		expect(
			resolvePromptInputKeyAction("", key({ leftArrow: true, super: true }), {
				busy: false,
				cursorOffset: 0,
				platform: "darwin",
				suggestionsVisible: false,
				value: "hello world",
			}),
		).toEqual({ kind: "moveCursor", direction: "lineStart" });
	});

	it("maps readline bytes from modified arrows instead of typing letters", () => {
		expect(
			resolvePromptInputKeyAction("b", key({ meta: true }), {
				busy: false,
				cursorOffset: 0,
				platform: "darwin",
				suggestionsVisible: false,
				value: "hello world",
			}),
		).toEqual({ kind: "moveCursor", direction: "wordLeft" });
		expect(
			resolvePromptInputKeyAction("f", key({ meta: true }), {
				busy: false,
				cursorOffset: 0,
				platform: "darwin",
				suggestionsVisible: false,
				value: "hello world",
			}),
		).toEqual({ kind: "moveCursor", direction: "wordRight" });
		expect(
			resolvePromptInputKeyAction("a", key({ ctrl: true }), {
				busy: false,
				cursorOffset: 0,
				platform: "win32",
				suggestionsVisible: false,
				value: "hello world",
			}),
		).toEqual({ kind: "moveCursor", direction: "lineStart" });
		expect(
			resolvePromptInputKeyAction("e", key({ ctrl: true }), {
				busy: false,
				cursorOffset: 0,
				platform: "win32",
				suggestionsVisible: false,
				value: "hello world",
			}),
		).toEqual({ kind: "moveCursor", direction: "lineEnd" });
	});

	it("maps literal modified Enter escape text to newlines", () => {
		expect(
			resolvePromptInputKeyAction("[27;2;13~", key({}), {
				busy: false,
				cursorOffset: 0,
				platform: "darwin",
				suggestionsVisible: false,
				value: "hello",
			}),
		).toEqual({ kind: "insertText", text: "\n" });
		expect(
			resolvePromptInputKeyAction("[27;2;13~[27;2;13~", key({}), {
				busy: false,
				cursorOffset: 0,
				platform: "linux",
				suggestionsVisible: false,
				value: "hello",
			}),
		).toEqual({ kind: "insertText", text: "\n\n" });
	});
});

describe("PromptInput paste preview", () => {
	it("compacts large multiline paste display while retaining full value", () => {
		const paste = Array.from(
			{ length: 10 },
			(_, index) => `line ${index + 1}`,
		).join("\n");
		const preview = createPromptInputPastePreview(paste, {
			now: new Date("2026-06-26T07:45:00Z"),
			sourceLabel: "Backboard R-CLI You",
		});

		expect(preview?.value).toBe(paste);
		expect(preview?.label).toContain("Backboard R-CLI You");
		expect(preview?.label).toContain("line 1 line 2");
		expect(preview?.label).toContain("10 lines");
		expect(preview?.label).not.toContain(preview?.id ?? "");
	});

	it("uses a shorter visible preview text", () => {
		const preview = createPromptInputPastePreview(
			`${"a".repeat(40)}\n`.repeat(8),
		);

		expect(preview?.label).toContain(`${"a".repeat(21)}...`);
		expect(preview?.label).not.toContain(`${"a".repeat(22)}...`);
	});

	it("keeps a large paste active across cursor movement only", () => {
		const preview = createPromptInputPastePreview("x\n".repeat(10));
		const previews = preview ? [preview] : [];

		expect(
			shouldShowPromptInputPastePreview(preview?.label ?? "", previews),
		).toBe(true);
		expect(
			shouldShowPromptInputPastePreview(
				`${(preview?.label ?? "").slice(0, -1)} edited`,
				previews,
			),
		).toBe(false);
	});

	it("submits full paste only while the compact label is unchanged", () => {
		const paste = "long pasted line with enough content\n".repeat(40);
		const preview = createPromptInputPastePreview(paste);
		const previews = preview ? [preview] : [];
		const label = preview?.label ?? "";

		expect(label.length).toBeLessThan(paste.length);
		expect(resolvePromptInputPasteValue(label, previews)).toBe(paste);
		expect(resolvePromptInputPasteValue(`${label}\nextra`, previews)).toBe(
			`${paste}\nextra`,
		);
		expect(resolvePromptInputPasteValue(`summarize:\n${label}`, previews)).toBe(
			`summarize:\n${paste}`,
		);
	});

	it("restores full paste if reversible edits return to the compact label", () => {
		const paste = "long pasted line with enough content\n".repeat(40);
		const preview = createPromptInputPastePreview(paste);
		const previews = preview ? [preview] : [];
		const label = preview?.label ?? "";
		const edited = `${label.slice(0, -1)}hi`;

		expect(resolvePromptInputPasteValue(edited, previews)).toBe(edited);
		expect(resolvePromptInputPasteValue(label, previews)).toBe(paste);
	});

	it("uses slash suggestion commands when paste preview is stale", () => {
		const paste = "long pasted line with enough content\n".repeat(40);
		const preview = createPromptInputPastePreview(paste);
		const previews = preview ? [preview] : [];
		const label = preview?.label ?? "";
		const editedLabel = `${label.slice(0, -1)}/m`;

		expect(resolvePromptInputSubmitValue(editedLabel, previews, "/model")).toBe(
			"/model",
		);
	});

	it("keeps paste preview active when small paste appends after the label", () => {
		const paste = "long pasted line with enough content\n".repeat(40);
		const preview = createPromptInputPastePreview(paste);
		const previews = preview ? [preview] : [];
		const value = `${preview?.label ?? ""} appended`;

		expect(preservePromptInputPastePreview(value, previews)).toEqual(previews);
		expect(resolvePromptInputPasteValue(value, previews)).toBe(
			`${paste} appended`,
		);
	});

	it("preserves earlier large paste previews when adding another large paste", () => {
		const firstPaste = "first pasted line with enough content\n".repeat(40);
		const secondPaste = "second pasted line with enough content\n".repeat(40);
		const firstPreview = createPromptInputPastePreview(firstPaste, {
			now: new Date("2026-06-26T07:45:00Z"),
		});
		const secondPreview = createPromptInputPastePreview(secondPaste, {
			now: new Date("2026-06-26T07:46:00Z"),
		});
		const previews = [firstPreview, secondPreview].filter(
			(preview) => preview !== null,
		);
		const value = previews.map((preview) => preview.label).join("\n");

		expect(resolvePromptInputPasteValue(value, previews)).toBe(
			`${firstPaste}\n${secondPaste}`,
		);
	});

	it("keeps colliding-looking paste hashes unique without showing them", () => {
		const firstPaste = `${"same preview prefix ".repeat(4)}A\n${"x\n".repeat(40)}`;
		const secondPaste = `${"same preview prefix ".repeat(4)}B\n${"x\n".repeat(40)}`;
		const firstPreview = createPromptInputPastePreview(firstPaste, {
			now: new Date("2026-06-26T07:45:00Z"),
		});
		const secondPreview = createPromptInputPastePreview(secondPaste, {
			now: new Date("2026-06-26T07:45:00Z"),
		});
		const previews = [firstPreview, secondPreview].filter(
			(preview) => preview !== null,
		);

		expect(firstPreview?.id).not.toBe(secondPreview?.id);
		expect(firstPreview?.label).not.toContain(firstPreview?.id ?? "");
		expect(secondPreview?.label).not.toContain(secondPreview?.id ?? "");
		expect(
			resolvePromptInputPasteValue(
				previews.map((preview) => preview.label).join("\n"),
				previews,
			),
		).toBe(`${firstPaste}\n${secondPaste}`);
	});

	it("hops left and right over paste previews", () => {
		const state = stateWithPaste(
			"long pasted line with enough content\n".repeat(40),
		);
		const label = state.edit.value;
		const movedLeft = applyPromptInputAction(
			state,
			actionContext({
				kind: "moveCursor",
				direction: "left",
			}),
		).state;
		const movedRight = applyPromptInputAction(
			{ ...state, edit: { value: label, cursorOffset: 0 } },
			actionContext({ kind: "moveCursor", direction: "right" }),
		).state;

		expect(movedLeft.edit.cursorOffset).toBe(0);
		expect(movedRight.edit.cursorOffset).toBe(label.length);
	});

	it("blocks character edits inside paste previews", () => {
		const state = stateWithPaste(
			"long pasted line with enough content\n".repeat(40),
		);
		const insidePaste = {
			...state,
			edit: { value: state.edit.value, cursorOffset: 3 },
		};
		const next = applyPromptInputAction(
			insidePaste,
			actionContext({ kind: "insertText", text: "x" }),
		).state;

		expect(next.edit).toEqual(insidePaste.edit);
	});

	it("removes the whole paste preview when backspacing after it", () => {
		const state = stateWithPaste(
			"long pasted line with enough content\n".repeat(40),
		);
		const next = applyPromptInputAction(
			state,
			actionContext({ kind: "deletePreviousCharacter" }),
		).state;

		expect(next.edit).toEqual({ value: "", cursorOffset: 0 });
	});
});

describe("PromptInput queue display", () => {
	it("formats queued prompts on one compact row", () => {
		expect(formatQueuedPrompt("  update\nthen continue   ")).toBe(
			"update then continue",
		);
		expect(formatQueuedPrompt("x".repeat(100))).toBe(`${"x".repeat(77)}...`);
	});
});

describe("PromptInput history", () => {
	it("recalls previous prompts and restores the current draft", () => {
		let history = emptyPromptHistoryState();
		history = recordPromptHistory(history, "first");
		history = recordPromptHistory(history, "second");

		const previous = previousPromptHistory(history, "draft");
		expect(previous.value).toBe("second");

		const older = previousPromptHistory(previous.history, previous.value);
		expect(older.value).toBe("first");

		const newer = nextPromptHistory(older.history);
		expect(newer.value).toBe("second");

		const draft = nextPromptHistory(newer.history);
		expect(draft.value).toBe("draft");
		expect(draft.history.index).toBeNull();
	});

	it("only recalls history with Up when the cursor is on the first line", () => {
		const history = recordPromptHistory(emptyPromptHistoryState(), "previous");

		expect(
			shouldRecallPromptHistoryOnUp(history, {
				value: "first line\nsecond line",
				cursorOffset: "first line\nse".length,
			}),
		).toBe(false);
		expect(
			shouldRecallPromptHistoryOnUp(history, {
				value: "first line\nsecond line",
				cursorOffset: "fir".length,
			}),
		).toBe(true);
	});

	it("lets suggestions use Up until history browsing is active", () => {
		const history = recordPromptHistory(emptyPromptHistoryState(), "/browser");

		expect(
			shouldRecallPromptHistoryOnUp(
				history,
				{
					value: "/",
					cursorOffset: 1,
				},
				true,
			),
		).toBe(false);

		const previous = previousPromptHistory(history, "");
		expect(
			shouldRecallPromptHistoryOnUp(
				previous.history,
				{
					value: previous.value,
					cursorOffset: previous.value.length,
				},
				true,
			),
		).toBe(true);
	});

	it("does not add consecutive duplicate entries", () => {
		let history = emptyPromptHistoryState();
		history = recordPromptHistory(history, "repeat");
		history = recordPromptHistory(history, "repeat");
		expect(history.entries).toEqual(["repeat"]);
	});

	it("adds slash commands to history", () => {
		let history = emptyPromptHistoryState();
		history = recordPromptHistory(history, "message");
		history = recordPromptHistory(history, "/notify");
		history = recordPromptHistory(history, "  /model");
		expect(history.entries).toEqual(["message", "/notify", "  /model"]);
	});

	it("keeps submitted history entries unchanged", () => {
		let history = emptyPromptHistoryState();
		history = recordPromptHistory(history, "  keep spacing  ");
		expect(history.entries).toEqual(["  keep spacing  "]);
	});
});

function key(overrides: Partial<Key>): Key {
	return {
		upArrow: false,
		downArrow: false,
		leftArrow: false,
		rightArrow: false,
		pageDown: false,
		pageUp: false,
		home: false,
		end: false,
		return: false,
		escape: false,
		ctrl: false,
		shift: false,
		tab: false,
		backspace: false,
		delete: false,
		meta: false,
		super: false,
		hyper: false,
		capsLock: false,
		numLock: false,
		...overrides,
	};
}
