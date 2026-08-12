import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Config } from "../src/config/Config.ts";
import { AgentController } from "../src/core/agent/AgentController.ts";
import { FINAL_VERIFICATION_MIN_TOOL_CALLS } from "../src/core/agent/notifications/FinalVerificationNotification.ts";
import { EventBus } from "../src/core/bus/EventBus.ts";
import type { AgentEvent } from "../src/core/bus/events.ts";
import { emptyRuleSet } from "../src/core/permissions/PermissionRules.ts";
import type { PermissionContext } from "../src/core/permissions/types.ts";
import { assistantMessage, userMessage } from "../src/core/session/Message.ts";
import { Session } from "../src/core/session/Session.ts";
import { SkillController } from "../src/core/skills/SkillController.ts";
import { ToolRegistry } from "../src/core/tools/ToolRegistry.ts";
import type {
	BackboardClient,
	RequestOptions,
} from "../src/providers/backboard/BackboardClient.ts";
import type {
	AssistantInfo,
	BackboardResponse,
	ModelsListResponse,
	ModelThinkingMetadataResponse,
	ProviderEvent,
	SendMessageRequest,
	SubmitToolOutputsRequest,
} from "../src/providers/backboard/types.ts";
import { TestTool } from "./helpers.ts";

const env = { apiKey: "k", apiUrl: "https://example.test/api" };

// Bypass mode with no rules keeps the permission gate a no-op, matching the
// pre-wiring behavior these tests were written against.
const TEST_PERMISSIONS: PermissionContext = {
	mode: "bypass",
	rules: emptyRuleSet(),
	interactive: false,
};

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const timeout = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timeout);
				reject(new Error("aborted"));
			},
			{ once: true },
		);
	});
}

class FakeClient {
	/** Stands in for Backboard, so the assistant/thread paths stay exercised. */
	readonly capabilities = { assistants: true, threads: true, memory: true };
	messageRequests: SendMessageRequest[] = [];
	messageAttachmentPaths: Array<string[] | undefined> = [];
	toolOutputRequests: SubmitToolOutputsRequest[] = [];
	preservedToolOutputRequests: SubmitToolOutputsRequest[] = [];
	modelThinkingMetadataCount = 0;
	listModelsCount = 0;
	threadSource: "byok" | "backboard" = "backboard";
	listAssistantsDelayMs = 0;
	assistantRequests: Array<{
		name: string;
		system_prompt: string;
		tools: unknown[];
	}> = [];
	private readonly assistants: AssistantInfo[] = [];

	constructor(
		private readonly first: ProviderEvent[],
		private readonly second: ProviderEvent[],
	) {}

	async listAssistants(options: RequestOptions = {}): Promise<AssistantInfo[]> {
		if (this.listAssistantsDelayMs > 0) {
			await delay(this.listAssistantsDelayMs, options.signal);
		}
		return this.assistants;
	}

	async createAssistant(req: {
		name: string;
		system_prompt: string;
		tools: unknown[];
	}): Promise<AssistantInfo> {
		this.assistantRequests.push(req);
		const assistant = {
			assistant_id: `asst_${this.assistants.length + 1}`,
			name: req.name,
			system_prompt: req.system_prompt,
			tools: req.tools,
		};
		this.assistants.push(assistant);
		return assistant;
	}

	async getModelThinkingMetadata(
		provider: string,
		model: string,
	): Promise<ModelThinkingMetadataResponse> {
		this.modelThinkingMetadataCount++;
		const allowedFields =
			provider.toLowerCase() === "openrouter" ? ["max_tokens"] : ["effort"];
		return {
			provider,
			model,
			supports_thinking: true,
			thinking_controls: {
				supported: true,
				allowed_fields: allowedFields,
				defaults_only: false,
			},
		};
	}

	async listModels(): Promise<ModelsListResponse> {
		this.listModelsCount++;
		return {
			models: [
				{
					name: "gpt-5.5",
					provider: "openai",
					model_type: "llm",
					supports_thinking: true,
					thinking_controls: {
						supported: true,
						allowed_fields: ["effort"],
						defaults_only: false,
					},
				},
			],
			total: 1,
		};
	}

	sourceForThread(): "byok" | "backboard" {
		return this.threadSource;
	}

	async sendMessage(): Promise<BackboardResponse> {
		return {
			thread_id: "compaction_helper",
			content:
				"## Objective\nKeep the work moving.\n\n## Current State\nHistory compressed.",
			status: "COMPLETED",
			tool_calls: null,
			model_provider: "anthropic",
			model_name: "test",
		};
	}

	async *runMessage(
		req: SendMessageRequest,
		options?: { attachmentFilePaths?: string[] },
	): AsyncIterable<ProviderEvent> {
		this.messageRequests.push(req);
		this.messageAttachmentPaths.push(options?.attachmentFilePaths);
		yield* this.first;
	}

	async *runToolOutputs(
		req: SubmitToolOutputsRequest,
	): AsyncIterable<ProviderEvent> {
		this.toolOutputRequests.push(req);
		yield* this.second;
	}

	async preserveFailedToolOutputs(
		req: SubmitToolOutputsRequest,
	): Promise<string | null> {
		this.preservedToolOutputRequests.push(req);
		return null;
	}
}

class DisposableTool extends TestTool {
	disposeCount = 0;

	constructor(
		name: string,
		private readonly disposeError?: Error,
	) {
		super({ name });
	}

	override async dispose(): Promise<void> {
		this.disposeCount++;
		if (this.disposeError) throw this.disposeError;
	}
}

function controllerWith(
	client: FakeClient,
	tool: TestTool | TestTool[],
	argv: string[] = [],
	options: { onThreadReplaced?: (threadId: string | null) => void } = {},
): { ctrl: AgentController; events: AgentEvent[]; session: Session } {
	const config = new Config({ env, argv });
	const bus = new EventBus();
	const events: AgentEvent[] = [];
	bus.onAny((e) => events.push(e));
	const session = new Session("sess_test");
	const registry = new ToolRegistry(Array.isArray(tool) ? tool : [tool]);
	const skillController = new SkillController({ cwd: config.cwd, bus });
	const ctrl = new AgentController({
		config,
		bus,
		session,
		registry,
		client: client as unknown as BackboardClient,
		skillController,
		permissions: TEST_PERMISSIONS,
		...(options.onThreadReplaced
			? { onThreadReplaced: options.onThreadReplaced }
			: {}),
	});
	return { ctrl, events, session };
}

