import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelRef } from "../src/config/defaults.ts";
import { AgentTraceContext } from "../src/core/agent/AgentTraceStore.ts";
import {
	SubAgentRunner,
	type SubAgentRunParams,
} from "../src/core/agent/SubAgentRunner.ts";
import type { AgentDefinition } from "../src/core/agents/AgentDefinition.ts";
import { EventBus } from "../src/core/bus/EventBus.ts";
import type { OpenAITool } from "../src/core/tools/schema.ts";
import type { Tool } from "../src/core/tools/Tool.ts";
import {
	BackboardClient,
	type RequestOptions,
} from "../src/providers/backboard/BackboardClient.ts";
import type {
	AssistantInfo,
	ProviderEvent,
	SendMessageRequest,
	SubmitToolOutputsRequest,
} from "../src/providers/backboard/types.ts";
import { TodoWriteTool } from "../src/tools/TodoWriteTool.tsx";
import { TEST_BACKBOARD_ENV, TEST_MODEL } from "./helpers/agent.ts";
import { TestTool } from "./helpers.ts";

/** Yields one assistant message then completes. */
class CompletingClient extends BackboardClient {
	messageRequests: SendMessageRequest[] = [];
	listAssistantsSignal: AbortSignal | undefined;
	createAssistantSignal: AbortSignal | undefined;

	constructor() {
		super(TEST_BACKBOARD_ENV);
	}

	override async *runMessage(
		req: SendMessageRequest,
	): AsyncIterable<ProviderEvent> {
		this.messageRequests.push(req);
		yield { kind: "thread", threadId: "thr_sub" };
		yield {
			kind: "usage",
			usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
		};
		yield { kind: "assistant_delta", text: "final report from sub-agent" };
		yield { kind: "completed" };
	}
	override async *runToolOutputs(
		_req: SubmitToolOutputsRequest,
	): AsyncIterable<ProviderEvent> {
		yield { kind: "completed" };
	}
	override async listAssistants(
		options: RequestOptions = {},
	): Promise<AssistantInfo[]> {
		this.listAssistantsSignal = options.signal;
		return [];
	}
	override async createAssistant(
		_req: { name: string; system_prompt: string; tools: OpenAITool[] },
		options: RequestOptions = {},
	): Promise<AssistantInfo> {
		this.createAssistantSignal = options.signal;
		return { assistant_id: "asst_sub", name: "test assistant" };
	}
}

class RepeatingToolCallClient extends CompletingClient {
	toolOutputRequests: SubmitToolOutputsRequest[] = [];

	override async *runMessage(): AsyncIterable<ProviderEvent> {
		yield { kind: "thread", threadId: "thr_sub" };
		yield {
			kind: "requires_action",
			runId: "run_0",
			calls: [{ id: "call_0", name: "Read", input: {} }],
		};
	}

	override async *runToolOutputs(
		req: SubmitToolOutputsRequest,
	): AsyncIterable<ProviderEvent> {
		this.toolOutputRequests.push(req);
		const round = this.toolOutputRequests.length;
		yield {
			kind: "requires_action",
			runId: `run_${round}`,
			calls: [{ id: `call_${round}`, name: "Read", input: {} }],
		};
	}
}

const TEST_DEFINITION: AgentDefinition = {
	name: "worker",
	description: "test worker",
	mode: "worker",
	systemPrompt: "you are a sub-agent",
	source: "built-in",
};

function runnerWith(
	client: BackboardClient,
	tools: Tool[],
	maxToolRounds?: number,
): SubAgentRunner {
	return new SubAgentRunner({
		client,
		getModel: () => TEST_MODEL,
		memory: "off",
		memoryProfile: "code",
		getThinking: async () => undefined,
		toolFactory: () => tools,
		...(maxToolRounds !== undefined ? { maxToolRounds } : {}),
	});
}

