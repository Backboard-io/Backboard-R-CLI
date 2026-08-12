import { describe, expect, it } from "bun:test";
import { Config } from "../src/config/Config.ts";
import { EventBus } from "../src/core/bus/EventBus.ts";
import type { OpenAITool } from "../src/core/tools/schema.ts";
import type { ToolContext } from "../src/core/tools/ToolContext.ts";
import { ToolRegistry } from "../src/core/tools/ToolRegistry.ts";
import { BackboardClient } from "../src/providers/backboard/BackboardClient.ts";
import type {
	AssistantInfo,
	ProviderEvent,
	SendMessageRequest,
	SubmitToolOutputsRequest,
} from "../src/providers/backboard/types.ts";
import type { AgentTool } from "../src/tools/AgentTool.tsx";
import { createDefaultTools } from "../src/tools/index.ts";
import { TEST_BACKBOARD_ENV } from "./helpers/agent.ts";
import { TestTool } from "./helpers.ts";

class FakeClient extends BackboardClient {
	assistantRequests: Array<{
		name: string;
		system_prompt: string;
		tools: OpenAITool[];
	}> = [];
	messageRequests: SendMessageRequest[] = [];
	toolOutputRequests: SubmitToolOutputsRequest[] = [];

	constructor(private readonly events: ProviderEvent[]) {
		super(TEST_BACKBOARD_ENV);
	}

	override async listAssistants(): Promise<AssistantInfo[]> {
		return [];
	}

	override async createAssistant(req: {
		name: string;
		system_prompt: string;
		tools: OpenAITool[];
	}): Promise<AssistantInfo> {
		this.assistantRequests.push(req);
		return {
			assistant_id: `asst_${this.assistantRequests.length}`,
			name: req.name,
			system_prompt: req.system_prompt,
			tools: req.tools,
		};
	}

	override async *runMessage(
		req: SendMessageRequest,
	): AsyncIterable<ProviderEvent> {
		this.messageRequests.push(req);
		yield* this.events;
	}

	override async *runToolOutputs(
		req: SubmitToolOutputsRequest,
	): AsyncIterable<ProviderEvent> {
		this.toolOutputRequests.push(req);
		yield { kind: "completed" };
	}
}

function toolNames(tools: OpenAITool[]): string[] {
	return tools.map((tool) => tool.function.name);
}

function context(): ToolContext {
	return {
		sessionId: "sess_test",
		cwd: process.cwd(),
		bus: new EventBus(),
		signal: new AbortController().signal,
		askUser: async () => "noop",
		agentDepth: 0,
	};
}

describe("createDefaultTools", () => {
	it("omits the Agent tool without deps", () => {
		const names = createDefaultTools().map((t) => t.name);
		expect(names).not.toContain("Agent");
	});

	it("includes a parallel-safe Agent tool when deps are provided", () => {
		const config = new Config({ env: TEST_BACKBOARD_ENV, argv: [] });
		const client = new FakeClient([]);
		const tools = createDefaultTools({ client, config });
		const agent = tools.find((t): t is AgentTool => t.name === "Agent");

		if (!agent) throw new Error("expected Agent tool");
		expect(agent.isConcurrencySafe({ prompt: "x" })).toBe(true);
	});

	it("propagates excluded tools to worker subagents", async () => {
		const config = new Config({
			env: TEST_BACKBOARD_ENV,
			argv: ["--excluded-tools", "Execute"],
		});
		const client = new FakeClient([
			{ kind: "thread", threadId: "thr_worker" },
			{ kind: "assistant_delta", text: "worker report" },
			{ kind: "completed" },
		]);
		const tools = createDefaultTools({
			client,
			config,
		});
		const agent = tools.find((t): t is AgentTool => t.name === "Agent");

		if (!agent) throw new Error("expected Agent tool");
		const result = await agent.execute({ prompt: "inspect" }, context());

		expect(result.data.status).toBe("completed");
		expect(toolNames(client.messageRequests[0]?.tools ?? [])).not.toContain(
			"Execute",
		);
	});

	it("does not execute stale hidden worker tool calls", async () => {
		const config = new Config({
			env: TEST_BACKBOARD_ENV,
			argv: ["--excluded-tools", "Execute"],
		});
		const client = new FakeClient([
			{ kind: "thread", threadId: "thr_worker" },
			{
				kind: "requires_action",
				runId: "run_1",
				calls: [{ id: "call_execute", name: "Execute", input: {} }],
			},
		]);
		const tools = createDefaultTools({
			client,
			config,
		});
		const agent = tools.find((t): t is AgentTool => t.name === "Agent");

		if (!agent) throw new Error("expected Agent tool");
		await agent.execute({ prompt: "inspect" }, context());

		expect(client.toolOutputRequests[0]?.tool_outputs[0]?.output).toContain(
			'unknown tool "Execute"',
		);
	});

	it("propagates excluded tools to worker-spawned workers", async () => {
		const config = new Config({
			env: TEST_BACKBOARD_ENV,
			argv: ["--excluded-tools", "Execute"],
		});
		const client = new FakeClient([
			{ kind: "thread", threadId: "thr_worker_parent" },
			{
				kind: "requires_action",
				runId: "run_parent",
				calls: [
					{
						id: "call_agent",
						name: "Agent",
						input: { prompt: "nested inspect", subagent_type: "worker" },
					},
				],
			},
			{ kind: "thread", threadId: "thr_worker_child" },
			{ kind: "assistant_delta", text: "nested report" },
			{ kind: "completed" },
		]);
		const tools = createDefaultTools({
			client,
			config,
		});
		const agent = tools.find((t): t is AgentTool => t.name === "Agent");

		if (!agent) throw new Error("expected Agent tool");
		await agent.execute({ prompt: "inspect" }, context());

		expect(client.messageRequests).toHaveLength(2);
		expect(toolNames(client.messageRequests[0]?.tools ?? [])).not.toContain(
			"Execute",
		);
		expect(toolNames(client.messageRequests[1]?.tools ?? [])).not.toContain(
			"Execute",
		);
	});

	it("propagates tools registered after startup to worker subagents", async () => {
		const config = new Config({ env: TEST_BACKBOARD_ENV, argv: [] });
		const client = new FakeClient([
			{ kind: "thread", threadId: "thr_worker" },
			{ kind: "assistant_delta", text: "worker report" },
			{ kind: "completed" },
		]);
		let registry: ToolRegistry;
		const tools = createDefaultTools({
			client,
			config,
			getTools: () => registry.list(),
		});
		registry = new ToolRegistry(tools);
		registry.register(new TestTool({ name: "mcp__later__inspect" }));
		const agent = registry.get("Agent") as AgentTool | undefined;

		if (!agent) throw new Error("expected Agent tool");
		const result = await agent.execute({ prompt: "inspect" }, context());

		expect(result.data.status).toBe("completed");
		expect(toolNames(client.messageRequests[0]?.tools ?? [])).toContain(
			"mcp__later__inspect",
		);
	});
});
