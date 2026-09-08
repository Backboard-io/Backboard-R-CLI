import { describe, expect, it } from "bun:test";
import { TurnTiming } from "../src/core/agent/timing/TurnTiming.ts";
import type { TodoItem } from "../src/core/bus/events.ts";
import type { ToolOutput } from "../src/core/tools/ToolScheduler.ts";

const START = 1_000_000;
function output(name: string, extra = {}): ToolOutput {
	return {
		tool_call_id: name,
		output: name,
		metadata: { name, readOnly: false, error: false, ...extra },
	};
}
const todo = (status: TodoItem["status"]): TodoItem => ({
	id: "a",
	content: "a",
	status,
	timeBudgetSeconds: 180,
});

describe("TurnTiming outbound decoration", () => {
	it("appends only to the last output without mutating the originals", () => {
		const timing = new TurnTiming(900, START);
		const originals = [
			output("read"),
			{ ...output("execute", { error: true }), output: "Error: failed" },
		];
		const wire = timing.append(originals, [], START + 450_000);
		expect(wire[0]).toEqual({ tool_call_id: "read", output: "read" });
		expect(wire[1]?.output).toStartWith(
			'Error: failed\n\n<system-reminder source="backboard-timer">',
		);
		expect(originals[1]?.output).toBe("Error: failed");
		expect(wire[1]).not.toHaveProperty("metadata");
	});

	it("does not consume thresholds on empty rounds", () => {
		const timing = new TurnTiming(900, START);
		expect(timing.append([], [], START + 450_000)).toEqual([]);
		expect(
			timing.append([output("read")], [], START + 450_000)[0]?.output,
		).toContain("Time check:");
	});

	it("recognizes successful wire-name TodoWrite calls and combines both notices", () => {
		const timing = new TurnTiming(900, START);
		timing.recordTodoUpdate("todo_write", [todo("in_progress")], START);
		timing.append([output("todo_write")], [todo("in_progress")], START);
		timing.recordTodoUpdate("todo_write", [todo("completed")], START + 480_000);
		const wire = timing.append(
			[output("todo_write"), output("read")],
			[todo("completed")],
			START + 480_000,
		);
		expect(wire[0]?.output).toBe("todo_write");
		expect(wire[1]?.output).toContain("Time check: 7m");
		expect(wire[1]?.output).toContain("Previous step: planned 3m, took 8m.");
	});

	it("does not start schedule tracking from a failed todo update", () => {
		const timing = new TurnTiming(900, START);
		timing.recordTodoUpdate("todo_write", [todo("in_progress")], START);
		timing.append(
			[output("todo_write", { error: true })],
			[todo("in_progress")],
			START,
		);
		timing.recordTodoUpdate("todo_write", [todo("completed")], START + 60_000);
		const wire = timing.append(
			[output("todo_write")],
			[todo("completed")],
			START + 60_000,
		);
		expect(wire[0]?.output).not.toContain("Previous step");
	});

	it("reports current time when a tool returns work still running", () => {
		const timing = new TurnTiming(900, START);
		expect(
			timing.append(
				[output("execute", { stillRunning: true })],
				[],
				START + 60_000,
			)[0]?.output,
		).toContain("Time check: 14m");
		expect(timing.append([output("read")], [], START + 60_000)[0]?.output).toBe(
			"read",
		);
	});
});