describe("SubAgentRunner model override", () => {
	it("resolves thinking and tool policy from the definition's model", async () => {
		const pinned = { provider: "moonshot", model: "kimi-k3" };
		const thinkingModels: ModelRef[] = [];
		const toolGateModels: ModelRef[] = [];
		const runner = new SubAgentRunner({
			client: new CompletingClient(),
			getModel: () => TEST_MODEL,
			memory: "off",
			memoryProfile: "code",
			getThinking: async (model) => {
				thinkingModels.push(model);
				return undefined;
			},
			toolFactory: () => [new TestTool({ name: "Read", readOnly: true })],
			isToolEnabled: (_name, model) => {
				toolGateModels.push(model);
				return true;
			},
		});

		await runner.run({
			prompt: "work",
			depth: 1,
			definition: { ...TEST_DEFINITION, model: pinned },
			parentCwd: process.cwd(),
			parentSignal: new AbortController().signal,
		});

		expect(thinkingModels).toEqual([pinned]);
		expect(toolGateModels.every((model) => model === pinned)).toBe(true);
	});

	it("falls back to the session model when the definition pins none", async () => {
		const thinkingModels: ModelRef[] = [];
		const runner = new SubAgentRunner({
			client: new CompletingClient(),
			getModel: () => TEST_MODEL,
			memory: "off",
			memoryProfile: "code",
			getThinking: async (model) => {
				thinkingModels.push(model);
				return undefined;
			},
			toolFactory: () => [],
		});

		await runner.run({
			prompt: "work",
			depth: 1,
			definition: TEST_DEFINITION,
			parentCwd: process.cwd(),
			parentSignal: new AbortController().signal,
		});

		expect(thinkingModels).toEqual([TEST_MODEL]);
	});
});

