import { describe, expect, it } from "bun:test";
import { RunBudget, RunTimeoutError } from "../src/core/agent/RunBudget.ts";
import { SubAgentRunner } from "../src/core/agent/SubAgentRunner.ts";
import type { AgentDefinition } from "../src/core/agents/AgentDefinition.ts";
import { BackboardClient } from "../src/providers/backboard/BackboardClient.ts";
import type {
	ProviderEvent,
	SendMessageRequest,
} from "../src/providers/backboard/types.ts";
import { TEST_BACKBOARD_ENV, TEST_MODEL } from "./helpers/agent.ts";

const sleep = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

function definition(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
	return {
		name: "slowpoke",
		description: "d",
		mode: "worker",
		systemPrompt: "you are a sub-agent",
		source: "project",
		...overrides,
	};
}

/**
 * Streams a partial answer, then stalls past the budget. The follow-up
 * (summary) request answers immediately.
 */
class StallingClient extends BackboardClient {
	requests: SendMessageRequest[] = [];

	constructor(private readonly stallMs: number) {
		super(TEST_BACKBOARD_ENV);
	}

	override async *runMessage(
		req: SendMessageRequest,
		options: { signal?: AbortSignal } = {},
	): AsyncIterable<ProviderEvent> {
		this.requests.push(req);
		yield { kind: "thread", threadId: "thr_sub" };

		if (this.requests.length > 1) {
			yield {
				kind: "assistant_delta",
				text: "partial findings, then time ran out",
			};
			yield { kind: "completed" };
			return;
		}

		yield { kind: "assistant_delta", text: "started investigating" };
		await sleep(this.stallMs);
		if (options.signal?.aborted) throw new Error("aborted");
		yield { kind: "completed" };
	}

	override async *runToolOutputs(): AsyncIterable<ProviderEvent> {
		yield { kind: "completed" };
	}
}

function runnerWith(client: BackboardClient): SubAgentRunner {
	return new SubAgentRunner({
		client,
		getModel: () => TEST_MODEL,
		memory: "off",
		memoryProfile: "code",
		getThinking: async () => undefined,
		toolFactory: () => [],
	});
}

describe("RunBudget", () => {
	it("expires on its own deadline and reports timedOut", async () => {
		const budget = RunBudget.start(new AbortController().signal, 10);
		await sleep(30);
		expect(budget.timedOut).toBe(true);
		expect(budget.signal.aborted).toBe(true);
		expect(() => budget.throwIfExpired()).toThrow(RunTimeoutError);
		budget.dispose();
	});

	it("does not report timedOut when the parent cancels", () => {
		const controller = new AbortController();
		const budget = RunBudget.start(controller.signal, 10_000);
		controller.abort();
		expect(budget.signal.aborted).toBe(true);
		expect(budget.timedOut).toBe(false);
		budget.dispose();
	});

	it("treats an already-aborted parent as an immediate abort, not a timeout", () => {
		const controller = new AbortController();
		controller.abort();
		const budget = RunBudget.start(controller.signal, 10_000);
		expect(budget.signal.aborted).toBe(true);
		expect(budget.timedOut).toBe(false);
		budget.dispose();
	});

	it("counts down remainingMs and leaves it unset without a budget", () => {
		const unbounded = RunBudget.start(new AbortController().signal);
		expect(unbounded.remainingMs).toBeUndefined();
		unbounded.dispose();

		const bounded = RunBudget.start(new AbortController().signal, 5_000);
		const remaining = bounded.remainingMs ?? 0;
		expect(remaining).toBeGreaterThan(0);
		expect(remaining).toBeLessThanOrEqual(5_000);
		bounded.dispose();
	});
});

describe("SubAgentRunner timeouts", () => {
	it("summarizes partial progress instead of discarding a timed-out run", async () => {
		const client = new StallingClient(500);
		const result = await runnerWith(client).run({
			prompt: "investigate",
			definition: definition({ timeoutMs: 40 }),
			depth: 1,
			parentCwd: process.cwd(),
			parentSignal: new AbortController().signal,
		});

		expect(result.status).toBe("timed_out");
		expect(result.report).toBe("partial findings, then time ran out");
		// Two requests: the timed-out run, then the bounded summary turn.
		expect(client.requests).toHaveLength(2);
		expect(client.requests[1]?.content).toContain("time budget expired");
		expect(client.requests[1]?.tools ?? []).toEqual([]);
	});

	it("reports cancelled, not timed_out, when the parent aborts", async () => {
		const client = new StallingClient(500);
		const controller = new AbortController();
		const run = runnerWith(client).run({
			prompt: "investigate",
			definition: definition({ timeoutMs: 10_000 }),
			depth: 1,
			parentCwd: process.cwd(),
			parentSignal: controller.signal,
		});
		await sleep(30);
		controller.abort();

		const result = await run;
		expect(result.status).toBe("cancelled");
		// No summary turn: the user asked for it to stop.
		expect(client.requests).toHaveLength(1);
	});

	it("runs without a deadline when the definition sets no timeout", async () => {
		const client = new StallingClient(1);
		const result = await runnerWith(client).run({
			prompt: "investigate",
			definition: definition(),
			depth: 1,
			parentCwd: process.cwd(),
			parentSignal: new AbortController().signal,
		});

		expect(result.status).toBe("completed");
		expect(client.requests).toHaveLength(1);
	});
});