describe("AgentController loop (mocked Backboard)", () => {
	it("emits turn:start and accepted prompt before assistant setup finishes", async () => {
		const client = new FakeClient(
			[
				{ kind: "thread", threadId: "thr_1" },
				{ kind: "assistant_delta", text: "done" },
				{ kind: "completed" },
			],
			[],
		);
		client.listAssistantsDelayMs = 50;
		const { ctrl, events } = controllerWith(
			client,
			new TestTool({ name: "Echo", readOnly: true }),
		);

		const promise = ctrl.submit("do it");
		expect(events.map((e) => e.type)).toEqual(["turn:start", "user:message"]);
		await promise;
	});

	it("runs a full tool round-trip to completion", async () => {
		const client = new FakeClient(
			[
				{ kind: "thread", threadId: "thr_1" },
				{
					kind: "requires_action",
					runId: "run_1",
					calls: [{ id: "c1", name: "Echo", input: {} }],
				},
			],
			[{ kind: "assistant_delta", text: "all done" }, { kind: "completed" }],
		);
		const { ctrl, events } = controllerWith(
			client,
			new TestTool({ name: "Echo", readOnly: true }),
		);

		const status = await ctrl.submit("do it");
		expect(status).toBe("completed");

		const types = events.map((e) => e.type);
		expect(types).toContain("user:message");
		expect(types).toContain("turn:start");
		expect(types).toContain("tool:requested");
		expect(types).toContain("tool:start");
		expect(types).toContain("tool:result");
		// The final-verification nudge only fires after a tool-heavy turn
		// (FINAL_VERIFICATION_MIN_TOOL_CALLS); this run made a single call, so
		// the final answer is shown directly instead of being superseded.
		expect(types).toContain("assistant:message");
		expect(types).not.toContain("assistant:message:discard");
		expect(types[types.length - 1]).toBe("turn:end");
	});

	it("starts a safe tool mid-stream when tool_call_ready arrives early", async () => {
		let requiresActionYielded = false;
		let startedDuringStream = false;
		let runs = 0;
		class EarlyReadyClient extends FakeClient {
			constructor() {
				super(
					[],
					[{ kind: "assistant_delta", text: "done" }, { kind: "completed" }],
				);
			}

			override async *runMessage(
				req: SendMessageRequest,
			): AsyncIterable<ProviderEvent> {
				this.messageRequests.push(req);
				yield { kind: "thread", threadId: "thr_1" };
				yield { kind: "tool_started", id: "c1", name: "Echo" };
				yield {
					kind: "tool_ready",
					call: { id: "c1", name: "Echo", input: { value: "v" } },
				};
				// The rest of the model turn is still streaming while the
				// early-offered call should already be executing.
				await delay(30);
				requiresActionYielded = true;
				yield {
					kind: "requires_action",
					runId: "run_1",
					calls: [{ id: "c1", name: "Echo", input: { value: "v" } }],
				};
			}
		}
		const client = new EarlyReadyClient();
		const { ctrl } = controllerWith(
			client,
			new TestTool({
				name: "Echo",
				readOnly: true,
				onStart: () => {
					runs++;
					startedDuringStream ||= !requiresActionYielded;
				},
			}),
		);

		const status = await ctrl.submit("do it");

		expect(status).toBe("completed");
		expect(startedDuringStream).toBe(true);
		// The early run is reused at finalize, never re-executed, and the
		// outputs are still submitted as a single batch.
		expect(runs).toBe(1);
		expect(client.toolOutputRequests).toHaveLength(1);
		expect(
			client.toolOutputRequests[0]?.tool_outputs.map((o) => o.tool_call_id),
		).toEqual(["c1"]);
	});

	it("includes the startup environment prompt in assistant and turn prompts", async () => {
		const client = new FakeClient(
			[
				{ kind: "thread", threadId: "thr_1" },
				{ kind: "assistant_delta", text: "done" },
				{ kind: "completed" },
			],
			[],
		);
		const config = new Config({ env, argv: [] });
		const bus = new EventBus();
		const session = new Session("sess_test");
		const registry = new ToolRegistry([
			new TestTool({ name: "Echo", readOnly: true }),
		]);
		const skillController = new SkillController({ cwd: config.cwd, bus });
		const startupEnvironmentPrompt = "Environment snapshot\n- OS: test";
		const ctrl = new AgentController({
			config,
			bus,
			session,
			registry,
			client: client as unknown as BackboardClient,
			skillController,
			startupEnvironmentPrompt,
			permissions: TEST_PERMISSIONS,
		});

		await ctrl.submit("do it");

		expect(client.assistantRequests[0]?.system_prompt).toContain(
			startupEnvironmentPrompt,
		);
		expect(client.messageRequests[0]?.system_prompt).toContain(
			startupEnvironmentPrompt,
		);
	});
	it("sends a hidden final verification nudge after tool work", async () => {
		class FinalVerificationClient extends FakeClient {
			constructor() {
				super(
					[],
					[{ kind: "assistant_delta", text: "done" }, { kind: "completed" }],
				);
			}

			override async *runMessage(
				req: SendMessageRequest,
			): AsyncIterable<ProviderEvent> {
				this.messageRequests.push(req);
				if (this.messageRequests.length === 1) {
					yield { kind: "thread", threadId: "thr_1" };
					yield {
						kind: "requires_action",
						runId: "run_1",
						// Enough calls to cross FINAL_VERIFICATION_MIN_TOOL_CALLS.
						calls: Array.from(
							{ length: FINAL_VERIFICATION_MIN_TOOL_CALLS },
							(_, index) => ({ id: `c${index + 1}`, name: "Echo", input: {} }),
						),
					};
					return;
				}
				yield { kind: "assistant_delta", text: "verified" };
				yield { kind: "completed" };
			}
		}
		const client = new FinalVerificationClient();
		const { ctrl } = controllerWith(
			client,
			new TestTool({ name: "Echo", readOnly: true }),
			["--final-verification"],
		);

		const status = await ctrl.submit("do it");

		expect(status).toBe("completed");
		expect(client.messageRequests.map((request) => request.content)).toEqual([
			"do it",
			expect.stringContaining("Before finalizing"),
		]);
		expect(client.messageRequests[1]?.content).toContain(
			"Required files, output formats, command behavior, and stated acceptance criteria are satisfied",
		);
		expect(client.messageRequests[1]?.content).toContain(
			"Relevant validators or tests were run",
		);
		expect(client.messageRequests[1]?.content).toContain(
			"respond with a concise final answer using Markdown section headings",
		);
		expect(client.toolOutputRequests).toHaveLength(1);
	});

	it("does not send the final verification nudge when disabled", async () => {
		class NoNudgeClient extends FakeClient {
			constructor() {
				super(
					[],
					[{ kind: "assistant_delta", text: "done" }, { kind: "completed" }],
				);
			}

			override async *runMessage(
				req: SendMessageRequest,
			): AsyncIterable<ProviderEvent> {
				this.messageRequests.push(req);
				yield { kind: "thread", threadId: "thr_1" };
				yield {
					kind: "requires_action",
					runId: "run_1",
					calls: [{ id: "c1", name: "Echo", input: {} }],
				};
			}
		}
		const client = new NoNudgeClient();
		const { ctrl } = controllerWith(
			client,
			new TestTool({ name: "Echo", readOnly: true }),
			["--no-final-verification"],
		);

		const status = await ctrl.submit("do it");

		expect(status).toBe("completed");
		expect(client.messageRequests.map((request) => request.content)).toEqual([
			"do it",
		]);
	});

	it("retries retryable initial stream server failures", async () => {
		class RetryMessageClient extends FakeClient {
			constructor() {
				super([], []);
			}

			override async *runMessage(
				req: SendMessageRequest,
			): AsyncIterable<ProviderEvent> {
				this.messageRequests.push(req);
				if (this.messageRequests.length === 1) {
					yield {
						kind: "failed",
						error: "Upstream idle timeout exceeded",
						retryable: true,
					};
					return;
				}
				yield { kind: "thread", threadId: "thr_retry" };
				yield { kind: "assistant_delta", text: "recovered" };
				yield { kind: "completed" };
			}
		}
		const client = new RetryMessageClient();
		const { ctrl } = controllerWith(
			client,
			new TestTool({ name: "Echo", readOnly: true }),
		);

		const status = await ctrl.submit("do it");

		expect(status).toBe("completed");
		expect(client.messageRequests).toHaveLength(2);
	});

	it("retries retryable tool-output continuation failures without rerunning tools", async () => {
		const toolStarts: string[] = [];
		class RetryToolOutputClient extends FakeClient {
			constructor() {
				super([], []);
			}

			override async *runMessage(
				req: SendMessageRequest,
			): AsyncIterable<ProviderEvent> {
				this.messageRequests.push(req);
				yield { kind: "thread", threadId: "thr_retry" };
				yield {
					kind: "requires_action",
					runId: "run_1",
					calls: [{ id: "call_1", name: "Echo", input: { value: "ok" } }],
				};
			}

			override async *runToolOutputs(
				req: SubmitToolOutputsRequest,
			): AsyncIterable<ProviderEvent> {
				this.toolOutputRequests.push(req);
				if (this.toolOutputRequests.length === 1) {
					yield {
						kind: "failed",
						error: "Failed to continue streaming after tool outputs.",
						retryable: true,
					};
					return;
				}
				yield { kind: "assistant_delta", text: "done" };
				yield { kind: "completed" };
			}
		}
		const client = new RetryToolOutputClient();
		const { ctrl } = controllerWith(
			client,
			new TestTool({
				name: "Echo",
				readOnly: true,
				onStart: (name) => toolStarts.push(name),
			}),
		);

		const status = await ctrl.submit("do it");

		expect(status).toBe("completed");
		expect(client.toolOutputRequests).toHaveLength(2);
		expect(toolStarts).toEqual(["Echo"]);
	});

	it("fails after the default retryable stream server retry budget", async () => {
		class AlwaysRetryableFailureClient extends FakeClient {
			constructor() {
				super([], []);
			}

			override async *runMessage(
				req: SendMessageRequest,
			): AsyncIterable<ProviderEvent> {
				this.messageRequests.push(req);
				yield {
					kind: "failed",
					error: "Upstream idle timeout exceeded",
					retryable: true,
				};
			}
		}
		const client = new AlwaysRetryableFailureClient();
		const { ctrl } = controllerWith(
			client,
			new TestTool({ name: "Echo", readOnly: true }),
		);

		const status = await ctrl.submit("do it");

		expect(status).toBe("failed");
		expect(client.messageRequests).toHaveLength(3);
	});

	it("does not retry non-retryable stream failures", async () => {
		const client = new FakeClient(
			[
				{
					kind: "failed",
					error: "Backboard requested tool outputs without tool calls",
				},
			],
			[],
		);
		const { ctrl } = controllerWith(
			client,
			new TestTool({ name: "Echo", readOnly: true }),
		);

		const status = await ctrl.submit("do it");

		expect(status).toBe("failed");
		expect(client.messageRequests).toHaveLength(1);
	});

	it("queues prompts submitted while a turn is running", async () => {
		const client = new FakeClient(
			[
				{ kind: "thread", threadId: "thr_1" },
				{ kind: "assistant_delta", text: "done" },
				{ kind: "completed" },
			],
			[],
		);
		const { ctrl, events } = controllerWith(
			client,
			new TestTool({ name: "Echo", readOnly: true }),
		);

		const first = ctrl.submit("first");
		const second = ctrl.submit("second");

		expect(
			events
				.filter((event) => event.type === "user:message")
				.map((event) => event.text),
		).toEqual(["first"]);
		await expect(Promise.all([first, second])).resolves.toEqual([
			"completed",
			"completed",
		]);
		expect(
			events
				.filter(
					(event) =>
						event.type === "user:message" || event.type === "assistant:message",
				)
				.map((event) =>
					event.type === "user:message" ? `user:${event.text}` : "assistant",
				),
		).toEqual(["user:first", "assistant", "user:second", "assistant"]);
		expect(client.messageRequests.map((request) => request.content)).toEqual([
			"first",
			"second",
		]);
		expect(client.messageRequests[1]?.thread_id).toBe("thr_1");
	});

	it("prioritizes steering prompts ahead of queued prompts", async () => {
		const client = new FakeClient(
			[
				{ kind: "thread", threadId: "thr_1" },
				{
					kind: "requires_action",
					runId: "run_1",
					calls: [{ id: "c1", name: "Echo", input: {} }],
				},
			],
			[{ kind: "assistant_delta", text: "done" }, { kind: "completed" }],
		);
		const { ctrl, events } = controllerWith(
			client,
			new TestTool({ name: "Echo", readOnly: true, delayMs: 100 }),
		);

		const first = ctrl.submit("first");
		while (!events.some((event) => event.type === "tool:start")) {
			await delay(1);
		}
		const queued = ctrl.submit("queued");
		const steering = ctrl.steer("steer");

		await expect(Promise.all([first, steering, queued])).resolves.toEqual([
			"cancelled",
			"completed",
			"completed",
		]);
		expect(
			client.messageRequests
				.map((request) => request.content)
				.filter((content) => !content.startsWith("Before finalizing")),
		).toEqual(["first", "steer", "queued"]);
		expect(
			events
				.filter((event) => event.type === "user:message")
				.map((event) => event.text),
		).toEqual(["first", "queued"]);
	});

	it("clears queued prompts on user cancellation", async () => {
		const client = new FakeClient(
			[
				{ kind: "thread", threadId: "thr_1" },
				{
					kind: "requires_action",
					runId: "run_1",
					calls: [{ id: "c1", name: "Echo", input: {} }],
				},
			],
			[{ kind: "assistant_delta", text: "done" }, { kind: "completed" }],
		);
		const { ctrl, events } = controllerWith(
			client,
			new TestTool({ name: "Echo", readOnly: true, delayMs: 100 }),
		);

		const first = ctrl.submit("first");
		while (!events.some((event) => event.type === "tool:start")) {
			await delay(1);
		}
		const queued = ctrl.submit("queued");
		ctrl.cancel({ clearQueue: true });

		await expect(Promise.all([first, queued])).resolves.toEqual([
			"cancelled",
			"cancelled",
		]);
		expect(client.messageRequests.map((request) => request.content)).toEqual([
			"first",
		]);
		expect(
			events
				.filter((event) => event.type === "user:message")
				.map((event) => event.text),
		).toEqual(["first"]);
	});

	it("continues queued prompts after cancelling only the active turn", async () => {
		const client = new FakeClient(
			[
				{ kind: "thread", threadId: "thr_1" },
				{
					kind: "requires_action",
					runId: "run_1",
					calls: [{ id: "c1", name: "Echo", input: {} }],
				},
			],
			[{ kind: "assistant_delta", text: "done" }, { kind: "completed" }],
		);
		const { ctrl, events } = controllerWith(
			client,
			new TestTool({ name: "Echo", readOnly: true, delayMs: 100 }),
		);

		const first = ctrl.submit("first");
		while (!events.some((event) => event.type === "tool:start")) {
			await delay(1);
		}
		const queued = ctrl.submit("queued");
		ctrl.cancel();

		await expect(Promise.all([first, queued])).resolves.toEqual([
			"cancelled",
			"completed",
		]);
		expect(
			client.messageRequests
				.map((request) => request.content)
				.filter((content) => !content.startsWith("Before finalizing")),
		).toEqual(["first", "queued"]);
		expect(
			events
				.filter((event) => event.type === "user:message")
				.map((event) => event.text),
		).toEqual(["first", "queued"]);
	});

	it("passes startup model, memory, thinking, profile, and tool filters to Backboard", async () => {
		const client = new FakeClient(
			[
				{ kind: "thread", threadId: "thr_1" },
				{ kind: "assistant_delta", text: "done" },
				{ kind: "completed" },
			],
			[],
		);
		const config = new Config({
			env,
			argv: [
				"--model",
				"openai/gpt-5.5",
				"--memory",
				"auto",
				"--memory-profile",
				"coding",
				"--thinking",
				"high",
				"--excluded-tools",
				"Hidden",
			],
		});
		const bus = new EventBus();
		const session = new Session("sess_test");
		const registry = new ToolRegistry([
			new TestTool({ name: "Visible", readOnly: true }),
			new TestTool({ name: "Hidden", readOnly: true }),
		]);
		const skillController = new SkillController({ cwd: config.cwd, bus });
		const ctrl = new AgentController({
			config,
			bus,
			session,
			registry,
			client: client as unknown as BackboardClient,
			skillController,
			permissions: TEST_PERMISSIONS,
		});

		await ctrl.submit("do it");

		const req = client.messageRequests[0];
		expect(req).toBeDefined();
		if (!req) throw new Error("expected a message request");
		expect(req.llm_provider).toBe("openai");
		expect(req.model_name).toBe("gpt-5.5");
		expect(req.memory).toBe("Auto");
		expect(req.memory_profile).toBe("code");
		expect(req.thinking).toEqual({ effort: "high" });
		expect(req.system_prompt).toContain("You are R-CLI");
		expect(req.system_prompt).not.toContain("Model profile:");
		expect(req.tools?.map((tool) => tool.function.name)).toEqual(["Visible"]);
	});

	it("resolves dynamic thinking before sending requests to Backboard", async () => {
		const client = new FakeClient(
			[
				{ kind: "thread", threadId: "thr_1" },
				{ kind: "assistant_delta", text: "done" },
				{ kind: "completed" },
			],
			[],
		);
		const config = new Config({
			env,
			argv: ["--model", "openrouter/deepseek-r1", "--thinking", "dynamic"],
		});
		const bus = new EventBus();
		const session = new Session("sess_test");
		const registry = new ToolRegistry([
			new TestTool({ name: "Visible", readOnly: true }),
		]);
		const skillController = new SkillController({ cwd: config.cwd, bus });
		const ctrl = new AgentController({
			config,
			bus,
			session,
			registry,
			client: client as unknown as BackboardClient,
			skillController,
			permissions: TEST_PERMISSIONS,
		});

		await ctrl.submit("do it");

		const thinking = client.messageRequests[0]?.thinking;
		expect(thinking).toEqual({ max_tokens: 4096 });
		expect(client.modelThinkingMetadataCount).toBe(1);
		expect(client.listModelsCount).toBe(0);
	});

	it("sends dynamic thinking overrides on tool continuations", async () => {
		const client = new FakeClient(
			[
				{ kind: "thread", threadId: "thr_1" },
				{
					kind: "requires_action",
					runId: "run_1",
					calls: [{ id: "c1", name: "Echo", input: {} }],
				},
			],
			[{ kind: "assistant_delta", text: "done" }, { kind: "completed" }],
		);
		const config = new Config({
			env,
			argv: ["--model", "openai/gpt-5.5", "--thinking", "dynamic"],
		});
		const bus = new EventBus();
		const session = new Session("sess_test");
		const registry = new ToolRegistry([
			new TestTool({ name: "Echo", readOnly: true }),
		]);
		const skillController = new SkillController({ cwd: config.cwd, bus });
		const ctrl = new AgentController({
			config,
			bus,
			session,
			registry,
			client: client as unknown as BackboardClient,
			skillController,
			permissions: TEST_PERMISSIONS,
		});

		await ctrl.submit("do it");

		expect(client.messageRequests[0]?.thinking).toEqual({ effort: "medium" });
		expect(client.toolOutputRequests[0]?.thinking).toEqual({
			effort: "medium",
		});
		expect(client.modelThinkingMetadataCount).toBe(1);
		expect(client.listModelsCount).toBe(0);
	});

	it("omits continuation thinking for static thinking", async () => {
		const client = new FakeClient(
			[
				{ kind: "thread", threadId: "thr_1" },
				{
					kind: "requires_action",
					runId: "run_1",
					calls: [{ id: "c1", name: "Echo", input: {} }],
				},
			],
			[{ kind: "assistant_delta", text: "done" }, { kind: "completed" }],
		);
		const config = new Config({
			env,
			argv: ["--model", "openai/gpt-5.5", "--thinking", "high"],
		});
		const bus = new EventBus();
		const session = new Session("sess_test");
		const registry = new ToolRegistry([
			new TestTool({ name: "Echo", readOnly: true }),
		]);
		const skillController = new SkillController({ cwd: config.cwd, bus });
		const ctrl = new AgentController({
			config,
			bus,
			session,
			registry,
			client: client as unknown as BackboardClient,
			skillController,
			permissions: TEST_PERMISSIONS,
		});

		await ctrl.submit("do it");

		expect(client.messageRequests[0]?.thinking).toEqual({ effort: "high" });
		expect(client.toolOutputRequests[0]).not.toHaveProperty("thinking");
	});

	it("omits continuation thinking for off so backend reuses initial null", async () => {
		const client = new FakeClient(
			[
				{ kind: "thread", threadId: "thr_1" },
				{
					kind: "requires_action",
					runId: "run_1",
					calls: [{ id: "c1", name: "Echo", input: {} }],
				},
			],
			[{ kind: "assistant_delta", text: "done" }, { kind: "completed" }],
		);
		const config = new Config({
			env,
			argv: ["--model", "openai/gpt-5.5", "--thinking", "off"],
		});
		const bus = new EventBus();
		const session = new Session("sess_test");
		const registry = new ToolRegistry([
			new TestTool({ name: "Echo", readOnly: true }),
		]);
		const skillController = new SkillController({ cwd: config.cwd, bus });
		const ctrl = new AgentController({
			config,
			bus,
			session,
			registry,
			client: client as unknown as BackboardClient,
			skillController,
			permissions: TEST_PERMISSIONS,
		});

		await ctrl.submit("do it");

		expect(client.messageRequests[0]?.thinking).toBeNull();
		expect(client.toolOutputRequests[0]).not.toHaveProperty("thinking");
	});

	it("does not thrash max during persistent dynamic failures", async () => {
		class MultiRoundClient extends FakeClient {
			private round = 0;

			constructor() {
				super([], []);
			}

			override async *runMessage(
				req: SendMessageRequest,
			): AsyncIterable<ProviderEvent> {
				this.messageRequests.push(req);
				yield { kind: "thread", threadId: "thr_1" };
				yield {
					kind: "requires_action",
					runId: "run_1",
					calls: [{ id: "c1", name: "Fail", input: {} }],
				};
			}

			override async *runToolOutputs(
				req: SubmitToolOutputsRequest,
			): AsyncIterable<ProviderEvent> {
				this.toolOutputRequests.push(req);
				this.round++;
				const next = [
					{ id: "c2", name: "Fail" },
					{ id: "c3", name: "Echo" },
					{ id: "c4", name: "Fail" },
					{ id: "c5", name: "Fail" },
				][this.round - 1];
				if (!next) {
					yield { kind: "assistant_delta", text: "done" };
					yield { kind: "completed" };
					return;
				}
				yield {
					kind: "requires_action",
					runId: "run_1",
					calls: [{ id: next.id, name: next.name, input: {} }],
				};
			}
		}

		const client = new MultiRoundClient();
		const config = new Config({
			env,
			argv: ["--model", "openai/gpt-5.5", "--thinking", "dynamic"],
		});
		const bus = new EventBus();
		const session = new Session("sess_test");
		const registry = new ToolRegistry([
			new TestTool({ name: "Fail", readOnly: true, throws: true }),
			new TestTool({ name: "Echo", readOnly: true }),
		]);
		const skillController = new SkillController({ cwd: config.cwd, bus });
		const ctrl = new AgentController({
			config,
			bus,
			session,
			registry,
			client: client as unknown as BackboardClient,
			skillController,
			permissions: TEST_PERMISSIONS,
		});

		await ctrl.submit("do it");

		expect(client.toolOutputRequests.map((req) => req.thinking)).toEqual([
			{ effort: "high" },
			{ effort: "max" },
			{ effort: "medium" },
			{ effort: "high" },
			{ effort: "max" },
		]);
	});

	it("keeps the backend thread when the assistant shape is unchanged", async () => {
		const client = new FakeClient(
			[
				{ kind: "thread", threadId: "thr_1" },
				{ kind: "assistant_delta", text: "done" },
				{ kind: "completed" },
			],
			[],
		);
		const { ctrl } = controllerWith(
			client,
			new TestTool({ name: "Echo", readOnly: true }),
		);

		await ctrl.submit("first");
		await ctrl.submit("second");

		expect(client.assistantRequests.length).toBe(1);
		expect(client.messageRequests[0]?.thread_id).toBeUndefined();
		expect(client.messageRequests[1]?.thread_id).toBe("thr_1");
		expect(client.messageRequests[1]?.assistant_id).toBe("asst_1");
	});

	it("loads skill instructions only after explicit skill loading", async () => {
		const root = await tempDir();
		await writeSkill(root, "docs", "doc skill", "docs body");
		const client = new FakeClient(
			[
				{ kind: "thread", threadId: "thr_1" },
				{ kind: "assistant_delta", text: "done" },
				{ kind: "completed" },
			],
			[],
		);
		const config = new Config({ env, argv: ["--cwd", root] });
		const bus = new EventBus();
		const session = new Session("sess_test");
		const registry = new ToolRegistry([
			new TestTool({ name: "Visible", readOnly: true }),
		]);
		const skillController = new SkillController({ cwd: config.cwd, bus });
		const ctrl = new AgentController({
			config,
			bus,
			session,
			registry,
			client: client as unknown as BackboardClient,
			skillController,
			permissions: TEST_PERMISSIONS,
		});

		await ctrl.submit("$docs use it");
		const beforeLoad = client.messageRequests[0];
		expect(beforeLoad).toBeDefined();
		if (!beforeLoad) throw new Error("expected a message request");
		expect(beforeLoad.system_prompt).not.toContain("# Skill: docs");
		expect(beforeLoad.assistant_id).toBe("asst_1");

		const tabs = await skillController.listSkillTabs();
		const repoTab = tabs.find((tab) => tab.id === "repo");
		const item = repoTab?.items.find((skill) => skill.name === "docs");
		expect(item).toBeDefined();
		if (!item) throw new Error("expected docs skill");
		expect(item.active).toBe(false);
		expect(item.description).toBe("doc skill");
		expect(item.source).toBe("repo");
		const personalTab = tabs.find((tab) => tab.id === "personal");
		expect(personalTab?.items.some((skill) => skill.name === "docs")).toBe(
			false,
		);
		const loadResult = await skillController.selectSkill(item);
		expect(loadResult.selectedName).toBe("docs");
		expect(loadResult.action).toBe("activated");
		const tabsAfterLoad = await skillController.listSkillTabs();
		expect(
			tabsAfterLoad
				.find((tab) => tab.id === "repo")
				?.items.find((skill) => skill.name === "docs")?.active,
		).toBe(true);

		await ctrl.submit("$docs use it");

		const req = client.messageRequests[1];
		expect(req).toBeDefined();
		if (!req) throw new Error("expected a message request");
		expect(req.assistant_id).toBe("asst_1");
		expect(req.thread_id).toBe("thr_1");
		expect(req.content).toBe("$docs use it");
		expect(req.system_prompt).toContain("- docs: doc skill");
		expect(req.system_prompt).toContain("# Skill: docs");
		expect(req.system_prompt).toContain("docs body");
		expect(req.tools?.map((tool) => tool.function.name)).toEqual(["Visible"]);
		expect(client.assistantRequests.length).toBe(1);

		await ctrl.submit("continue");

		const afterActivation = client.messageRequests[2];
		expect(afterActivation).toBeDefined();
		if (!afterActivation) throw new Error("expected a message request");
		expect(afterActivation.assistant_id).toBe("asst_1");
		expect(afterActivation.thread_id).toBe("thr_1");
		expect(afterActivation.system_prompt).toContain("- docs: doc skill");
		expect(afterActivation.system_prompt).not.toContain("# Skill: docs");
		// Real skill filesystem I/O across three turns runs close to the default
		// 5s budget under full-file load; give it headroom to avoid a flake.
	}, 20_000);

	it("transfers compaction ownership only for BYOK threads", async () => {
		const replacements: Array<string | null> = [];
		const backboard = new FakeClient([], []);
		const first = controllerWith(
			backboard,
			new TestTool({ name: "Echo" }),
			[],
			{ onThreadReplaced: (threadId) => replacements.push(threadId) },
		);
		first.session.threadId = "thread_backboard";
		first.session.addMessage(userMessage("one"));
		first.session.addMessage(assistantMessage("two"));
		first.session.addMessage(userMessage("three"));
		first.session.addMessage(assistantMessage("four"));
		await first.ctrl.compact();

		const byok = new FakeClient([], []);
		byok.threadSource = "byok";
		const second = controllerWith(byok, new TestTool({ name: "Echo" }), [], {
			onThreadReplaced: (threadId) => replacements.push(threadId),
		});
		second.session.threadId = "byok_previous";
		second.session.addMessage(userMessage("one"));
		second.session.addMessage(assistantMessage("two"));
		second.session.addMessage(userMessage("three"));
		second.session.addMessage(assistantMessage("four"));
		await second.ctrl.compact();

		expect(replacements).toEqual([null, "byok_previous"]);
	});

	it("cancels an in-flight turn", async () => {
		const client = new FakeClient(
			[
				{ kind: "thread", threadId: "thr_2" },
				{
					kind: "requires_action",
					runId: "run_2",
					calls: [{ id: "c1", name: "Slow", input: {} }],
				},
			],
			[{ kind: "completed" }],
		);
		const { ctrl, events } = controllerWith(
			client,
			new TestTool({ name: "Slow", readOnly: false, delayMs: 100 }),
		);

		const promise = ctrl.submit("long task");
		setTimeout(() => ctrl.cancel(), 20);
		const status = await promise;

		expect(status).toBe("cancelled");
		expect(events.map((e) => e.type)).toContain("turn:cancelled");
	});

	it("preserves a synthetic tool result when cancellation interrupts execution", async () => {
		const client = new FakeClient(
			[
				{ kind: "thread", threadId: "byok_tool_cancel" },
				{
					kind: "tool_ready",
					call: { id: "call_1", name: "SlowWrite", input: {} },
				},
				{
					kind: "requires_action",
					runId: null,
					calls: [{ id: "call_1", name: "SlowWrite", input: {} }],
				},
			],
			[],
		);
		const { ctrl } = controllerWith(
			client,
			new TestTool({ name: "SlowWrite", readOnly: false, delayMs: 100 }),
		);

		const promise = ctrl.submit("run the slow write");
		setTimeout(() => ctrl.cancel(), 20);

		expect(await promise).toBe("cancelled");
		expect(client.preservedToolOutputRequests).toHaveLength(1);
		expect(
			client.preservedToolOutputRequests[0]?.tool_outputs[0]?.output,
		).toContain("interrupted");
	});

	it("keeps completed tool outputs when a later tool is interrupted", async () => {
		const calls = [
			{ id: "call_fast", name: "FastWrite", input: {} },
			{ id: "call_slow", name: "SlowWrite", input: {} },
		];
		const client = new FakeClient(
			[
				{ kind: "thread", threadId: "byok_partial_tool_cancel" },
				{ kind: "tool_ready", call: calls[0] as (typeof calls)[number] },
				{ kind: "tool_ready", call: calls[1] as (typeof calls)[number] },
				{ kind: "requires_action", runId: null, calls },
			],
			[],
		);
		const { ctrl } = controllerWith(client, [
			new TestTool({ name: "FastWrite", readOnly: false }),
			new TestTool({ name: "SlowWrite", readOnly: false, delayMs: 100 }),
		]);

		const promise = ctrl.submit("run both writes");
		setTimeout(() => ctrl.cancel(), 30);

		expect(await promise).toBe("cancelled");
		const outputs = client.preservedToolOutputRequests[0]?.tool_outputs ?? [];
		expect(outputs).toHaveLength(2);
		expect(outputs[0]?.output).not.toContain("interrupted");
		expect(outputs[1]?.output).toContain("interrupted");
	});

	it("cancels while resolving the assistant", async () => {
		const client = new FakeClient(
			[
				{ kind: "thread", threadId: "thr_1" },
				{ kind: "assistant_delta", text: "done" },
				{ kind: "completed" },
			],
			[],
		);
		client.listAssistantsDelayMs = 100;
		const { ctrl, events } = controllerWith(
			client,
			new TestTool({ name: "Echo", readOnly: true }),
		);

		const promise = ctrl.submit("stop early");
		setTimeout(() => ctrl.cancel(), 20);
		const status = await promise;

		expect(status).toBe("cancelled");
		expect(client.messageRequests).toEqual([]);
		expect(client.assistantRequests).toEqual([]);
		expect(events.map((e) => e.type)).toContain("turn:cancelled");
	});

	it("keeps the Backboard thread while changing per-turn tool overrides", async () => {
		const client = new FakeClient(
			[
				{ kind: "thread", threadId: "thr_1" },
				{ kind: "assistant_delta", text: "done" },
				{ kind: "completed" },
			],
			[],
		);
		const config = new Config({ env, argv: [] });
		const bus = new EventBus();
		const session = new Session("sess_test");
		const registry = new ToolRegistry([
			new TestTool({ name: "Visible" }),
			new TestTool({ name: "Computer" }),
		]);
		const skillController = new SkillController({ cwd: config.cwd, bus });
		const ctrl = new AgentController({
			config,
			bus,
			session,
			registry,
			client: client as unknown as BackboardClient,
			skillController,
			permissions: TEST_PERMISSIONS,
		});

		await ctrl.submit("first");
		config.enableComputerUse();
		await ctrl.submit("second");

		expect(client.messageRequests[0]?.thread_id).toBeUndefined();
		expect(client.messageRequests[1]?.thread_id).toBe("thr_1");
		expect(client.messageRequests[1]?.assistant_id).toBe("asst_1");
		expect(client.messageRequests[1]?.content).toBe("second");
		expect(
			client.messageRequests[1]?.tools?.map((tool) => tool.function.name),
		).toEqual(["Visible", "computer"]);
		expect(client.assistantRequests.length).toBe(1);
	});

	it("syncs dynamic MCP tools before building per-turn tool overrides", async () => {
		const client = new FakeClient(
			[
				{ kind: "thread", threadId: "thr_1" },
				{ kind: "assistant_delta", text: "done" },
				{ kind: "completed" },
			],
			[],
		);
		const config = new Config({ env, argv: [] });
		const bus = new EventBus();
		const session = new Session("sess_test");
		const registry = new ToolRegistry([
			new TestTool({ name: "Visible", readOnly: true }),
		]);
		const skillController = new SkillController({ cwd: config.cwd, bus });
		const ctrl = new AgentController({
			config,
			bus,
			session,
			registry,
			client: client as unknown as BackboardClient,
			skillController,
			syncDynamicTools: async () => {
				if (!registry.has("mcp__dynamic__new_tool")) {
					registry.register(
						new TestTool({ name: "mcp__dynamic__new_tool", readOnly: true }),
					);
				}
			},
			permissions: TEST_PERMISSIONS,
		});

		await ctrl.submit("use the current tools");

		expect(
			client.messageRequests[0]?.tools?.map((tool) => tool.function.name),
		).toEqual(["Visible", "mcp__dynamic__new_tool"]);
		const assistantTools = client.assistantRequests[0]?.tools as
			| Array<{ function: { name: string } }>
			| undefined;
		expect(assistantTools?.map((tool) => tool.function.name)).toEqual([
			"Visible",
		]);
	});

	it("enables Browser lazily and disposes it after a turn", async () => {
		const client = new FakeClient(
			[
				{ kind: "thread", threadId: "thr_1" },
				{ kind: "assistant_delta", text: "done" },
				{ kind: "completed" },
			],
			[],
		);
		const config = new Config({ env, argv: [] });
		const bus = new EventBus();
		const session = new Session("sess_test");
		const browser = new DisposableTool("Browser");
		const registry = new ToolRegistry([browser]);
		const skillController = new SkillController({ cwd: config.cwd, bus });
		const ctrl = new AgentController({
			config,
			bus,
			session,
			registry,
			client: client as unknown as BackboardClient,
			skillController,
			permissions: TEST_PERMISSIONS,
		});

		ctrl.enableBrowserUse();
		expect(config.isBrowserUseEnabled).toBe(true);
		expect(browser.disposeCount).toBe(0);

		await ctrl.submit("do it");

		expect(browser.disposeCount).toBe(1);
		expect(client.assistantRequests[0]?.system_prompt).not.toContain(
			"- Browser:",
		);
		expect(client.assistantRequests[0]?.tools).toEqual([]);
		expect(client.messageRequests[0]?.system_prompt).toContain("- Browser:");
		expect(
			client.messageRequests[0]?.tools?.map((tool) => tool.function.name),
		).toEqual(["browser"]);
	});

	it("reports cleanup failures without leaving the controller running", async () => {
		const client = new FakeClient(
			[
				{ kind: "thread", threadId: "thr_1" },
				{ kind: "assistant_delta", text: "done" },
				{ kind: "completed" },
			],
			[],
		);
		const config = new Config({ env, argv: [] });
		const bus = new EventBus();
		const events: AgentEvent[] = [];
		bus.onAny((event) => events.push(event));
		const session = new Session("sess_test");
		const tool = new DisposableTool("Cleanup", new Error("dispose failed"));
		const registry = new ToolRegistry([tool]);
		const skillController = new SkillController({ cwd: config.cwd, bus });
		const ctrl = new AgentController({
			config,
			bus,
			session,
			registry,
			client: client as unknown as BackboardClient,
			skillController,
			permissions: TEST_PERMISSIONS,
		});

		const status = await ctrl.submit("do it");

		expect(status).toBe("completed");
		expect(ctrl.isRunning).toBe(false);
		expect(events).toContainEqual({
			type: "run:error",
			error: "Tool cleanup failed for Cleanup: dispose failed",
		});
	});
});

