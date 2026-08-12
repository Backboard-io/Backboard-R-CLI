export type PromptSubmitIntent = "send" | "steer" | "queue";

export type PromptInputMoveDirection =
	| "left"
	| "right"
	| "up"
	| "down"
	| "lineStart"
	| "lineEnd"
	| "wordLeft"
	| "wordRight";

export interface QueuedPromptItem {
	id: string;
	text: string;
}

export interface PromptInputEdit {
	value: string;
	cursorOffset: number;
}

export interface PromptHistoryState {
	entries: readonly string[];
	index: number | null;
	draft: string;
}

export interface PromptInputCursorPosition {
	lineIndex: number;
	column: number;
}
