import { shortId } from "../../utils/id.ts";
import type { TodoItem } from "../bus/events.ts";
import type { Message } from "../session/Message.ts";
import { canonicalToolName } from "../tools/names.ts";
import type { TodoDraft } from "./types.ts";

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
			const todos = todoItemsFromInput(call.input);
			return areTodosComplete(todos) ? [] : todos;
		}
	}
	return [];
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
	return todos;
}
