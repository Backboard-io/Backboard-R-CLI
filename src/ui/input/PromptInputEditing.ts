import {
	isPromptInputWhitespace,
	isPromptInputWordCharacter,
	normalizePromptInputText,
} from "./PromptInputText.ts";
import type { PromptInputCursorPosition, PromptInputEdit } from "./types.ts";

export { normalizePromptInputText } from "./PromptInputText.ts";

export function emptyPromptInputEdit(): PromptInputEdit {
	return { value: "", cursorOffset: 0 };
}

export function promptInputLines(value: string): string[] {
	return value.split("\n");
}

export function insertPromptInputText(
	edit: PromptInputEdit,
	text: string,
): PromptInputEdit {
	const value = edit.value;
	const cursorOffset = clampCursorOffset(value, edit.cursorOffset);
	const normalizedText = normalizePromptInputText(text);
	if (!normalizedText) return { value, cursorOffset };
	return {
		value:
			value.slice(0, cursorOffset) + normalizedText + value.slice(cursorOffset),
		cursorOffset: cursorOffset + normalizedText.length,
	};
}

export function deletePromptInputCharacterBeforeCursor(
	edit: PromptInputEdit,
): PromptInputEdit {
	const value = edit.value;
	const cursorOffset = clampCursorOffset(value, edit.cursorOffset);
	if (cursorOffset === 0) return edit;
	return {
		value: value.slice(0, cursorOffset - 1) + value.slice(cursorOffset),
		cursorOffset: cursorOffset - 1,
	};
}

export function deletePromptInputCharacterAtCursor(
	edit: PromptInputEdit,
): PromptInputEdit {
	const value = edit.value;
	const cursorOffset = clampCursorOffset(value, edit.cursorOffset);
	if (cursorOffset >= value.length) return edit;
	return {
		value: value.slice(0, cursorOffset) + value.slice(cursorOffset + 1),
		cursorOffset,
	};
}

export function deletePromptInputWordBeforeCursor(
	edit: PromptInputEdit,
): PromptInputEdit {
	const value = edit.value;
	const cursorOffset = clampCursorOffset(value, edit.cursorOffset);
	if (cursorOffset === 0) return { value, cursorOffset };

	let deleteFrom = cursorOffset;
	while (deleteFrom > 0 && isPromptInputWhitespace(value[deleteFrom - 1])) {
		deleteFrom -= 1;
	}
	while (deleteFrom > 0 && isPromptInputWordCharacter(value[deleteFrom - 1])) {
		deleteFrom -= 1;
	}
	if (deleteFrom === cursorOffset) deleteFrom -= 1;

	return {
		value: value.slice(0, deleteFrom) + value.slice(cursorOffset),
		cursorOffset: deleteFrom,
	};
}

export function deletePromptInputBeforeCursorOnLine(
	edit: PromptInputEdit,
): PromptInputEdit {
	const value = edit.value;
	const cursorOffset = clampCursorOffset(value, edit.cursorOffset);
	const lineStart = value.lastIndexOf("\n", cursorOffset - 1) + 1;
	return {
		value: value.slice(0, lineStart) + value.slice(cursorOffset),
		cursorOffset: lineStart,
	};
}

export function replaceBackslashBeforeCursorWithNewline(
	edit: PromptInputEdit,
): PromptInputEdit {
	const value = edit.value;
	const cursorOffset = clampCursorOffset(value, edit.cursorOffset);
	if (cursorOffset === 0 || value[cursorOffset - 1] !== "\\") {
		return insertPromptInputText({ value, cursorOffset }, "\n");
	}
	const nextValue = `${value.slice(0, cursorOffset - 1)}\n${value.slice(cursorOffset)}`;
	return {
		value: nextValue,
		cursorOffset,
	};
}

export function movePromptInputCursorLeft(
	edit: PromptInputEdit,
): PromptInputEdit {
	const cursorOffset = clampCursorOffset(edit.value, edit.cursorOffset - 1);
	if (cursorOffset === edit.cursorOffset) return edit;
	return {
		value: edit.value,
		cursorOffset,
	};
}

export function movePromptInputCursorRight(
	edit: PromptInputEdit,
): PromptInputEdit {
	const cursorOffset = clampCursorOffset(edit.value, edit.cursorOffset + 1);
	if (cursorOffset === edit.cursorOffset) return edit;
	return {
		value: edit.value,
		cursorOffset,
	};
}

