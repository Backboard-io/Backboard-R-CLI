import { describe, expect, it } from "bun:test";
import { AgentLoop } from "../src/core/agent/AgentLoop.ts";
import { EventBus } from "../src/core/bus/EventBus.ts";
import { Session } from "../src/core/session/Session.ts";
import { ToolRegistry } from "../src/core/tools/ToolRegistry.ts";
import { ToolScheduler } from "../src/core/tools/ToolScheduler.ts";
import type {
	AgentClient,
	RunMessageOptions,
} from "../src/providers/AgentClient.ts";
import type {
	ProviderEvent,
	SendMessageRequest,
	SubmitToolOutputsRequest,
} from "../src/providers/backboard/types.ts";
import { makeContext, TestTool } from "./helpers.ts";

describe("AgentLoop timer integration", () => {
	it("puts the budget on the message and notices on outbound results, not the transcript", async () => {
		const messageRequests: SendMessageRequest[] = [];
		const resultRequests: SubmitToolOutputsRequest[] = [];
		const display: Array<string | undefined> = [];
		const client = {
			async *runMessage(
				request: SendMessageRequest,
				options: RunMessageOptions,
			): AsyncIterable<ProviderEvent> {
				messageRequests.push(request);
				display.push(options.displayContent);
				yield { kind: "thread", threadId: "thread" };
				yield {
					kind: "requires_action",
					runId: "run",
					calls: [{ id: "read", name: "Read", input: {} }],
				};
			},
			async *runToolOutputs(
				request: SubmitToolOutputsRequest,
			): AsyncIterable<ProviderEvent> {
				resultRequests.push(request);
				yield { kind: "completed" };
			},
		} as unknown as AgentClient;
		const bus = new EventBus();
		const session = new Session("timer-test");
		const registry = new ToolRegistry([new TestTool({ name: "Read" })]);
		const loop = new AgentLoop({
			client,
			bus,
			session,
			scheduler: new ToolScheduler(registry, bus),
			tools: [],
			systemPrompt: "static prefix",
			model: { provider: "test", model: "test" },
			memory: "off",
			memoryProfile: "default",
			thinking: undefined,
			timerSeconds: 900,
			turnStartedAt: Date.now() - 480_000,
		});
		expect(
			await loop.run("Fix it", makeContext(new AbortController().signal, bus)),
		).toBe("completed");
		expect(messageRequests[0]?.content).toContain("## Time budget");
		expect(messageRequests[0]?.content).toContain("timeBudgetSeconds");
		expect(messageRequests[0]?.content).toEndWith("Fix it");
		expect(messageRequests[0]?.system_prompt).toBe("static prefix");
		expect(display).toEqual(["Fix it"]);
		expect(resultRequests[0]?.tool_outputs[0]?.output).toContain("Time check:");
		expect(JSON.stringify(session.getMessages())).not.toContain("Time check:");
	});

	it("leaves untimed messages unchanged and supplies the budget even without tools", async () => {
		const messages: SendMessageRequest[] = [];
		const client = {
			async *runMessage(
				request: SendMessageRequest,
			): AsyncIterable<ProviderEvent> {
				messages.push(request);
				yield { kind: "completed" };
			},
		} as unknown as AgentClient;
		const bus = new EventBus();
		for (const timerSeconds of [undefined, 60, undefined]) {
			const loop = new AgentLoop({
				client,
				bus,
				session: new Session("test"),
				scheduler: new ToolScheduler(new ToolRegistry([]), bus),
				tools: [],
				systemPrompt: "static prefix",
				model: { provider: "test", model: "test" },
				memory: "off",
				memoryProfile: "default",
				thinking: undefined,
				timerSeconds,
			});
			expect(
				await loop.run("hello", makeContext(new AbortController().signal, bus)),
			).toBe("completed");
		}
		expect(messages[0]?.content).toBe("hello");
		expect(messages[1]?.content).toContain("allocated 60s for this turn");
		expect(messages[2]?.content).toBe("hello");
	});
});
