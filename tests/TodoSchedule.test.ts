import { describe, expect, it } from "bun:test";
import { TodoSchedule } from "../src/core/agent/timing/TodoSchedule.ts";
import { TurnTimer } from "../src/core/agent/timing/TurnTimer.ts";
import type { TodoItem } from "../src/core/bus/events.ts";
import {
	timerReminder,
	todoProgressNotice,
} from "../src/prompts/timerPrompt.ts";

const START = 1_000_000;
const timer = () => new TurnTimer(900_000, START);
const todo = (
	id: string,
	status: TodoItem["status"],
	timeBudgetSeconds?: number,
): TodoItem => ({
	id,
	content: id,
	status,
	...(timeBudgetSeconds === undefined ? {} : { timeBudgetSeconds }),
});

function createSchedule() {
	const schedule = new TodoSchedule();
	return {
		onUpdate(
			todos: readonly TodoItem[],
			budget: TurnTimer | undefined,
			now: number,
		) {
			const lines = schedule.recordUpdate(todos, budget, now);
			if (!budget || lines.length === 0) return null;
			return timerReminder([
				...lines,
				todoProgressNotice(
					todos.filter((todo) => todo.status === "completed").length,
					todos.length,
					budget.remainingMs(now),
					budget.totalBudgetMs,
					todos
						.filter((todo) => todo.status !== "completed")
						.reduce(
							(sum, todo) => sum + (todo.timeBudgetSeconds ?? 0) * 1000,
							0,
						),
				),
			]);
		},
	};
}

describe("TodoSchedule", () => {
	it("requires a timer and at least one allocation", () => {
		const schedule = createSchedule();
		expect(
			schedule.onUpdate([todo("a", "in_progress", 60)], undefined, START),
		).toBeNull();
		expect(
			schedule.onUpdate([todo("a", "in_progress")], timer(), START),
		).toBeNull();
	});

	it("waits for transitions and reports actual time against the original allowance", () => {
		const schedule = createSchedule();
		const t = timer();
		expect(
			schedule.onUpdate(
				[todo("a", "in_progress", 180), todo("b", "pending", 300)],
				t,
				START,
			),
		).toBeNull();
		expect(
			schedule.onUpdate(
				[todo("a", "in_progress", 600), todo("b", "pending", 300)],
				t,
				START + 60_000,
			),
		).toBeNull();
		const note = schedule.onUpdate(
			[todo("a", "completed", 600), todo("b", "in_progress", 300)],
			t,
			START + 480_000,
		);
		expect(note).toContain("Previous step: planned 3m, took 8m.");
		expect(note).toContain(
			"1/2 steps done. 7m of the 15m budget remains; remaining steps are allotted 5m.",
		);
		for (const instruction of [
			"move on",
			"you should",
			"hurry",
			"speed up",
			"stop",
			"must",
		]) {
			expect(note?.toLowerCase()).not.toContain(instruction);
		}
		expect(note).toContain("No reply needed.");
	});

	it("reports a moved-off step without claiming completion", () => {
		const schedule = createSchedule();
		const t = timer();
		schedule.onUpdate([todo("a", "in_progress", 120)], t, START);
		const note = schedule.onUpdate(
			[todo("a", "pending", 120), todo("b", "in_progress", 120)],
			t,
			START + 48_000,
		);
		expect(note).toContain("The step you moved off: planned 2m, took 48s.");
		expect(note).toContain("0/2 steps done");
	});

	it("reports the final step when no active todo remains", () => {
		const schedule = createSchedule();
		const t = timer();
		schedule.onUpdate([todo("a", "in_progress", 60)], t, START);
		expect(
			schedule.onUpdate([todo("a", "completed", 60)], t, START + 30_000),
		).toContain(
			"1/1 steps done. 14m of the 15m budget remains; remaining steps are allotted 0s.",
		);
	});

	it("flags overcommit only once and tolerates planning overhead", () => {
		const schedule = createSchedule();
		const t = timer();
		expect(
			schedule.onUpdate(
				[todo("a", "in_progress", 450), todo("b", "pending", 450)],
				t,
				START + 60_000,
			),
		).toBeNull();
		const plan = [todo("a", "in_progress", 600), todo("b", "pending", 600)];
		expect(schedule.onUpdate(plan, t, START + 70_000)).toContain(
			"Your steps allot 20m but 13m remains.",
		);
		expect(schedule.onUpdate(plan, t, START + 80_000)).toBeNull();
	});

	it("does not count completed allocations as future work", () => {
		const schedule = createSchedule();
		const t = timer();
		const plan = (active: number) =>
			["a", "b", "c", "d", "e"].map((id, i) =>
				todo(
					id,
					i < active ? "completed" : i === active ? "in_progress" : "pending",
					180,
				),
			);
		schedule.onUpdate(plan(0), t, START);
		expect(schedule.onUpdate(plan(4), t, START + 720_000)).not.toContain(
			"Your steps allot",
		);
	});

	it("tracks distinct IDs even when step titles match", () => {
		const schedule = createSchedule();
		const t = timer();
		const a = { ...todo("a", "in_progress", 180), content: "run tests" };
		const b = { ...todo("b", "pending", 600), content: "run tests" };
		schedule.onUpdate([a, b], t, START);
		expect(
			schedule.onUpdate(
				[
					{ ...a, status: "completed" },
					{ ...b, status: "in_progress" },
				],
				t,
				START + 60_000,
			),
		).toContain("planned 3m, took 60s");
	});

	it("re-arms across unbudgeted replans and forgets cleared plans", () => {
		const schedule = createSchedule();
		const t = timer();
		schedule.onUpdate([todo("a", "in_progress", 180)], t, START);
		expect(
			schedule.onUpdate([todo("b", "in_progress")], t, START + 300_000),
		).toBeNull();
		expect(
			schedule.onUpdate(
				[todo("b", "completed"), todo("c", "in_progress", 120)],
				t,
				START + 420_000,
			),
		).toContain("Previous step took 2m.");
		expect(schedule.onUpdate([], t, START + 430_000)).toBeNull();
		expect(
			schedule.onUpdate([todo("d", "in_progress", 60)], t, START + 440_000),
		).toBeNull();
	});
});
