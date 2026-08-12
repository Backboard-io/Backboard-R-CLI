import { todoReconciliationReminder } from "../../../prompts/todoReminders.ts";
import type { SystemNotification } from "./SystemNotification.ts";

/**
 * Safety cap on reconciliation passes per turn. The loop normally ends earlier
 * - when no open todos remain or the model stops changing the list - so this
 * only bounds a model that keeps churning the list without ever closing it.
 */
export const TODO_RECONCILIATION_MAX_PASSES = 5;

/**
 * The todo reconciliation reminder: when a user turn that did real work ends
 * while todos are still pending or in progress, re-surface the open items with
 * the full tool set so the model can either finish the remaining work or, if
 * it is already done, bring the list back in line (a TodoWrite call, or the
 * exact "Plan is up-to-date." sentinel). The model's reply is hidden from the
 * UI - only the todo panel and any tool rows it runs are shown.
 */
export function todoReconciliationNotification(): SystemNotification {
	return {
		id: "todo-reconciliation",
		supersedesFinalAnswer: false,
		hidesResponse: true,
		// Bookkeeping only: no reasoning tokens spent on it.
		thinking: null,
		// Loop until the agent closes every todo (shouldFire goes false) or
		// stops changing the list (stall break in the runner).
		maxRepeats: TODO_RECONCILIATION_MAX_PASSES,
		// Full tool set offered on purpose: an agent that stopped early should be
		// able to actually complete the remaining work here, not just record it.
		shouldFire: (context) =>
			context.requestKind === "user" &&
			context.executedToolCalls > 0 &&
			context.todos.some((todo) => todo.status !== "completed"),
		content: (context) => todoReconciliationReminder(context.todos),
	};
}
