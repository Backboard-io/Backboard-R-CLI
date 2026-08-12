import type { Key } from "ink";
import type { PromptInputMoveDirection, PromptSubmitIntent } from "./types.ts";

export type PromptInputPlatform =
	| "darwin"
	| "win32"
	| "linux"
	| NodeJS.Platform;

export type PromptInputKeyAction =
	| { kind: "completeSuggestion" }
	| { kind: "deleteNextCharacter" }
	| { kind: "deleteBeforeCursorOnLine" }
	| { kind: "deletePreviousCharacter" }
	| { kind: "deletePreviousWord" }
	| { kind: "historyOrMoveUp" }
	| { kind: "historyOrMoveDown" }
	| { kind: "ignore" }
	| { kind: "insertNewline" }
	| { kind: "insertText"; text: string }
	| { kind: "moveCursor"; direction: PromptInputMoveDirection }
	| { kind: "pasteClipboardImage" }
	| { kind: "submit"; intent: PromptSubmitIntent }
	| { kind: "slashCompletion" }
	| { kind: "backslashEnterNewline" };

export interface PromptInputKeyContext {
	busy: boolean;
	cursorOffset: number;
	platform: PromptInputPlatform;
	suggestionsVisible: boolean;
	value: string;
}

export type PromptInputKey = Key;

export type { PromptInputMoveDirection, PromptSubmitIntent } from "./types.ts";
