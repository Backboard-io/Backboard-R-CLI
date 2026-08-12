import { shortId } from "../../utils/id.ts";
import type { TodoItem } from "../bus/events.ts";
import type { Message } from "../session/Message.ts";
import { canonicalToolName } from "../tools/names.ts";
import type { TodoDraft } from "./types.ts";

/**
 * Models occasionally emit a structurally valid list with no active item, or
 * more than one. Keep the provider contract forgiving while making the stored
 * UI state deterministic: pending work always has exactly one active item.
 */
export function normalizeTodoDrafts(drafts: readonly TodoDraft[]): TodoDraft[] {
	const normalized = drafts.map((draft) => ({ ...draft }));
	const activeIndexes = normalized.flatMap((todo, index) =>
		todo.status === "in_progress" ? [index] : [],
	);

	if (activeIndexes.length > 1) {
		for (const index of activeIndexes.slice(1)) {
			const todo = normalized[index];
			if (todo) todo.status = "pending";
		}
	}

	const hasActive = normalized.some((todo) => todo.status === "in_progress");
	if (!hasActive) {
		const firstPending = normalized.find((todo) => todo.status === "pending");
		if (firstPending) firstPending.status = "in_progress";
	}
	return normalized;
}

/**
 * Preserve completion transitions for existing todos, but do not let a model
 * introduce brand-new work as already complete.
 */
export function normalizeTodoUpdate(
	drafts: readonly TodoDraft[],
	previousTodos: readonly TodoItem[],
): TodoDraft[] {
	const previousContents = new Set(previousTodos.map((todo) => todo.content));
	return normalizeTodoDrafts(
		drafts.map((draft) =>
			draft.status === "completed" && !previousContents.has(draft.content)
				? { ...draft, status: "pending" }
				: draft,
		),
	);
}

export function reconcileTodos(
	drafts: readonly TodoDraft[],
	previousTodos: readonly TodoItem[],
): TodoItem[] {
	const previousByContent = new Map<string, TodoItem[]>();
	for (const todo of previousTodos) {
		const existing = previousByContent.get(todo.content);
		if (existing) {
			existing.push(todo);
		} else {
			previousByContent.set(todo.content, [todo]);
		}
	}

	return drafts.map((draft) => {
		const previous = previousByContent.get(draft.content)?.shift();
		return {
			id: previous?.id ?? shortId("todo"),
			content: draft.content,
			status: draft.status,
		};
	});
}

export function areTodosComplete(todos: readonly TodoItem[]): boolean {
	return todos.length > 0 && todos.every((todo) => todo.status === "completed");
}

export function todosFromMessages(messages: readonly Message[]): TodoItem[] {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message?.role !== "assistant") continue;
		for (let j = message.toolCalls.length - 1; j >= 0; j--) {
			const call = message.toolCalls[j];
			if (!call || canonicalToolName(call.name) !== "todo_write") continue;
			const matchingResult = findToolResult(messages, i + 1, call.id);
			if (!matchingResult || matchingResult.isError) continue;
			const todos = todoItemsFromInput(call.input);
			return areTodosComplete(todos) ? [] : todos;
		}
	}
	return [];
}

function findToolResult(
	messages: readonly Message[],
	startIndex: number,
	toolCallId: string,
) {
	for (let i = startIndex; i < messages.length; i++) {
		const message = messages[i];
		if (message?.role !== "tool") break;
		const result = message.results.find(
			(candidate) => candidate.toolCallId === toolCallId,
		);
		if (result) return result;
	}
	return undefined;
}

function todoItemsFromInput(input: unknown): TodoItem[] {
	if (!input || typeof input !== "object") return [];
	const drafts = (input as { todos?: unknown }).todos;
	if (!Array.isArray(drafts)) return [];
	const todos: TodoItem[] = [];
	for (const draft of drafts) {
		if (!draft || typeof draft !== "object") continue;
		const { content, status } = draft as {
			content?: unknown;
			status?: unknown;
		};
		if (typeof content !== "string" || content.length === 0) continue;
		if (
			status !== "pending" &&
			status !== "in_progress" &&
			status !== "completed"
		)
			continue;
		todos.push({ id: shortId("todo"), content, status });
	}
	return normalizeTodoDrafts(todos).map((todo) => ({
		id: shortId("todo"),
		...todo,
	}));
}
