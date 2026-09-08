import type { SubmitToolOutputsRequest } from "../../../providers/backboard/types.ts";
import type { TodoItem } from "../../bus/events.ts";
import { canonicalToolName } from "../../tools/names.ts";
import type { ToolOutput } from "../../tools/ToolScheduler.ts";
import { TodoSchedule } from "./TodoSchedule.ts";
import { TurnTimer } from "./TurnTimer.ts";

/** Decorates outbound copies only. Local results and error prefixes stay intact. */
export class TurnTiming {
	private readonly timer: TurnTimer;
	private readonly schedule = new TodoSchedule();

	constructor(seconds: number, startedAt: number) {
		this.timer = new TurnTimer(seconds * 1000, startedAt);
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
		const todoUpdated = outputs.some(
			(output) =>
				output.metadata &&
				!output.metadata.error &&
				canonicalToolName(output.metadata.name) ===
					canonicalToolName("TodoWrite"),
		);
		const todoNote = todoUpdated
			? this.schedule.onUpdate(todos, this.timer, now)
			: null;
		for (const note of [timerNote, todoNote]) {
			if (note) last.output += `\n\n${note}`;
		}
		return wire;
	}
}