export function movePromptInputCursorWordLeft(
	edit: PromptInputEdit,
): PromptInputEdit {
	const value = edit.value;
	let cursorOffset = clampCursorOffset(value, edit.cursorOffset);
	while (cursorOffset > 0 && isPromptInputWhitespace(value[cursorOffset - 1])) {
		cursorOffset -= 1;
	}
	while (
		cursorOffset > 0 &&
		isPromptInputWordCharacter(value[cursorOffset - 1])
	) {
		cursorOffset -= 1;
	}
	if (
		cursorOffset === clampCursorOffset(value, edit.cursorOffset) &&
		cursorOffset > 0
	) {
		cursorOffset -= 1;
	}
	return { value, cursorOffset };
}

export function movePromptInputCursorWordRight(
	edit: PromptInputEdit,
): PromptInputEdit {
	const value = edit.value;
	let cursorOffset = clampCursorOffset(value, edit.cursorOffset);
	const startOffset = cursorOffset;
	while (
		cursorOffset < value.length &&
		isPromptInputWordCharacter(value[cursorOffset])
	) {
		cursorOffset += 1;
	}
	while (
		cursorOffset < value.length &&
		isPromptInputWhitespace(value[cursorOffset])
	) {
		cursorOffset += 1;
	}
	if (cursorOffset === startOffset && cursorOffset < value.length) {
		cursorOffset += 1;
	}
	return { value, cursorOffset };
}

export function movePromptInputCursorToLineStart(
	edit: PromptInputEdit,
): PromptInputEdit {
	const position = promptInputCursorPosition(edit.value, edit.cursorOffset);
	return {
		value: edit.value,
		cursorOffset: promptInputOffsetAtPosition(
			edit.value,
			position.lineIndex,
			0,
		),
	};
}

export function movePromptInputCursorToLineEnd(
	edit: PromptInputEdit,
): PromptInputEdit {
	const position = promptInputCursorPosition(edit.value, edit.cursorOffset);
	const line = promptInputLines(edit.value)[position.lineIndex] ?? "";
	return {
		value: edit.value,
		cursorOffset: promptInputOffsetAtPosition(
			edit.value,
			position.lineIndex,
			line.length,
		),
	};
}

export function movePromptInputCursorUp(
	edit: PromptInputEdit,
): PromptInputEdit {
	return movePromptInputCursorVertically(edit, -1);
}

export function movePromptInputCursorDown(
	edit: PromptInputEdit,
): PromptInputEdit {
	return movePromptInputCursorVertically(edit, 1);
}

export function promptInputCursorPosition(
	value: string,
	cursorOffset: number,
): PromptInputCursorPosition {
	const offset = clampCursorOffset(value, cursorOffset);
	let lineIndex = 0;
	let lineStart = 0;

	for (let index = 0; index < offset; index += 1) {
		if (value[index] === "\n") {
			lineIndex += 1;
			lineStart = index + 1;
		}
	}

	return {
		lineIndex,
		column: offset - lineStart,
	};
}

export function promptInputOffsetAtPosition(
	value: string,
	lineIndex: number,
	column: number,
): number {
	const targetLine = Math.max(0, lineIndex);
	let currentLine = 0;
	let lineStart = 0;
	while (currentLine < targetLine) {
		const newlineIndex = value.indexOf("\n", lineStart);
		if (newlineIndex === -1) return value.length;
		currentLine += 1;
		lineStart = newlineIndex + 1;
	}

	const lineEnd = nextLineEnd(value, lineStart);
	return Math.min(lineStart + Math.max(column, 0), lineEnd);
}

function movePromptInputCursorVertically(
	edit: PromptInputEdit,
	direction: -1 | 1,
): PromptInputEdit {
	const lines = promptInputLines(edit.value);
	const position = promptInputCursorPosition(edit.value, edit.cursorOffset);
	const targetLine = position.lineIndex + direction;
	if (targetLine < 0 || targetLine >= lines.length) {
		return {
			value: edit.value,
			cursorOffset: clampCursorOffset(edit.value, edit.cursorOffset),
		};
	}

	return {
		value: edit.value,
		cursorOffset: promptInputOffsetAtPosition(
			edit.value,
			targetLine,
			position.column,
		),
	};
}

function nextLineEnd(value: string, lineStart: number): number {
	const newlineIndex = value.indexOf("\n", lineStart);
	return newlineIndex === -1 ? value.length : newlineIndex;
}

function clampCursorOffset(value: string, cursorOffset: number): number {
	return Math.max(0, Math.min(cursorOffset, value.length));
}
