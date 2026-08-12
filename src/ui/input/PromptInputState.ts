import { assertNever } from "../../utils/assert.ts";
import {
	completeSlashCommandInput,
	type SlashCommandSuggestion,
} from "../commands/index.ts";
import {
	insertAttachmentChipLabels,
	type PromptInputAttachmentChips,
	preserveAttachmentChips,
	resolveAttachmentSubmit,
} from "./PromptInputChips.ts";
import {
	deletePromptInputBeforeCursorOnLine,
	deletePromptInputCharacterAtCursor,
	deletePromptInputCharacterBeforeCursor,
	deletePromptInputWordBeforeCursor,
	emptyPromptInputEdit,
	insertPromptInputText,
	movePromptInputCursorDown,
	movePromptInputCursorLeft,
	movePromptInputCursorRight,
	movePromptInputCursorToLineEnd,
	movePromptInputCursorToLineStart,
	movePromptInputCursorUp,
	movePromptInputCursorWordLeft,
	movePromptInputCursorWordRight,
	replaceBackslashBeforeCursorWithNewline,
} from "./PromptInputEditing.ts";
import {
	nextPromptHistory,
	previousPromptHistory,
	recordPromptHistory,
	shouldRecallPromptHistoryOnUp,
} from "./PromptInputHistory.ts";
import type { PromptInputKeyAction } from "./PromptInputKeyRouter.types.ts";
import {
	createPromptInputPastePreview,
	type PromptInputPastePreviews,
	preservePromptInputPastePreview,
	resolvePromptInputSubmitValue,
} from "./PromptInputPastePreview.ts";
import type {
	PromptHistoryState,
	PromptInputEdit,
	PromptInputMoveDirection,
	PromptSubmitIntent,
} from "./types.ts";

export interface PromptInputState {
	edit: PromptInputEdit;
	history: PromptHistoryState;
	pastePreviews: PromptInputPastePreviews;
	attachments: PromptInputAttachmentChips;
	selectedIndex: number;
}

export interface PromptInputActionContext {
	action: PromptInputKeyAction;
	selectedSuggestion: SlashCommandSuggestion | undefined;
	suggestionsLength: number;
}

export type PromptInputActionEffect =
	| { kind: "none" }
	| { kind: "pasteClipboardImage" }
	| {
			kind: "submit";
			intent: PromptSubmitIntent;
			value: string;
			attachmentIds: string[];
	  };

/** Anything rendered as an atomic chip inside the prompt text. */
type ChipLike = readonly { label: string }[];

export interface PromptInputActionResult {
	state: PromptInputState;
	effect: PromptInputActionEffect;
}

export function applyPromptInputPaste(
	state: PromptInputState,
	text: string,
): PromptInputState {
	const preview = createPromptInputPastePreview(text);
	if (preview) {
		const edit = insertPromptInputText(state.edit, preview.label);
		return {
			...state,
			edit,
			pastePreviews: [
				...preservePromptInputPastePreview(edit.value, state.pastePreviews),
				preview,
			],
			selectedIndex: 0,
		};
	}

	const edit = insertPromptInputText(state.edit, text);
	return {
		...state,
		edit,
		pastePreviews: preservePromptInputPastePreview(
			edit.value,
			state.pastePreviews,
		),
		selectedIndex: 0,
	};
}

export function applyPromptInputAttachments(
	state: PromptInputState,
	chips: PromptInputAttachmentChips,
): PromptInputState {
	if (chips.length === 0) return state;
	const edit = insertAttachmentChipLabels(state.edit, chips);
	return {
		...state,
		edit,
		attachments: [
			...preserveAttachmentChips(edit.value, state.attachments),
			...chips,
		],
		selectedIndex: 0,
	};
}