describe("AgentController attachment file paths", () => {
	it("puts the staged file paths on the first run request only", async () => {
		const client = new FakeClient(
			[
				{ kind: "thread", threadId: "thr_1" },
				{ kind: "assistant_delta", text: "done" },
				{ kind: "completed" },
			],
			[],
		);
		const { ctrl } = controllerWith(
			client,
			new TestTool({ name: "Echo", readOnly: true }),
		);

		const status = await ctrl.submit("do it", {
			attachmentFilePaths: ["/tmp/a.png", "/tmp/b.pdf"],
		});

		expect(status).toBe("completed");
		expect(client.messageAttachmentPaths[0]).toEqual([
			"/tmp/a.png",
			"/tmp/b.pdf",
		]);
		expect(client.messageRequests[0]).not.toHaveProperty(
			"attachment_file_paths",
		);
	});

	it("keeps attachments off nudge and tool-round requests", async () => {
		class ToolThenNudgeClient extends FakeClient {
			constructor() {
				super(
					[],
					[{ kind: "assistant_delta", text: "done" }, { kind: "completed" }],
				);
			}
			override async *runMessage(
				req: SendMessageRequest,
				options?: { attachmentFilePaths?: string[] },
			): AsyncIterable<ProviderEvent> {
				this.messageRequests.push(req);
				this.messageAttachmentPaths.push(options?.attachmentFilePaths);
				if (this.messageRequests.length === 1) {
					yield { kind: "thread", threadId: "thr_1" };
					yield {
						kind: "requires_action",
						runId: "run_1",
						calls: Array.from(
							{ length: FINAL_VERIFICATION_MIN_TOOL_CALLS },
							(_, index) => ({ id: `c${index + 1}`, name: "Echo", input: {} }),
						),
					};
					return;
				}
				yield { kind: "assistant_delta", text: "verified" };
				yield { kind: "completed" };
			}
		}
		const client = new ToolThenNudgeClient();
		const { ctrl } = controllerWith(
			client,
			new TestTool({ name: "Echo", readOnly: true }),
			["--final-verification"],
		);

		await ctrl.submit("do it", { attachmentFilePaths: ["/tmp/a.png"] });

		// First request carries the files; the nudge (second) must not.
		expect(client.messageAttachmentPaths[0]).toEqual(["/tmp/a.png"]);
		expect(client.messageAttachmentPaths[1]).toBeUndefined();
	});

	it("resends the files on a transport retry, matching the resent content", async () => {
		class RetryMessageClient extends FakeClient {
			constructor() {
				super([], []);
			}
			override async *runMessage(
				req: SendMessageRequest,
				options?: { attachmentFilePaths?: string[] },
			): AsyncIterable<ProviderEvent> {
				this.messageRequests.push(req);
				this.messageAttachmentPaths.push(options?.attachmentFilePaths);
				if (this.messageRequests.length === 1) {
					yield {
						kind: "failed",
						error: "Upstream idle timeout exceeded",
						retryable: true,
					};
					return;
				}
				yield { kind: "thread", threadId: "thr_retry" };
				yield { kind: "assistant_delta", text: "recovered" };
				yield { kind: "completed" };
			}
		}
		const client = new RetryMessageClient();
		const { ctrl } = controllerWith(
			client,
			new TestTool({ name: "Echo", readOnly: true }),
		);

		const status = await ctrl.submit("do it", {
			attachmentFilePaths: ["/tmp/a.png"],
		});

		expect(status).toBe("completed");
		expect(client.messageAttachmentPaths).toEqual([
			["/tmp/a.png"],
			["/tmp/a.png"],
		]);
	});

	it("treats an empty path list as no attachments", async () => {
		const client = new FakeClient(
			[
				{ kind: "thread", threadId: "thr_1" },
				{ kind: "assistant_delta", text: "done" },
				{ kind: "completed" },
			],
			[],
		);
		const { ctrl } = controllerWith(
			client,
			new TestTool({ name: "Echo", readOnly: true }),
		);

		await ctrl.submit("do it", { attachmentFilePaths: [] });

		expect(client.messageAttachmentPaths[0]).toBeUndefined();
	});
});

async function tempDir(): Promise<string> {
	return mkdtemp(path.join(os.tmpdir(), "cli-agent-"));
}

async function writeSkill(
	root: string,
	name: string,
	description: string,
	body: string,
): Promise<void> {
	const dir = path.join(root, ".agents", "skills", name);
	await mkdir(dir, { recursive: true });
	await writeFile(
		path.join(dir, "SKILL.md"),
		`---
name: ${name}
description: ${description}
---
${body}
`,
	);
}
