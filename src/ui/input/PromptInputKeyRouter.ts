import { MODIFIED_ENTER_SEQUENCES } from "./PromptInput.constants.ts";
import type {
	PromptInputKey,
	PromptInputKeyAction,
	PromptInputKeyContext,
} from "./PromptInputKeyRouter.types.ts";

export function resolvePromptInputKeyAction(
	input: string,
	key: PromptInputKey,
	context: PromptInputKeyContext,
): PromptInputKeyAction {
	const modifiedEnterCount = modifiedEnterSequenceCount(input);
	if (modifiedEnterCount > 0) {
		return { kind: "insertText", text: "\n".repeat(modifiedEnterCount) };
	}

	if (key.ctrl && input === "c") return { kind: "ignore" };
	const readlineMove = readlineCursorMove(input, key);
	if (readlineMove) return { kind: "moveCursor", direction: readlineMove };

	if (context.platform === "darwin" && key.ctrl && input === "u") {
		return { kind: "deleteBeforeCursorOnLine" };
	}

	if (key.ctrl && input === "v") {
		return { kind: "pasteClipboardImage" };
	}

	if (isDeletePreviousWord(input, key, context.platform)) {
		return { kind: "deletePreviousWord" };
	}

	if (context.busy && key.tab) {
		return { kind: "submit", intent: "queue" };
	}

	if (context.suggestionsVisible && key.tab) {
		return { kind: "completeSuggestion" };
	}

	if (context.suggestionsVisible && key.return && !key.shift) {
		return { kind: "submit", intent: "send" };
	}

	if (key.return) {
		if (key.shift) return { kind: "insertNewline" };
		if (context.value[context.cursorOffset - 1] === "\\") {
			return { kind: "backslashEnterNewline" };
		}
		return { kind: "submit", intent: context.busy ? "steer" : "send" };
	}

	if (key.leftArrow) {
		return {
			kind: "moveCursor",
			direction: modifiedArrowDirection("left", key, context.platform),
		};
	}
	if (key.rightArrow) {
		return {
			kind: "moveCursor",
			direction: modifiedArrowDirection("right", key, context.platform),
		};
	}
	if (key.upArrow) return { kind: "historyOrMoveUp" };
	if (key.downArrow) return { kind: "historyOrMoveDown" };
	if (key.home) return { kind: "moveCursor", direction: "lineStart" };
	if (key.end) return { kind: "moveCursor", direction: "lineEnd" };

	if (key.backspace) return { kind: "deletePreviousCharacter" };
	if (key.delete) return { kind: "deleteNextCharacter" };
	if (input === "/") return { kind: "slashCompletion" };
	if (key.tab || key.escape || input.length === 0) return { kind: "ignore" };
	return { kind: "insertText", text: input };
}

function readlineCursorMove(
	input: string,
	key: PromptInputKey,
): "lineStart" | "lineEnd" | "wordLeft" | "wordRight" | null {
	if (key.ctrl && input === "a") return "lineStart";
	if (key.ctrl && input === "e") return "lineEnd";
	if ((key.meta || key.ctrl) && input === "b") return "wordLeft";
	if ((key.meta || key.ctrl) && input === "f") return "wordRight";
	return null;
}

function modifiedArrowDirection(
	direction: "left" | "right",
	key: PromptInputKey,
	platform: NodeJS.Platform,
): "left" | "right" | "lineStart" | "lineEnd" | "wordLeft" | "wordRight" {
	if (platform === "darwin" && key.super) {
		return direction === "left" ? "lineStart" : "lineEnd";
	}
	if (key.meta || key.ctrl) {
		return direction === "left" ? "wordLeft" : "wordRight";
	}
	return direction;
}

function modifiedEnterSequenceCount(input: string): number {
	if (!input) return 0;
	let rest = input;
	let count = 0;
	while (rest.length > 0) {
		const sequence = MODIFIED_ENTER_SEQUENCES.find((candidate) =>
			rest.startsWith(candidate),
		);
		if (!sequence) return 0;
		count += 1;
		rest = rest.slice(sequence.length);
	}
	return count;
}

function isDeletePreviousWord(
	input: string,
	key: PromptInputKey,
	platform: NodeJS.Platform,
): boolean {
	if (key.ctrl && input === "w") return true;
	if (platform === "darwin") {
		return key.backspace && (key.super || key.meta);
	}
	if (key.ctrl && key.backspace) return true;
	return false;
}
