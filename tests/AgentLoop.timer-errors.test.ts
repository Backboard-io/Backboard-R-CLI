import { describe, expect, it, spyOn } from "bun:test";
import { AgentLoop } from "../src/core/agent/AgentLoop.ts";
import { TurnTiming } from "../src/core/agent/timing/TurnTiming.ts";
import { EventBus } from "../src/core/bus/EventBus.ts";
import type { ToolCallRef } from "../src/core/bus/events.ts";
import { emptyRuleSet } from "../src/core/permissions/PermissionRules.ts";
import { Session } from "../src/core/session/Session.ts";
import { ToolHookPipeline } from "../src/core/tools/ToolHookPipeline.ts";
import { ToolRegistry } from "../src/core/tools/ToolRegistry.ts";
import { ToolScheduler } from "../src/core/tools/ToolScheduler.ts";
import type { AgentClient } from "../src/providers/AgentClient.ts";
import type {
	ProviderEvent,
	SendMessageRequest,
	SubmitToolOutputsRequest,
} from "../src/providers/backboard/types.ts";
import { TodoWriteTool } from "../src/tools/TodoWriteTool.tsx";
import { makeContext, TestTool } from "./helpers.ts";

const todo = (
	id: string,
	status: "in_progress" | "completed",
): ToolCallRef => ({
	id,
	name: "todo_write",
	input: { todos: [{ content: "Implement", status, timeBudgetSeconds: 180 }] },
});
const work = (id = "work"): ToolCallRef => ({ id, name: "Execute", input: {} });
const action = (calls: ToolCallRef[]): ProviderEvent => ({
	kind: "requires_action",
	runId: "run",
	calls,
});

async function harness(
	test: (h: {
		bus: EventBus;
		session: Session;
		abort: AbortController;
		advance: (ms: number) => void;
		run: (
			first: ProviderEvent[],
			next: (attempt: number) => ProviderEvent[],
			tools?: TestTool[],
			permissions?: ReturnType<typeof makeContext>["permissions"],
		) => Promise<string>;
		requests: SubmitToolOutputsRequest[];
		preserved: SubmitToolOutputsRequest[];
		messages: SendMessageRequest[];
	}) => Promise<void>,
): Promise<void> {
	let now = 1_000_000;
	const clock = spyOn(Date, "now").mockImplementation(() => now);
	const record = spyOn(TurnTiming.prototype, "recordTodoUpdate");
	const bus = new EventBus();
	const session = new Session("timer-errors");
	const detachSession = session.attach(bus);
	const originalOn = bus.on.bind(bus);
	let timingDetaches = 0;
	const subscribe = spyOn(bus, "on").mockImplementation((type, listener) => {
		const detach = originalOn(type, listener);
		return () => {
			if (type === "todos:updated") timingDetaches++;
			detach();
		};
	});
	const abort = new AbortController();
	const requests: SubmitToolOutputsRequest[] = [];
	const preserved: SubmitToolOutputsRequest[] = [];
	const messages: SendMessageRequest[] = [];
	try {
		await test({
			bus,
			session,
			abort,
			requests,
			preserved,
			messages,
			advance: (ms) => {
				now += ms;
			},
			run: async (first, next, tools = [], permissions) => {
				const client = {
					async *runMessage(request: SendMessageRequest) {
						messages.push(request);
						if (messages.length > 1) throw new Error("Unexpected notification");
						yield { kind: "thread", threadId: "thread" };
						yield* first;
					},
					async *runToolOutputs(request: SubmitToolOutputsRequest) {
						// Snapshot each attempt so accidental in-place redecorations are visible.
						requests.push(structuredClone(request));
						yield* next(requests.length);
					},
					async preserveFailedToolOutputs(request: SubmitToolOutputsRequest) {
						preserved.push(structuredClone(request));
						return null;
					},
				} as unknown as AgentClient;
				const loop = new AgentLoop({
					client,
					bus,
					session,
					scheduler: new ToolScheduler(
						new ToolRegistry([new TodoWriteTool(), ...tools]),
						bus,
					),
					tools: [],
					systemPrompt: "static",
					model: { provider: "test", model: "test" },
					memory: "off",
					memoryProfile: "default",
					thinking: undefined,
					timerSeconds: 900,
					turnStartedAt: 1_000_000,
				});
				const status = await loop.run("Fix it", {
					...makeContext(abort.signal, bus),
					getTodos: () => session.todos,
					permissions,
				});
				expect(timingDetaches).toBe(1);
				const count = record.mock.calls.length;
				bus.emit({ type: "todos:updated", toolCallId: "late", todos: [] });
				expect(record.mock.calls.length).toBe(count);
				expect(JSON.stringify(session.getMessages())).not.toContain(
					"Time check:",
				);
				expect(JSON.stringify(session.getMessages())).not.toContain(
					"Previous step:",
				);
				return status;
			},
		});
	} finally {
		subscribe.mockRestore();
		detachSession();
		record.mockRestore();
		clock.mockRestore();
	}
}