export function applyPromptInputAction(
	state: PromptInputState,
	context: PromptInputActionContext,
): PromptInputActionResult {
	const { action, selectedSuggestion, suggestionsLength } = context;
	switch (action.kind) {
		case "completeSuggestion": {
			const completed = completeSlashCommandInput(
				state.edit.value,
				selectedSuggestion,
			);
			return withoutEffect({
				...state,
				edit: { value: completed, cursorOffset: completed.length },
				pastePreviews: [],
				attachments: [],
				selectedIndex: 0,
			});
		}
		case "submit": {
			const activeChips = preserveAttachmentChips(
				state.edit.value,
				state.attachments,
			);
			const pasteResolved = resolvePromptInputSubmitValue(
				state.edit.value,
				state.pastePreviews,
				activeChips.length > 0 ? undefined : selectedSuggestion?.command,
			);
			const { value: submitted, attachmentIds } = resolveAttachmentSubmit(
				pasteResolved,
				activeChips,
			);
			if (!submitted) return withoutEffect(state);
			return {
				state: {
					...state,
					edit: emptyPromptInputEdit(),
					history: recordPromptHistory(state.history, submitted),
					pastePreviews: [],
					attachments: [],
					selectedIndex: 0,
				},
				effect: {
					kind: "submit",
					intent: action.intent,
					value: submitted,
					attachmentIds,
				},
			};
		}
		case "insertNewline":
			return updateEdit(state, insertPromptInputText(state.edit, "\n"));
		case "backslashEnterNewline":
			return updateEdit(
				state,
				replaceBackslashBeforeCursorWithNewline(state.edit),
			);
		case "moveCursor":
			return updateEdit(
				state,
				movePromptInputCursorOverChip(
					movePromptInputCursor(action.direction)(state.edit),
					allChips(state),
					action.direction,
				),
				{
					resetSelection: false,
				},
			);
		case "historyOrMoveUp":
			return applyPromptInputHistoryOrMoveUp(state, suggestionsLength);
		case "historyOrMoveDown":
			return applyPromptInputHistoryOrMoveDown(state, suggestionsLength);
		case "deletePreviousWord":
			return updateEdit(state, deletePromptInputWordBeforeCursor(state.edit));
		case "deleteBeforeCursorOnLine":
			return updateEdit(state, deletePromptInputBeforeCursorOnLine(state.edit));
		case "deletePreviousCharacter":
			return updateEdit(
				state,
				deletePromptInputCharacterBeforeCursorOverChip(
					state.edit,
					allChips(state),
				),
			);
		case "deleteNextCharacter":
			return updateEdit(
				state,
				deletePromptInputCharacterAtCursorOverChip(state.edit, allChips(state)),
			);
		case "slashCompletion":
			return updateEdit(
				state,
				insertPromptInputTextOutsideChip(state.edit, "/", allChips(state)),
			);
		case "insertText":
			return updateEdit(
				state,
				insertPromptInputTextOutsideChip(
					state.edit,
					action.text,
					allChips(state),
				),
			);
		case "pasteClipboardImage":
			return { state, effect: { kind: "pasteClipboardImage" } };
		case "ignore":
			return withoutEffect(state);
		default:
			assertNever(action);
	}
}

function applyPromptInputHistoryOrMoveUp(
	state: PromptInputState,
	suggestionsLength: number,
): PromptInputActionResult {
	if (
		shouldRecallPromptHistoryOnUp(
			state.history,
			state.edit,
			suggestionsLength > 0,
		)
	) {
		const next = previousPromptHistory(state.history, state.edit.value);
		return withoutEffect({
			...state,
			edit: promptInputEditFromValue(next.value),
			history: next.history,
			pastePreviews: [],
			attachments: [],
			selectedIndex: 0,
		});
	}
	if (suggestionsLength > 0) {
		return withoutEffect({
			...state,
			selectedIndex:
				(state.selectedIndex - 1 + suggestionsLength) % suggestionsLength,
		});
	}
	return updateEdit(state, movePromptInputCursorUp(state.edit), {
		resetSelection: false,
	});
}

function applyPromptInputHistoryOrMoveDown(
	state: PromptInputState,
	suggestionsLength: number,
): PromptInputActionResult {
	if (state.history.index !== null) {
		const next = nextPromptHistory(state.history);
		return withoutEffect({
			...state,
			edit: promptInputEditFromValue(next.value),
			history: next.history,
			pastePreviews: [],
			attachments: [],
			selectedIndex: 0,
		});
	}
	if (suggestionsLength > 0) {
		return withoutEffect({
			...state,
			selectedIndex: (state.selectedIndex + 1) % suggestionsLength,
		});
	}
	return updateEdit(state, movePromptInputCursorDown(state.edit), {
		resetSelection: false,
	});
}

function updateEdit(
	state: PromptInputState,
	edit: PromptInputEdit,
	options: { resetSelection?: boolean } = {},
): PromptInputActionResult {
	const selectedIndex =
		options.resetSelection === false ? state.selectedIndex : 0;
	if (edit === state.edit && selectedIndex === state.selectedIndex) {
		return withoutEffect(state);
	}
	return withoutEffect({
		...state,
		edit,
		selectedIndex,
	});
}

