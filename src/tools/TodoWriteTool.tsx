import { z } from "zod";
import type { TodoItem } from "../core/bus/events.ts";
import type { PermissionDecision } from "../core/permissions/types.ts";
import { reconcileTodos } from "../core/todos/TodoList.ts";
import { Tool } from "../core/tools/Tool.ts";
import type { ToolContext } from "../core/tools/ToolContext.ts";
import { ok, type ToolResult } from "../core/tools/ToolResult.ts";
import type { PromptContext } from "../prompts/PromptModule.ts";
import { getToolPrompt } from "../prompts/tools/index.tsx";

const todoSchema = z.object({
	content: z
		.string()
		.trim()
		.min(1)
		.max(500)
		.describe("A specific task description string."),
	status: z
		.enum(["pending", "in_progress", "completed"])
		.describe("One of pending, in_progress, or completed."),
});

const schema = z
	.object({
		todos: z
			.array(todoSchema)
			.max(50)
			.describe(
				"The updated todo list as an array of { content, status } objects",
			),
	})
	.superRefine((input, ctx) => {
		const activeCount = input.todos.filter(
			(todo) => todo.status === "in_progress",
		).length;
		const pendingCount = input.todos.filter(
			(todo) => todo.status === "pending",
		).length;
		if (activeCount > 1) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "TodoWrite accepts at most one in_progress todo.",
				path: ["todos"],
			});
		}
		if (pendingCount > 0 && activeCount === 0) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message:
					"TodoWrite requires one in_progress todo when pending todos remain.",
				path: ["todos"],
			});
		}
	});

type Input = z.infer<typeof schema>;

interface Output {
	count: number;
}

/**
 * Reads the reconciled list back to the model as `[status] content` items, so
 * it sees its own plan's ground-truth state after reconciliation (ids/omitted
 * items resolved) and can steer against it - not just a bare completed count.
 */
export function formatTodoReadback(todos: readonly TodoItem[]): string {
	if (todos.length === 0) return "Updated 0 todos";
	const items = todos
		.map((todo) => `[${todo.status}] ${todo.content}`)
		.join(", ");
	return `Updated ${todos.length} todos: ${items}`;
}

export class TodoWriteTool extends Tool<Input, Output> {
	readonly name = "TodoWrite";
	readonly inputSchema = schema;

	override prompt(context: PromptContext = {}): string {
		return getToolPrompt(this.name, context);
	}

	override isReadOnly(): boolean {
		return false;
	}

	override isConcurrencySafe(): boolean {
		return false;
	}

	override checkPermissions(): PermissionDecision | undefined {
		return { behavior: "allow", reason: "internal tool" };
	}

	override async execute(
		input: Input,
		ctx: ToolContext,
	): Promise<ToolResult<Output>> {
		const todos: TodoItem[] = reconcileTodos(
			input.todos,
			ctx.getTodos?.() ?? [],
		);

		ctx.bus.emit({ type: "todos:updated", todos });

		const readback = formatTodoReadback(todos);
		return ok({ count: todos.length }, readback, readback);
	}
}
