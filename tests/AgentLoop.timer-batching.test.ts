import { describe, expect, it, spyOn } from "bun:test";
import { AgentLoop } from "../src/core/agent/AgentLoop.ts";
import { EventBus } from "../src/core/bus/EventBus.ts";
import type { ToolCallRef } from "../src/core/bus/events.ts";
import { Session } from "../src/core/session/Session.ts";
import { ToolRegistry } from "../src/core/tools/ToolRegistry.ts";
import { ToolScheduler } from "../src/core/tools/ToolScheduler.ts";
import type { AgentClient } from "../src/providers/AgentClient.ts";
import type {
	ProviderEvent,
	SubmitToolOutputsRequest,
} from "../src/providers/backboard/types.ts";
import { TodoWriteTool } from "../src/tools/TodoWriteTool.tsx";
import { makeContext, TestTool } from "./helpers.ts";

const update = (
	id: string,
	status: "in_progress" | "completed",
): ToolCallRef => ({
	id,
	name: "todo_write",
	input: { todos: [{ content: "Implement", status, timeBudgetSeconds: 180 }] },
});
const work: ToolCallRef = { id: "work", name: "Execute", input: {} };

async function runRounds(
	rounds: ToolCallRef[][],
): Promise<SubmitToolOutputsRequest[]> {
	let now = 1_000_000;
	const clock = spyOn(Date, "now").mockImplementation(() => now);
	const bus = new EventBus();
	const session = new Session("timer-batching");
	const detach = session.attach(bus);
	const results: SubmitToolOutputsRequest[] = [];
	let nextRound = 0;
	const events = function* (): Generator<ProviderEvent> {
		const calls = rounds[nextRound++];
		if (calls) yield { kind: "requires_action", runId: "run", calls };
		else yield { kind: "completed" };
	};
	const client = {
		async *runMessage(): AsyncIterable<ProviderEvent> {
			yield { kind: "thread", threadId: "thread" };
			yield* events();
		},
		async *runToolOutputs(
			request: SubmitToolOutputsRequest,
		): AsyncIterable<ProviderEvent> {
			results.push(request);
			yield* events();
		},
	} as unknown as AgentClient;
	const registry = new ToolRegistry([
		new TodoWriteTool(),
		new TestTool({
			name: "Execute",
			readOnly: false,
			onStart: () => {
				now += 180_000;
			},
		}),
	]);
	try {
		const loop = new AgentLoop({
			client,
			bus,
			session,
			scheduler: new ToolScheduler(registry, bus),
			tools: [],
			systemPrompt: "static",
			model: { provider: "test", model: "test" },
			memory: "off",
			memoryProfile: "default",
			thinking: undefined,
			timerSeconds: 900,
			turnStartedAt: now,
		});
		expect(
			await loop.run("Fix it", {
				...makeContext(new AbortController().signal, bus),
				getTodos: () => session.todos,
			}),
		).toBe("completed");
		expect(JSON.stringify(session.getMessages())).not.toContain(
			"Previous step:",
		);
		return results;
	} finally {
		detach();
		clock.mockRestore();
	}
}

describe("timer accounting across real tool batches", () => {
	it("includes work batched after activation in the step's elapsed time", async () => {
		const results = await runRounds([
			[update("start", "in_progress"), work],
			[update("done", "completed")],
		]);
		expect(results[1]?.tool_outputs[0]?.output).toContain(
			"Previous step: planned 3m, took 3m.",
		);
	});

	it("retains transitions completed within one tool round", async () => {
		const results = await runRounds([
			[update("start", "in_progress"), work, update("done", "completed")],
		]);
		expect(results[0]?.tool_outputs.at(-1)?.output).toContain(
			"Previous step: planned 3m, took 3m.",
		);
		expect(results[0]?.tool_outputs.at(-1)?.output).toContain("1/1 steps done");
	});
});
