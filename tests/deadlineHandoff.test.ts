import { describe, expect, it } from "bun:test";
import type { RuntimeThinkingResolver } from "../src/config/thinkingRuntime.ts";
import { BackgroundAgentSupervisor } from "../src/core/agent/BackgroundAgentSupervisor.ts";
import { RunBudget } from "../src/core/agent/RunBudget.ts";
import { SubAgentRunner } from "../src/core/agent/SubAgentRunner.ts";
import type { AgentDefinition } from "../src/core/agents/AgentDefinition.ts";
import { EventBus } from "../src/core/bus/EventBus.ts";
import type { CheckpointRecorder } from "../src/core/checkpoints/CheckpointStore.ts";
import { BackboardClient } from "../src/providers/backboard/BackboardClient.ts";
import type {
	ProviderEvent,
	SendMessageRequest,
} from "../src/providers/backboard/types.ts";
import { TEST_BACKBOARD_ENV, TEST_MODEL } from "./helpers/agent.ts";
import { TestTool } from "./helpers.ts";

const sleep = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

function definition(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
	return {
		name: "slowpoke",
		description: "d",
		mode: "worker",
		systemPrompt: "p",
		source: "project",
		...overrides,
	};
}

/** Streams a partial answer, keeps working past the budget, then finishes. */
class SlowClient extends BackboardClient {
	requests: SendMessageRequest[] = [];
	finished = false;

	constructor(private readonly workMs: number) {
		super(TEST_BACKBOARD_ENV);
	}

	override async *runMessage(
		req: SendMessageRequest,
		options: { signal?: AbortSignal } = {},
	): AsyncIterable<ProviderEvent> {
		this.requests.push(req);
		yield { kind: "thread", threadId: "thr" };
		// The post-timeout summary turn answers at once; only the first request
		// represents the long-running task.
		if (this.requests.length > 1) {
			yield { kind: "assistant_delta", text: "partial progress" };
			yield { kind: "completed" };
			return;
		}
		const step = 5;
		for (let waited = 0; waited < this.workMs; waited += step) {
			await sleep(step);
			if (options.signal?.aborted) throw new Error("aborted");
		}
		this.finished = true;
		yield { kind: "assistant_delta", text: "finished the long task" };
		yield { kind: "completed" };
	}