describe("timer error paths through real tool rounds", () => {
	it("cancels after TodoWrite without partial submissions or preserved notices", async () => {
		await harness(async (h) => {
			const status = await h.run(
				[
					action([
						todo("start", "in_progress"),
						work(),
						todo("done", "completed"),
					]),
				],
				() => [{ kind: "completed" }],
				[
					new TestTool({
						name: "Execute",
						readOnly: false,
						onStart: () => {
							h.advance(480_000);
							h.abort.abort();
						},
					}),
				],
			);
			expect(status).toBe("cancelled");
			expect(h.requests).toHaveLength(0);
			expect(h.preserved).toHaveLength(1);
			expect(h.preserved[0]?.tool_outputs).toEqual([
				{
					tool_call_id: "start",
					output: "Updated 1 todos: [in_progress] Implement",
				},
				{
					tool_call_id: "work",
					output:
						"Error: Tool execution was interrupted before results were submitted.",
				},
				{
					tool_call_id: "done",
					output:
						"Error: Tool execution was interrupted before results were submitted.",
				},
			]);
		});
	});

	it("retries the same decorated outputs once without rerunning tools or resetting the budget", async () => {
		await harness(async (h) => {
			let starts = 0;
			let updates = 0;
			const detach = h.bus.on("todos:updated", (event) => {
				if (event.toolCallId !== "late") updates++;
			});
			try {
				expect(
					await h.run(
						[
							action([
								todo("start", "in_progress"),
								work(),
								todo("done", "completed"),
							]),
						],
						(attempt) => {
							if (attempt === 1) {
								h.advance(240_000);
								return [
									{
										kind: "failed",
										error: "Failed to continue streaming after tool outputs.",
										retryable: true,
									},
								];
							}
							if (attempt === 2) return [action([work("after-retry")])];
							return [{ kind: "completed" }];
						},
						[
							new TestTool({
								name: "Execute",
								readOnly: false,
								onStart: () => {
									starts++;
									if (starts === 1) h.advance(480_000);
								},
							}),
						],
					),
				).toBe("completed");
				expect(starts).toBe(2);
				expect(updates).toBe(2);
				expect(h.messages).toHaveLength(1);
				expect(h.requests).toHaveLength(3);
				expect(h.requests[1]).toEqual(h.requests[0]);
				const output = h.requests[0]?.tool_outputs.at(-1)?.output ?? "";
				expect(output.match(/Time check:/g)).toHaveLength(1);
				expect(
					output.match(/Previous step: planned 3m, took 8m\./g),
				).toHaveLength(1);
				expect(output.match(/1\/1 steps done/g)).toHaveLength(1);
				expect(h.requests[2]?.tool_outputs[0]?.output).toContain(
					"3m of the 15m budget remains",
				);
				expect(h.requests[2]?.tool_outputs[0]?.output).not.toContain(
					"Previous step:",
				);
				expect(h.preserved).toHaveLength(0);
			} finally {
				detach();
			}
		});
	});

	it("detaches timing when a non-retryable continuation fails", async () => {
		await harness(async (h) => {
			expect(
				await h.run([action([todo("start", "in_progress")])], () => [
					{ kind: "failed", error: "terminal provider failure" },
				]),
			).toBe("failed");
			expect(h.requests).toHaveLength(1);
		});
	});

	for (const denied of [false, true]) {
		it(`keeps the Error prefix and local error classification for ${denied ? "denied" : "throwing"} tools with timer notices`, async () => {
			await harness(async (h) => {
				let starts = 0;
				const tool = new TestTool({
					name: "Execute",
					readOnly: false,
					throws: true,
					onStart: () => {
						starts++;
					},
				});
				const permission = spyOn(tool, "checkPermissions").mockReturnValue({
					behavior: "deny",
					reason: "test denial",
				});
				try {
					h.advance(480_000);
					expect(
						await h.run(
							[action([work()])],
							() => [{ kind: "completed" }],
							[tool],
							denied
								? { mode: "manual", rules: emptyRuleSet(), interactive: false }
								: undefined,
						),
					).toBe("completed");
					const error = denied ? "Error: test denial" : "Error: tool failed";
					expect(starts).toBe(denied ? 0 : 1);
					expect(h.requests[0]?.tool_outputs[0]?.output).toStartWith(
						`${error}\n\n`,
					);
					expect(h.requests[0]?.tool_outputs[0]?.output).toContain(
						"Time check:",
					);
					const local = h.session
						.getMessages()
						.find((message) => message.role === "tool");
					expect(local?.results[0]).toMatchObject({
						output: error,
						isError: true,
					});
				} finally {
					permission.mockRestore();
				}
			});
		});
	}

	it("does not start step accounting when a real TodoWrite update is rejected after execution", async () => {
		const original = ToolHookPipeline.prototype.applyPostToolHooks;
		const post = spyOn(
			ToolHookPipeline.prototype,
			"applyPostToolHooks",
		).mockImplementation(async function (this: ToolHookPipeline, ref, ...args) {
			if (ref.id === "rejected")
				return { output: "Error: rejected todo update", denied: true };
			return original.call(this, ref, ...args);
		});
		try {
			await harness(async (h) => {
				expect(
					await h.run(
						[action([todo("rejected", "in_progress")])],
						(attempt) => {
							if (attempt === 1) {
								h.advance(480_000);
								return [action([todo("done", "completed")])];
							}
							return [{ kind: "completed" }];
						},
					),
				).toBe("completed");
				expect(h.requests[0]?.tool_outputs[0]?.output).toBe(
					"Error: rejected todo update",
				);
				const completed = h.requests[1]?.tool_outputs[0]?.output ?? "";
				expect(completed).toStartWith("Updated 1 todos: [completed] Implement");
				expect(completed).toContain("Time check:");
				expect(completed).not.toContain("Previous step:");
				expect(completed).not.toContain("steps done");
			});
		} finally {
			post.mockRestore();
		}
	});
});
