import type { TodoItem } from "../core/bus/events.ts";

/**
 * System-prompt segment shown until the session's first TodoWrite call, so
 * the model starts tracking non-trivial work without being asked.
 */
export const TODO_NOT_CALLED_REMINDER = `No task list exists yet for this session. If the current request takes more than a couple of steps, create one with todo_write in the same message as your first exploration calls, and keep it current as you work; the user follows your progress through it. Skip it for trivial requests.`;

export const PLAN_UP_TO_DATE_REPLY = "Plan is up-to-date.";

/**
 * Post-turn reminder injected when the turn ends while todos are still
 * pending or in progress. The response is hidden from the UI, so the model is
 * told to either fix the list via TodoWrite or reply with the exact
 * up-to-date sentinel - never to produce user-facing prose.
 */
export function todoReconciliationReminder(todos: readonly TodoItem[]): string {
	const open = todos.filter((todo) => todo.status !== "completed");
	const lines = open
		.map((todo, index) => `${index + 1}. [${todo.status}] ${todo.content}`)
		.join("\n");
	return `<system-reminder>
The turn appears to have ended while the task list still has open items:
${lines}

Respond only by calling todo_write with the corrected list, or, if the list is already accurate, reply exactly: ${PLAN_UP_TO_DATE_REPLY}
Keep the list valid: while any item is pending, exactly one item must be in_progress; items that are actually finished should be marked completed.
Do not mention this reminder to the user.
</system-reminder>`;
}