	override async *runToolOutputs(): AsyncIterable<ProviderEvent> {
		yield { kind: "completed" };
	}
	override async listAssistants() {
		return [];
	}
	override async createAssistant() {
		return { assistant_id: "a", name: "t" };
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

describe("RunBudget expiry modes", () => {
	it("signals expiry without aborting when abortOnExpiry is false", async () => {
		const budget = RunBudget.start(new AbortController().signal, 10, {
			abortOnExpiry: false,
		});
		await budget.expiry;
		expect(budget.timedOut).toBe(true);
		expect(budget.signal.aborted).toBe(false);
		budget.dispose();
	});

	it("stops forwarding parent cancellation once detached", () => {
		const parent = new AbortController();
		const budget = RunBudget.start(parent.signal, 10_000, {
			abortOnExpiry: false,
		});
		budget.detachFromParent();
		parent.abort();
		expect(budget.signal.aborted).toBe(false);
		budget.dispose();
	});
});

describe("deadline handoff", () => {
	it("keeps the run alive and returns a handle instead of killing it", async () => {
		const client = new SlowClient(200);
		let continuation: Promise<unknown> | undefined;

		const result = await runnerWith(client).run({
			prompt: "long task",
			definition: definition({ timeoutMs: 30 }),
			depth: 1,
			parentCwd: process.cwd(),
			parentSignal: new AbortController().signal,
			onDeadline: ({ continuation: pending }) => {
				continuation = pending;
				return { runId: "bg_test" };
			},
		});

		expect(result.status).toBe("backgrounded");
		expect(result.runId).toBe("bg_test");
		expect(client.finished).toBe(false);

		// The work was never interrupted; it finishes on its own afterwards.
		const settled = (await continuation) as { status: string; report: string };
		expect(client.finished).toBe(true);
		expect(settled.status).toBe("completed");
		expect(settled.report).toBe("finished the long task");
	});

	it("survives a parent cancel issued after the handoff", async () => {
		const client = new SlowClient(200);
		const parent = new AbortController();
		let continuation: Promise<unknown> | undefined;

		await runnerWith(client).run({
			prompt: "long task",
			definition: definition({ timeoutMs: 30 }),
			depth: 1,
			parentCwd: process.cwd(),
			parentSignal: parent.signal,
			onDeadline: ({ continuation: pending }) => {
				continuation = pending;
				return { runId: "bg_test" };
			},
		});

		parent.abort();
		const settled = (await continuation) as { status: string };
		expect(settled.status).toBe("completed");
		expect(client.finished).toBe(true);
	});

	it("falls back to stopping and summarizing when the handoff declines", async () => {
		const client = new SlowClient(200);
		const result = await runnerWith(client).run({
			prompt: "long task",
			definition: definition({ timeoutMs: 30 }),
			depth: 1,
			parentCwd: process.cwd(),
			parentSignal: new AbortController().signal,
			onDeadline: () => undefined,
		});

		expect(result.status).toBe("timed_out");
		expect(client.finished).toBe(false);
	});

	it("still stops and summarizes when no handoff is offered at all", async () => {
		const client = new SlowClient(200);
		const result = await runnerWith(client).run({
			prompt: "long task",
			definition: definition({ timeoutMs: 30 }),
			depth: 1,
			parentCwd: process.cwd(),
			parentSignal: new AbortController().signal,
		});

		expect(result.status).toBe("timed_out");
		expect(client.finished).toBe(false);
	});
});

describe("budgets inside a backgrounded chain", () => {
	it("lets a nested run finish instead of killing it when nobody waits", async () => {
		const client = new SlowClient(200);
		const result = await runnerWith(client).run({
			prompt: "nested work",
			definition: definition({ timeoutMs: 30 }),
			depth: 2,
			parentCwd: process.cwd(),
			parentSignal: new AbortController().signal,
			// Its spawner already moved to the background.
			parentChain: { inBackground: true },
		});

		// Ran past its budget, finished, and reported to its parent normally.
		expect(result.status).toBe("completed");
		expect(result.report).toBe("finished the long task");
		expect(client.finished).toBe(true);
		expect(client.requests).toHaveLength(1);
	});

	it("still enforces the budget while a foreground parent waits", async () => {
		const client = new SlowClient(200);
		const result = await runnerWith(client).run({
			prompt: "nested work",
			definition: definition({ timeoutMs: 30 }),
			depth: 2,
			parentCwd: process.cwd(),
			parentSignal: new AbortController().signal,
			parentChain: { inBackground: false },
		});

		expect(result.status).toBe("timed_out");
		expect(client.finished).toBe(false);
	});

	it("still enforces the budget of the run that started in the background", async () => {
		const client = new SlowClient(200);
		const result = await runnerWith(client).run({
			prompt: "watch the build",
			definition: definition({ timeoutMs: 30, background: true }),
			depth: 1,
			parentCwd: process.cwd(),
			parentSignal: new AbortController().signal,
			chainInBackground: true,
		});

		expect(result.status).toBe("timed_out");
		expect(result.report).toBe("partial progress");
		expect(client.finished).toBe(false);
	});

	it("marks its own children as being in the background chain", async () => {
		const probe = new TestTool({ name: "Read", readOnly: true });
		const run = probe.execute.bind(probe);
		let seen: boolean | undefined;
		probe.execute = (input, toolCtx) => {
			seen = toolCtx.backgroundChain?.inBackground;
			return run(input, toolCtx);
		};

		class OneRoundClient extends SlowClient {
			constructor() {
				super(1);
			}
			override async *runMessage(): AsyncIterable<ProviderEvent> {
				yield { kind: "thread", threadId: "t" };
				yield {
					kind: "requires_action",
					runId: "r",
					calls: [{ id: "c1", name: "Read", input: {} }],
				};
			}
			override async *runToolOutputs(): AsyncIterable<ProviderEvent> {
				yield { kind: "assistant_delta", text: "done" };
				yield { kind: "completed" };
			}
		}

		const runner = new SubAgentRunner({
			client: new OneRoundClient(),
			getModel: () => TEST_MODEL,
			memory: "off",
			memoryProfile: "code",
			getThinking: async () => undefined,
			toolFactory: () => [probe],
		});
		await runner.run({
			prompt: "x",
			definition: definition(),
			depth: 1,
			parentCwd: process.cwd(),
			parentSignal: new AbortController().signal,
			chainInBackground: true,
		});

		expect(seen).toBe(true);
	});
});

describe("handoff moves the live run into the background chain", () => {
	it("passes the new value to tools that run after adoption", async () => {
		const probe = new TestTool({ name: "Read", readOnly: true });
		const run = probe.execute.bind(probe);
		const seen: boolean[] = [];
		probe.execute = (input, toolCtx) => {
			seen.push(toolCtx.backgroundChain?.inBackground === true);
			return run(input, toolCtx);
		};

		/** One tool round before the budget expires, one after the handoff. */
		class ToolAcrossDeadline extends SlowClient {
			private round = 0;
			constructor() {
				super(1);
			}
			override async *runMessage(): AsyncIterable<ProviderEvent> {
				yield { kind: "thread", threadId: "t" };
				yield {
					kind: "requires_action",
					runId: "r",
					calls: [{ id: "c1", name: "Read", input: {} }],
				};
			}
			override async *runToolOutputs(): AsyncIterable<ProviderEvent> {
				this.round++;
				if (this.round === 1) {
					await sleep(120);
					yield {
						kind: "requires_action",
						runId: "r",
						calls: [{ id: "c2", name: "Read", input: {} }],
					};
					return;
				}
				yield { kind: "assistant_delta", text: "done" };
				yield { kind: "completed" };
			}
		}

		const runner = new SubAgentRunner({
			client: new ToolAcrossDeadline(),
			getModel: () => TEST_MODEL,
			memory: "off",
			memoryProfile: "code",
			getThinking: async () => undefined,
			toolFactory: () => [probe],
		});

		let continuation: Promise<unknown> | undefined;
		const result = await runner.run({
			prompt: "x",
			definition: definition({ timeoutMs: 40 }),
			depth: 1,
			parentCwd: process.cwd(),
			parentSignal: new AbortController().signal,
			onDeadline: ({ continuation: pending }) => {
				continuation = pending;
				return { runId: "bg_test" };
			},
		});
		expect(result.status).toBe("backgrounded");
		await continuation;

		// Budgets stop being enforced below a run moved to the background, so
		// the tool call after adoption must observe that.
		expect(seen).toEqual([false, true]);
	});
});

describe("a handoff reaches runs below it through the parent chain", () => {
	it("flips a child's chain state when its parent is handed off", () => {
		// Stand-in for a parent run's live state object.
		const parent = { inBackground: false };
		let seen: boolean | undefined;
		const probe = new TestTool({ name: "Read", readOnly: true });
		const run = probe.execute.bind(probe);
		probe.execute = (input, toolCtx) => {
			seen = toolCtx.backgroundChain?.inBackground;
			return run(input, toolCtx);
		};

		class ReadAfterParentHandoff extends SlowClient {
			constructor() {
				super(1);
			}
			override async *runMessage(): AsyncIterable<ProviderEvent> {
				yield { kind: "thread", threadId: "t" };
				// The parent is backgrounded while this child is mid-turn.
				parent.inBackground = true;
				yield {
					kind: "requires_action",
					runId: "r",
					calls: [{ id: "c1", name: "Read", input: {} }],
				};
			}
			override async *runToolOutputs(): AsyncIterable<ProviderEvent> {
				yield { kind: "assistant_delta", text: "done" };
				yield { kind: "completed" };
			}
		}

		const runner = new SubAgentRunner({
			client: new ReadAfterParentHandoff(),
			getModel: () => TEST_MODEL,
			memory: "off",
			memoryProfile: "code",
			getThinking: async () => undefined,
			toolFactory: () => [probe],
		});
		return runner
			.run({
				prompt: "x",
				definition: definition(),
				depth: 2,
				parentCwd: process.cwd(),
				parentSignal: new AbortController().signal,
				parentChain: parent,
			})
			.then(() => {
				expect(seen).toBe(true);
			});
	});
});

describe("a parent handoff relaxes a running child's budget", () => {
	it("lets the child run past its deadline once nobody waits", async () => {
		const client = new SlowClient(120);
		const parent = { inBackground: false };
		// The parent is handed off well before the child's 40ms deadline fires.
		setTimeout(() => {
			parent.inBackground = true;
		}, 10);

		const result = await runnerWith(client).run({
			prompt: "nested work",
			definition: definition({ timeoutMs: 40 }),
			depth: 2,
			parentCwd: process.cwd(),
			parentSignal: new AbortController().signal,
			parentChain: parent,
		});

		expect(result.status).toBe("completed");
		expect(client.finished).toBe(true);
	});
});

describe("budget covers the model-metadata preflight", () => {
	/** Its metadata lookup hangs until cancelled, so only the budget can bound it. */
	function stalledPreflightRunner(client: BackboardClient): SubAgentRunner {
		return new SubAgentRunner({
			client,
			getModel: () => TEST_MODEL,
			memory: "off",
			memoryProfile: "code",
			getThinking: async () => undefined,
			getThinkingResolver: (_model, signal) =>
				new Promise<RuntimeThinkingResolver>((resolve) => {
					signal.addEventListener("abort", () =>
						resolve({ intent: undefined, resolve: () => undefined }),
					);
				}),
			toolFactory: () => [],
		});
	}

	it("hands off a run whose preflight stalls past the deadline", async () => {
		const started = Date.now();
		const result = await stalledPreflightRunner(new SlowClient(200)).run({
			prompt: "long task",
			definition: definition({ timeoutMs: 20 }),
			depth: 1,
			parentCwd: process.cwd(),
			parentSignal: new AbortController().signal,
			onDeadline: () => ({ runId: "bg_test" }),
		});

		expect(result.status).toBe("backgrounded");
		expect(Date.now() - started).toBeLessThan(1_000);
	});

	it("times out a foreground run whose preflight stalls without a summary turn", async () => {
		const client = new SlowClient(200);
		const started = Date.now();
		const result = await stalledPreflightRunner(client).run({
			prompt: "long task",
			definition: definition({ timeoutMs: 20 }),
			depth: 1,
			parentCwd: process.cwd(),
			parentSignal: new AbortController().signal,
		});

		expect(result.status).toBe("timed_out");
		expect(Date.now() - started).toBeLessThan(1_000);
		// No turn ever ran, so there was nothing for a summary turn to salvage.
		expect(client.requests).toHaveLength(0);
	});
});

describe("handoff detaches from the turn's checkpoint", () => {
	it("stops journaling once the turn that owned it has ended", async () => {
		const probe = new TestTool({ name: "Read", readOnly: true });
		const run = probe.execute.bind(probe);
		let journaled = 0;
		let captured: { checkpoints?: CheckpointRecorder } | undefined;
		probe.execute = (input, toolCtx) => {
			captured = toolCtx;
			return run(input, toolCtx);
		};

		class ToolThenStall extends SlowClient {
			constructor() {
				super(1);
			}
			override async *runMessage(): AsyncIterable<ProviderEvent> {
				yield { kind: "thread", threadId: "t" };
				yield {
					kind: "requires_action",
					runId: "r",
					calls: [{ id: "c1", name: "Read", input: {} }],
				};
			}
			override async *runToolOutputs(): AsyncIterable<ProviderEvent> {
				await sleep(400);
				yield { kind: "assistant_delta", text: "done" };
				yield { kind: "completed" };
			}
		}

		const runner = new SubAgentRunner({
			client: new ToolThenStall(),
			getModel: () => TEST_MODEL,
			memory: "off",
			memoryProfile: "code",
			getThinking: async () => undefined,
			toolFactory: () => [probe],
			checkpoints: {
				scopedToTurn: () => ({
					recordPreImage: async () => {
						journaled++;
					},
					recordPostImage: async () => {
						journaled++;
					},
					revokeCapture: async () => {},
					revertToolCall: async () => {},
					beginShellCapture: async () => {},
					endShellCapture: async () => {},
					captureWarning: () => null,
					scopedToTurn: () => {
						throw new Error("unused");
					},
				}),
			} as never,
		});

		const result = await runner.run({
			prompt: "long task",
			definition: definition({ timeoutMs: 60 }),
			depth: 1,
			parentCwd: process.cwd(),
			parentSignal: new AbortController().signal,
			parentTurnId: "turn_1",
			onDeadline: () => ({ runId: "bg_test" }),
		});

		expect(result.status).toBe("backgrounded");
		expect(captured?.checkpoints).toBeDefined();

		// After handoff the turn's checkpoint is finalized, so an edit the run
		// makes from here must not be journaled into it.
		await captured?.checkpoints?.recordPreImage("/tmp/x", {} as never);
		expect(journaled).toBe(0);
	});
});

describe("stopping a handed-off run", () => {
	it("cancelAll reaches a run adopted after its budget expired", async () => {
		const client = new SlowClient(2_000);
		const supervisor = new BackgroundAgentSupervisor(new EventBus());
		const reports: string[] = [];
		supervisor.setNotifier((report) => reports.push(report));

		const result = await runnerWith(client).run({
			prompt: "very long task",
			definition: definition({ timeoutMs: 30 }),
			depth: 1,
			parentCwd: process.cwd(),
			parentSignal: new AbortController().signal,
			onDeadline: ({ continuation, cancel }) => ({
				runId: supervisor.adopt({
					definition: definition(),
					prompt: "very long task",
					continuation,
					cancel,
				}).id,
			}),
		});

		expect(result.status).toBe("backgrounded");
		expect(supervisor.active).toHaveLength(1);

		// Without a working stop handle this run would outlive the session.
		supervisor.cancelAll();
		await sleep(120);

		expect(supervisor.active).toHaveLength(0);
		expect(client.finished).toBe(false);
		// A deliberate cancel is silent; it must not announce itself.
		expect(reports).toEqual([]);
	});
});

describe("supervisor adoption", () => {
	it("reports an adopted run when it eventually finishes", async () => {
		const supervisor = new BackgroundAgentSupervisor(new EventBus());
		const reports: string[] = [];
		supervisor.setNotifier((report) => reports.push(report));

		let resolve!: (value: {
			report: string;
			status: "completed";
			usage: Record<string, never>;
			toolRounds: number;
		}) => void;
		const continuation = new Promise<{
			report: string;
			status: "completed";
			usage: Record<string, never>;
			toolRounds: number;
		}>((r) => {
			resolve = r;
		});

		const snapshot = supervisor.adopt({
			definition: definition(),
			prompt: "long task",
			continuation,
			cancel: () => {},
		});

		expect(snapshot.status).toBe("running");
		expect(snapshot.adopted).toBe(true);
		expect(supervisor.active).toHaveLength(1);
		expect(reports).toEqual([]);

		resolve({
			report: "done at last",
			status: "completed",
			usage: {},
			toolRounds: 9,
		});
		await sleep(40);

		expect(supervisor.active).toHaveLength(0);
		expect(reports).toHaveLength(1);
		expect(reports[0]).toContain("done at last");
		expect(reports[0]).toContain('rounds="9"');
	});
});
