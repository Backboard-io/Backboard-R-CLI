import { promptInputCursorPosition } from "./PromptInputEditing.ts";
import type { PromptHistoryState, PromptInputEdit } from "./types.ts";

export function emptyPromptHistoryState(): PromptHistoryState {
	return { entries: [], index: null, draft: "" };
}

export function recordPromptHistory(
	history: PromptHistoryState,
	submitted: string,
): PromptHistoryState {
	if (!submitted) return { ...history, index: null, draft: "" };
	const entries =
		history.entries.at(-1) === submitted
			? history.entries
			: [...history.entries, submitted];
	return { entries, index: null, draft: "" };
}

export function shouldRecallPromptHistoryOnUp(
	history: PromptHistoryState,
	edit: PromptInputEdit,
	suggestionsVisible = false,
): boolean {
	if (history.index !== null) return true;
	if (suggestionsVisible) return false;
	return (
		history.entries.length > 0 &&
		promptInputCursorPosition(edit.value, edit.cursorOffset).lineIndex === 0
	);
}

export function previousPromptHistory(
	history: PromptHistoryState,
	currentValue: string,
): { history: PromptHistoryState; value: string } {
	if (history.entries.length === 0) return { history, value: currentValue };
	const index =
		history.index === null
			? history.entries.length - 1
			: Math.max(0, history.index - 1);
	const nextHistory = {
		entries: history.entries,
		index,
		draft: history.index === null ? currentValue : history.draft,
	};
	return {
		history: nextHistory,
		value: history.entries[index] ?? currentValue,
	};
}

export function nextPromptHistory(history: PromptHistoryState): {
	history: PromptHistoryState;
	value: string;
} {
	if (history.index === null) return { history, value: history.draft };
	if (history.index < history.entries.length - 1) {
		const index = history.index + 1;
		return {
			history: { ...history, index },
			value: history.entries[index] ?? history.draft,
		};
	}
	return {
		history: { entries: history.entries, index: null, draft: "" },
		value: history.draft,
	};
}