describe("SubAgentRunner", () => {
	it("returns only the sub-agent's final report and aggregates usage", async () => {
		const client = new CompletingClient();
		const runner = runnerWith(client, [
			new TestTool({ name: "Read", readOnly: true }),
		]);

		const result = await runner.run({
			prompt: "summarize the module\n\nReturn one sentence.",
			depth: 1,
			definition: TEST_DEFINITION,
			parentCwd: process.cwd(),
			parentSignal: new AbortController().signal,
		});

		expect(result.report).toBe("final report from sub-agent");
		expect(result.status).toBe("completed");
		expect(result.usage.totalTokens).toBe(5);
		expect(client.messageRequests[0]?.content).toBe(
			"summarize the module\n\nReturn one sentence.",
		);
		expect(client.messageRequests[0]?.system_prompt).toStartWith(
			"you are a sub-agent",
		);
		// The report contract is appended so an agent file cannot drop it.
		expect(client.messageRequests[0]?.system_prompt).toContain(
			"the parent receives that message and nothing else",
		);
	});

	it("propagates the depth into the sub-agent tool context", async () => {
		let seenDepth = -1;
		const probe = new TestTool({ name: "Read", readOnly: true });
		const original = probe.execute.bind(probe);
		probe.execute = (input, ctx) => {
			seenDepth = ctx.agentDepth ?? -1;
			return original(input, ctx);
		};

		class OneRoundClient extends CompletingClient {
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

		const runner = runnerWith(new OneRoundClient(), [probe]);
		await runner.run({
			prompt: "x",
			depth: 2,
			definition: TEST_DEFINITION,
			parentCwd: process.cwd(),
			parentSignal: new AbortController().signal,
		});
		expect(seenDepth).toBe(2);
	});

	it("runs worker turns without creating a Backboard assistant", async () => {
		const controller = new AbortController();
		const client = new CompletingClient();
		const runner = runnerWith(client, []);

		await runner.run({
			prompt: "x",
			depth: 1,
			definition: TEST_DEFINITION,
			parentCwd: process.cwd(),
			parentSignal: controller.signal,
		});

		expect(client.listAssistantsSignal).toBeUndefined();
		expect(client.createAssistantSignal).toBeUndefined();
		expect(client.messageRequests[0]?.assistant_id).toBeUndefined();
		expect(client.messageRequests[0]?.tools).toEqual([]);
	});

	it("stops worker agents after the tool round cap", async () => {
		const client = new RepeatingToolCallClient();
		const runner = runnerWith(client, [
			new TestTool({ name: "Read", readOnly: true }),
		]);

		const result = await runner.run({
			prompt: "keep using tools",
			depth: 1,
			definition: TEST_DEFINITION,
			parentCwd: process.cwd(),
			parentSignal: new AbortController().signal,
		});

		expect(result.status).toBe("failed");
		expect(result.toolRounds).toBe(20);
		expect(client.toolOutputRequests).toHaveLength(20);
	});

	it("allows callers to lower the tool round cap", async () => {
		const client = new RepeatingToolCallClient();
		const runner = runnerWith(
			client,
			[new TestTool({ name: "Read", readOnly: true })],
			3,
		);

		const result = await runner.run({
			prompt: "keep using tools",
			depth: 1,
			definition: TEST_DEFINITION,
			parentCwd: process.cwd(),
			parentSignal: new AbortController().signal,
		});

		expect(result.status).toBe("failed");
		expect(result.toolRounds).toBe(3);
		expect(client.toolOutputRequests).toHaveLength(3);
	});

	it("records worker child events when trace logging is configured", async () => {
		const dir = await mkdtemp(join(tmpdir(), "cli-worker-trace-"));
		try {
			const client = new CompletingClient();
			const runner = runnerWith(client, []);
			const clientLogPath = join(dir, "agents", "call_worker", "client.jsonl");

			await runner.run({
				prompt: "summarize",
				depth: 1,
				definition: TEST_DEFINITION,
				parentCwd: dir,
				parentSignal: new AbortController().signal,
				trace: {
					sessionId: "sess_parent",
					context: new AgentTraceContext({
						sessionId: "sess_parent",
						sessionRoot: join(dir, ".backboard", "sessions", "sess_parent"),
						cwd: dir,
					}),
					clientLogPath,
				},
			});

			const text = await readFile(clientLogPath, "utf8");
			const records = text
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as { type: string });
			expect(records[0]?.type).toBe("session:created");
			expect(records.map((record) => record.type)).toContain(
				"assistant:message",
			);
			expect(records.map((record) => record.type)).toContain("turn:end");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("does not relay child TodoWrite updates to the parent bus", async () => {
		const parentBus = new EventBus();
		const parentTodoUpdates: unknown[] = [];
		const childProgress: unknown[] = [];
		parentBus.on("todos:updated", (event) => parentTodoUpdates.push(event));
		parentBus.on("agent:child_tool_start", (event) =>
			childProgress.push(event),
		);

		class TodoClient extends CompletingClient {
			override async *runMessage(): AsyncIterable<ProviderEvent> {
				yield { kind: "thread", threadId: "thr_sub" };
				yield {
					kind: "requires_action",
					runId: "run_todo",
					calls: [
						{
							id: "call_todo",
							name: "TodoWrite",
							input: {
								todos: [{ content: "child task", status: "in_progress" }],
							},
						},
					],
				};
			}
			override async *runToolOutputs(): AsyncIterable<ProviderEvent> {
				yield { kind: "assistant_delta", text: "child done" };
				yield { kind: "completed" };
			}
		}

		const runner = runnerWith(new TodoClient(), [new TodoWriteTool()]);
		const result = await runner.run({
			prompt: "track child work",
			depth: 1,
			definition: TEST_DEFINITION,
			parentCwd: process.cwd(),
			parentSignal: new AbortController().signal,
			parentBus,
			parentToolCallId: "agent_1",
		});

		expect(result.report).toBe("child done");
		expect(parentTodoUpdates).toEqual([]);
		expect(childProgress).toHaveLength(1);
	});

	it("stops relaying child events once the parent signal is aborted", () => {
		const parentBus = new EventBus();
		const relayed: string[] = [];
		parentBus.on("agent:child_tool_start", () => relayed.push("start"));
		parentBus.on("agent:child_tool_result", () => relayed.push("result"));

		const childBus = new EventBus();
		const controller = new AbortController();
		const runner = runnerWith(new CompletingClient(), []);
		const detach = (
			runner as unknown as {
				attachParentProgressRelay: (
					params: SubAgentRunParams,
					bus: EventBus,
				) => () => void;
			}
		).attachParentProgressRelay(
			{
				prompt: "x",
				depth: 1,
				definition: TEST_DEFINITION,
				parentCwd: process.cwd(),
				parentSignal: controller.signal,
				parentBus,
				parentToolCallId: "agent_1",
			},
			childBus,
		);

		childBus.emit({
			type: "tool:start",
			toolCallId: "c1",
			name: "Read",
			inputSummary: "",
		});
		expect(relayed).toEqual(["start"]);

		// After cancel the winding-down child keeps emitting, but nothing may
		// reach the parent - it would resurrect the committed "Interrupted" row.
		controller.abort();
		childBus.emit({
			type: "tool:result",
			toolCallId: "c1",
			name: "Read",
			title: "ok",
		});
		detach();

		expect(relayed).toEqual(["start"]);
	});
});
