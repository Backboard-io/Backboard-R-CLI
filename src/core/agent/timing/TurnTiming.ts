import {
	timerReminder,
	todoProgressNotice,
} from "../../../prompts/timerPrompt.ts";
import type { SubmitToolOutputsRequest } from "../../../providers/backboard/types.ts";
import type { TodoItem } from "../../bus/events.ts";
import { canonicalToolName } from "../../tools/names.ts";
import type { ToolOutput } from "../../tools/ToolScheduler.ts";
import { TodoSchedule } from "./TodoSchedule.ts";
import { TurnTimer } from "./TurnTimer.ts";
import type { TimedTodoUpdate } from "./types.ts";

/** Decorates outbound copies only. Local results and error prefixes stay intact. */
export class TurnTiming {
	private readonly timer: TurnTimer;
	private readonly schedule = new TodoSchedule();
	private readonly todoUpdates = new Map<string, TimedTodoUpdate>();

	constructor(seconds: number, startedAt: number) {
		this.timer = new TurnTimer(seconds * 1000, startedAt);
	}

	/** Called synchronously on the actual update, not after later batched tools. */
	recordTodoUpdate(
		toolCallId: string,
		todos: readonly TodoItem[],
		at = Date.now(),
	): void {
		this.todoUpdates.set(toolCallId, {
			todos: todos.map((todo) => ({ ...todo })),
			at,
		});
	}

	append(
		outputs: readonly ToolOutput[],
		todos: readonly TodoItem[],
		now = Date.now(),
	): SubmitToolOutputsRequest["tool_outputs"] {
		const wire = outputs.map(({ tool_call_id, output }) => ({
			tool_call_id,
			output,
		}));
		const last = wire.at(-1);
		if (!last) return wire;
		const timerNote = outputs.some((output) => output.metadata?.stillRunning)
			? this.timer.reportNow(now)
			: this.timer.nextReminder(now);
		const todoLines: string[] = [];
		let reportedTodos = todos;
		for (const output of outputs) {
			const update = this.todoUpdates.get(output.tool_call_id);
			this.todoUpdates.delete(output.tool_call_id);
			// Post-tool hooks can reject an update. Only commit successful calls.
			if (
				!update ||
				!output.metadata ||
				output.metadata.error ||
				canonicalToolName(output.metadata.name) !==
					canonicalToolName("TodoWrite")
			)
				continue;
			todoLines.push(
				...this.schedule.recordUpdate(update.todos, this.timer, update.at),
			);
			reportedTodos = update.todos;
		}
		const todoNote =
			todoLines.length === 0
				? null
				: timerReminder([
						...todoLines,
						todoProgressNotice(
							reportedTodos.filter((todo) => todo.status === "completed")
								.length,
							reportedTodos.length,
							this.timer.remainingMs(now),
							this.timer.totalBudgetMs,
							reportedTodos
								.filter((todo) => todo.status !== "completed")
								.reduce(
									(sum, todo) => sum + (todo.timeBudgetSeconds ?? 0) * 1000,
									0,
								),
						),
					]);
		for (const note of [timerNote, todoNote]) {
			if (note) last.output += `\n\n${note}`;
		}
		return wire;
	}
}