function allChips(state: PromptInputState): ChipLike {
	return [...state.pastePreviews, ...state.attachments];
}

function insertPromptInputTextOutsideChip(
	edit: PromptInputEdit,
	text: string,
	chips: ChipLike,
): PromptInputEdit {
	if (findChipRangeAtOffset(edit, chips, edit.cursorOffset)) {
		return edit;
	}
	return insertPromptInputText(edit, text);
}

function movePromptInputCursorOverChip(
	edit: PromptInputEdit,
	chips: ChipLike,
	direction: PromptInputMoveDirection,
): PromptInputEdit {
	const range = findChipRangeAtOffset(edit, chips, edit.cursorOffset);
	if (!range) return edit;
	if (direction === "right" || direction === "wordRight") {
		return { ...edit, cursorOffset: range.end };
	}
	if (direction === "left" || direction === "wordLeft") {
		return { ...edit, cursorOffset: range.start };
	}
	const distanceToStart = edit.cursorOffset - range.start;
	const distanceToEnd = range.end - edit.cursorOffset;
	return {
		...edit,
		cursorOffset: distanceToStart <= distanceToEnd ? range.start : range.end,
	};
}

function deletePromptInputCharacterBeforeCursorOverChip(
	edit: PromptInputEdit,
	chips: ChipLike,
): PromptInputEdit {
	const range = findChipRangeBeforeOffset(edit, chips, edit.cursorOffset);
	if (range) return deleteChipRange(edit, range);
	return deletePromptInputCharacterBeforeCursor(edit);
}

function deletePromptInputCharacterAtCursorOverChip(
	edit: PromptInputEdit,
	chips: ChipLike,
): PromptInputEdit {
	const range = findChipRangeAfterOffset(edit, chips, edit.cursorOffset);
	if (range) return deleteChipRange(edit, range);
	return deletePromptInputCharacterAtCursor(edit);
}

function deleteChipRange(
	edit: PromptInputEdit,
	range: { start: number; end: number },
): PromptInputEdit {
	return {
		value: edit.value.slice(0, range.start) + edit.value.slice(range.end),
		cursorOffset: range.start,
	};
}

function findChipRangeAtOffset(
	edit: PromptInputEdit,
	chips: ChipLike,
	offset: number,
): { start: number; end: number } | null {
	return findChipRange(edit, chips, (range) => {
		return range.start < offset && offset < range.end;
	});
}

function findChipRangeBeforeOffset(
	edit: PromptInputEdit,
	chips: ChipLike,
	offset: number,
): { start: number; end: number } | null {
	return findChipRange(edit, chips, (range) => {
		return range.start < offset && offset <= range.end;
	});
}

function findChipRangeAfterOffset(
	edit: PromptInputEdit,
	chips: ChipLike,
	offset: number,
): { start: number; end: number } | null {
	return findChipRange(edit, chips, (range) => {
		return range.start <= offset && offset < range.end;
	});
}

function findChipRange(
	edit: PromptInputEdit,
	chips: ChipLike,
	matches: (range: { start: number; end: number }) => boolean,
): { start: number; end: number } | null {
	for (const chip of chips) {
		let start = edit.value.indexOf(chip.label);
		while (start !== -1) {
			const range = { start, end: start + chip.label.length };
			if (matches(range)) return range;
			start = edit.value.indexOf(chip.label, range.end);
		}
	}
	return null;
}

function withoutEffect(state: PromptInputState): PromptInputActionResult {
	return { state, effect: { kind: "none" } };
}

function promptInputEditFromValue(value: string): PromptInputEdit {
	return { value, cursorOffset: value.length };
}

function movePromptInputCursor(direction: PromptInputMoveDirection) {
	switch (direction) {
		case "left":
			return movePromptInputCursorLeft;
		case "right":
			return movePromptInputCursorRight;
		case "lineStart":
			return movePromptInputCursorToLineStart;
		case "lineEnd":
			return movePromptInputCursorToLineEnd;
		case "up":
			return movePromptInputCursorUp;
		case "down":
			return movePromptInputCursorDown;
		case "wordLeft":
			return movePromptInputCursorWordLeft;
		case "wordRight":
			return movePromptInputCursorWordRight;
		default:
			assertNever(direction);
	}
}
