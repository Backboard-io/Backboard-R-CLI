import { afterEach, describe, expect, it } from "bun:test";
import type { OpenAITool } from "../src/core/tools/schema.ts";
import type {
	ProviderEvent,
	SendMessageRequest,
} from "../src/providers/backboard/types.ts";
import { ByokClient } from "../src/providers/byok/ByokClient.ts";
import { ByokConversationStore } from "../src/providers/byok/ByokConversationStore.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

const TOOLS: OpenAITool[] = [
	{
		type: "function",
		function: {
			name: "read_file",
			description: "Read a file",
			parameters: {
				type: "object",
				properties: { path: { type: "string" } },
				required: ["path"],
			},
		},
	},
];

interface CapturedRequest {
	url: string;
	headers: Record<string, string>;
	body: Record<string, unknown>;
}

/** Serves each queued SSE script in order and records what was sent. */
function stubStream(scripts: string[][]): CapturedRequest[] {
	const captured: CapturedRequest[] = [];
	let call = 0;
	globalThis.fetch = (async (url: string, init: RequestInit) => {
		captured.push({
			url: String(url),
			headers: (init.headers ?? {}) as Record<string, string>,
			body: JSON.parse(String(init.body)) as Record<string, unknown>,
		});
		const frames = scripts[call++] ?? [];
		return new Response(
			new ReadableStream({
				start(controller) {
					for (const frame of frames) {
						controller.enqueue(new TextEncoder().encode(`data: ${frame}\n\n`));
					}
					controller.close();
				},
			}),
			{ status: 200 },
		);
	}) as unknown as typeof fetch;
	return captured;
}

function stubAbortableStream(frames: string[]): {
	captured: CapturedRequest[];
	started: Promise<void>;
} {
	const captured: CapturedRequest[] = [];
	let resolveStarted: () => void = () => undefined;
	const started = new Promise<void>((resolve) => {
		resolveStarted = resolve;
	});
	globalThis.fetch = (async (url: string, init: RequestInit) => {
		captured.push({
			url: String(url),
			headers: (init.headers ?? {}) as Record<string, string>,
			body: JSON.parse(String(init.body)) as Record<string, unknown>,
		});
		return new Response(
			new ReadableStream({
				start(controller) {
					for (const frame of frames) {
						controller.enqueue(new TextEncoder().encode(`data: ${frame}\n\n`));
					}
					resolveStarted();
					init.signal?.addEventListener(
						"abort",
						() =>
							controller.error(
								new DOMException("The operation was aborted", "AbortError"),
							),
						{ once: true },
					);
				},
			}),
			{ status: 200 },
		);
	}) as unknown as typeof fetch;
	return { captured, started };
}

async function collect(
	stream: AsyncIterable<ProviderEvent>,
): Promise<ProviderEvent[]> {
	const events: ProviderEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

function anthropicToolTurn(): string[] {
	return [
		JSON.stringify({
			type: "message_start",
			message: { usage: { input_tokens: 100 } },
		}),
		JSON.stringify({
			type: "content_block_start",
			index: 0,
			content_block: { type: "text" },
		}),
		JSON.stringify({
			type: "content_block_delta",
			index: 0,
			delta: { type: "text_delta", text: "Reading it." },
		}),
		JSON.stringify({ type: "content_block_stop", index: 0 }),
		JSON.stringify({
			type: "content_block_start",
			index: 1,
			content_block: { type: "tool_use", id: "toolu_1", name: "read_file" },
		}),
		JSON.stringify({
			type: "content_block_delta",
			index: 1,
			delta: { type: "input_json_delta", partial_json: '{"path":' },
		}),
		JSON.stringify({
			type: "content_block_delta",
			index: 1,
			delta: { type: "input_json_delta", partial_json: '"a.ts"}' },
		}),
		JSON.stringify({ type: "content_block_stop", index: 1 }),
		JSON.stringify({
			type: "message_delta",
			delta: { stop_reason: "tool_use" },
			usage: { output_tokens: 20 },
		}),
		JSON.stringify({ type: "message_stop" }),
	];
}

function anthropicFinalTurn(): string[] {
	return [
		JSON.stringify({
			type: "message_start",
			message: { usage: { input_tokens: 140 } },
		}),
		JSON.stringify({
			type: "content_block_delta",
			index: 0,
			delta: { type: "text_delta", text: "Done." },
		}),
		JSON.stringify({
			type: "message_delta",
			delta: { stop_reason: "end_turn" },
			usage: { output_tokens: 5 },
		}),
		JSON.stringify({ type: "message_stop" }),
	];
}

function client(): ByokClient {
	return new ByokClient((provider) =>
		provider === "anthropic" ? "sk-ant-test" : null,
	);
}

const BASE_REQUEST: SendMessageRequest = {
	content: "read a.ts",
	llm_provider: "anthropic",
	model_name: "claude-opus-5",
	system_prompt: "You are a coding agent.",
	tools: TOOLS,
};

describe("ByokClient", () => {
	it("mints a local thread and maps an Anthropic tool turn to ProviderEvents", async () => {
		stubStream([anthropicToolTurn()]);
		const events = await collect(client().runMessage(BASE_REQUEST));

		expect(events[0]).toEqual({
			kind: "thread",
			threadId: expect.stringMatching(/^byok_/) as unknown as string,
		});
		expect(events).toContainEqual({
			kind: "assistant_delta",
			text: "Reading it.",
		});
		expect(events).toContainEqual({
			kind: "tool_started",
			id: "toolu_1",
			name: "read_file",
		});
		expect(events).toContainEqual({
			kind: "tool_ready",
			call: { id: "toolu_1", name: "read_file", input: { path: "a.ts" } },
		});

		const action = events.at(-1);
		expect(action).toMatchObject({
			kind: "requires_action",
			calls: [{ id: "toolu_1", name: "read_file" }],
		});
	});

	it("reports usage from the vendor stream", async () => {
		stubStream([anthropicToolTurn()]);
		const events = await collect(client().runMessage(BASE_REQUEST));

		expect(events.find((event) => event.kind === "usage")).toMatchObject({
			usage: {
				inputTokens: 100,
				outputTokens: 20,
				totalTokens: 120,
				provider: "anthropic",
				model: "claude-opus-5",
			},
		});
	});

	it("rejects a stream that closes before a terminal event", async () => {
		stubStream([
			[
				JSON.stringify({
					type: "content_block_delta",
					index: 0,
					delta: { type: "text_delta", text: "partial" },
				}),
			],
		]);

		const events = await collect(client().runMessage(BASE_REQUEST));
		expect(events.at(-1)).toMatchObject({
			kind: "failed",
			error: expect.stringContaining("stream closed unexpectedly"),
			retryable: true,
		});
	});

	it("carries the whole conversation into the tool-output continuation", async () => {
		const captured = stubStream([anthropicToolTurn(), anthropicFinalTurn()]);
		const byok = client();

		const first = await collect(byok.runMessage(BASE_REQUEST));
		const threadId = first.find((event) => event.kind === "thread");
		if (threadId?.kind !== "thread") throw new Error("no thread event");

		await collect(
			byok.runToolOutputs({
				thread_id: threadId.threadId,
				tool_outputs: [{ tool_call_id: "toolu_1", output: "file body" }],
				tools: TOOLS,
			}),
		);

		// The vendor is stateless, so the second request must replay everything:
		// user turn, the assistant's tool_use, and the tool_result.
		const messages = captured[1]?.body.messages as Array<{
			role: string;
			content: Array<Record<string, unknown>>;
		}>;
		expect(messages).toHaveLength(3);
		expect(messages[0]?.role).toBe("user");
		expect(messages[1]).toMatchObject({
			role: "assistant",
			content: [
				{ type: "text", text: "Reading it." },
				{ type: "tool_use", id: "toolu_1", name: "read_file" },
			],
		});
		expect(messages[2]).toMatchObject({
			role: "user",
			content: [
				{ type: "tool_result", tool_use_id: "toolu_1", content: "file body" },
			],
		});
	});

	it("sends the system prompt and tools in Anthropic's shape", async () => {
		const captured = stubStream([anthropicFinalTurn()]);
		await collect(client().runMessage(BASE_REQUEST));

		expect(captured[0]?.url).toBe("https://api.anthropic.com/v1/messages");
		expect(captured[0]?.headers["x-api-key"]).toBe("sk-ant-test");
		// System is sent as blocks, not a bare string, so the stable prefix can
		// carry a cache breakpoint.
		expect(captured[0]?.body.system).toEqual([
			{
				type: "text",
				text: "You are a coding agent.",
				cache_control: { type: "ephemeral" },
			},
		]);
		expect(captured[0]?.body.tools).toEqual([
			{
				name: "read_file",
				description: "Read a file",
				input_schema: TOOLS[0]?.function.parameters,
				cache_control: { type: "ephemeral" },
			},
		]);
	});

	it("puts a rolling cache breakpoint on the newest message", async () => {
		const captured = stubStream([anthropicToolTurn(), anthropicFinalTurn()]);
		const byok = client();

		const first = await collect(byok.runMessage(BASE_REQUEST));
		const thread = first.find((event) => event.kind === "thread");
		if (thread?.kind !== "thread") throw new Error("no thread event");
		await collect(
			byok.runToolOutputs({
				thread_id: thread.threadId,
				tool_outputs: [{ tool_call_id: "toolu_1", output: "file body" }],
				tools: TOOLS,
			}),
		);

		// Without a breakpoint that advances with the tail, a tool loop resends
		// the whole growing history at full input price on every leg.
		const messages = captured[1]?.body.messages as Array<{
			content: Array<Record<string, unknown>>;
		}>;
		const marked = messages.flatMap((message) =>
			message.content.filter((block) => block.cache_control),
		);
		expect(marked).toHaveLength(1);
		expect(messages.at(-1)?.content.at(-1)?.cache_control).toEqual({
			type: "ephemeral",
		});
	});

	it("counts cached tokens as part of the prompt size", async () => {
		// Anthropic reports input_tokens as uncached-only; context accounting
		// must add the cached portions back or a cached conversation looks empty.
		stubStream([
			[
				JSON.stringify({
					type: "message_start",
					message: {
						usage: {
							input_tokens: 12,
							cache_read_input_tokens: 5000,
							cache_creation_input_tokens: 300,
						},
					},
				}),
				JSON.stringify({
					type: "message_delta",
					delta: { stop_reason: "end_turn" },
					usage: { output_tokens: 40 },
				}),
				JSON.stringify({ type: "message_stop" }),
			],
		]);
		const events = await collect(client().runMessage(BASE_REQUEST));
		const completed = events.at(-1);

		expect(completed).toMatchObject({
			kind: "completed",
			usage: {
				inputTokens: 5312,
				cachedTokens: 5000,
				cacheWriteTokens: 300,
				totalTokens: 5352,
			},
		});
	});

	// Claude 5 rejects the legacy budget shape outright: "thinking.type.enabled
	// is not supported for this model".
	it("asks Claude 5 for adaptive thinking at the requested effort", async () => {
		const captured = stubStream([anthropicFinalTurn()]);
		await collect(
			client().runMessage({ ...BASE_REQUEST, thinking: { effort: "high" } }),
		);

		expect(captured[0]?.body.thinking).toEqual({ type: "adaptive" });
		expect(captured[0]?.body.output_config).toEqual({ effort: "high" });
	});

	it("enables extended thinking with a budget below max_tokens", async () => {
		const captured = stubStream([anthropicFinalTurn()]);
		await collect(
			client().runMessage({
				...BASE_REQUEST,
				model_name: "claude-opus-4-5-20251101",
				thinking: { effort: "high" },
			}),
		);

		const thinking = captured[0]?.body.thinking as {
			type: string;
			budget_tokens: number;
		};
		expect(thinking.type).toBe("enabled");
		expect(thinking.budget_tokens).toBeGreaterThan(0);
		expect(thinking.budget_tokens).toBeLessThan(
			captured[0]?.body.max_tokens as number,
		);
	});

	it("keeps separate conversations for separate threads", async () => {
		const captured = stubStream([
			anthropicFinalTurn(),
			anthropicFinalTurn(),
			anthropicFinalTurn(),
		]);
		const byok = client();

		const first = await collect(byok.runMessage(BASE_REQUEST));
		const thread = first.find((event) => event.kind === "thread");
		if (thread?.kind !== "thread") throw new Error("no thread event");

		// Same thread: history grows. New thread: starts clean.
		await collect(
			byok.runMessage({ ...BASE_REQUEST, thread_id: thread.threadId }),
		);
		await collect(byok.runMessage(BASE_REQUEST));

		expect((captured[1]?.body.messages as unknown[]).length).toBe(3);
		expect((captured[2]?.body.messages as unknown[]).length).toBe(1);
	});

	it("fails clearly when no key is enabled for the provider", async () => {
		const byok = new ByokClient(() => null);
		await expect(collect(byok.runMessage(BASE_REQUEST))).rejects.toThrow(
			/No enabled Anthropic API key/,
		);
	});

	it("fails clearly for a provider no adapter handles", async () => {
		await expect(
			collect(client().runMessage({ ...BASE_REQUEST, llm_provider: "cohere" })),
		).rejects.toThrow(/No API key provider handles "cohere"/);
	});

	it("reports an unknown thread instead of silently starting a new one", async () => {
		const events = await collect(
			client().runToolOutputs({
				thread_id: "byok_missing",
				tool_outputs: [{ tool_call_id: "x", output: "y" }],
			}),
		);
		expect(events).toEqual([
			{
				kind: "failed",
				error: expect.stringContaining("Unknown conversation") as never,
			},
		]);
	});

	it("declares local thread resume without assistants or memory", () => {
		expect(client().capabilities).toEqual({
			assistants: false,
			threads: true,
			memory: false,
		});
	});

	it("reports model-specific Google thinking support", async () => {
		const byok = new ByokClient(() => "test-key");

		await expect(
			byok.getModelThinkingMetadata("google", "gemini-3.5-flash"),
		).resolves.toMatchObject({ supports_thinking: true });
		await expect(
			byok.getModelThinkingMetadata("google", "gemma-4-31b-it"),
		).resolves.toMatchObject({ supports_thinking: false });
	});
});

describe("ByokClient thread handling", () => {
	// Adopting an unknown id would answer from an empty history while the UI
	// still shows the full transcript - context lost with no visible sign.
	it("refuses a thread it does not hold rather than answering from nothing", async () => {
		stubStream([anthropicFinalTurn()]);

		await expect(
			collect(
				client().runMessage({ ...BASE_REQUEST, thread_id: "thread_backboard" }),
			),
		).rejects.toThrow(/Unknown conversation/);
	});

	it("still mints a thread when the caller names none", async () => {
		stubStream([anthropicFinalTurn()]);
		const events = await collect(client().runMessage(BASE_REQUEST));

		expect(events[0]).toMatchObject({ kind: "thread" });
	});

	it("continues a thread it minted", async () => {
		const captured = stubStream([anthropicFinalTurn(), anthropicFinalTurn()]);
		const byok = client();
		const first = await collect(byok.runMessage(BASE_REQUEST));
		const thread = first.find((event) => event.kind === "thread");
		const threadId = thread?.kind === "thread" ? thread.threadId : "";

		await collect(byok.runMessage({ ...BASE_REQUEST, thread_id: threadId }));

		// Second request replays the first exchange, so history was kept.
		const messages = captured[1]?.body.messages as unknown[];
		expect(messages.length).toBeGreaterThan(1);
	});
});

describe("ByokClient thread eviction", () => {
	// The live conversation is minted first and every throwaway - subagent run,
	// RLM leg, compaction summary - lands after it, so evicting by insertion
	// order would drop the one thread that must survive, and the unknown-thread
	// guard would then fail the next turn outright.
	it("keeps the conversation in use alive when throwaways fill the map", async () => {
		stubStream(Array.from({ length: 200 }, () => anthropicFinalTurn()));
		const byok = client();

		const first = await collect(byok.runMessage(BASE_REQUEST));
		const thread = first.find((event) => event.kind === "thread");
		const live = thread?.kind === "thread" ? thread.threadId : "";

		for (let i = 0; i < 80; i++) {
			// A throwaway thread, then another turn on the live one.
			await collect(byok.runMessage(BASE_REQUEST));
			await collect(byok.runMessage({ ...BASE_REQUEST, thread_id: live }));
		}

		// Still answerable: it was never evicted.
		await collect(byok.runMessage({ ...BASE_REQUEST, thread_id: live }));
	});

	it("does evict threads nobody has touched", async () => {
		stubStream(Array.from({ length: 200 }, () => anthropicFinalTurn()));
		const byok = client();

		const first = await collect(byok.runMessage(BASE_REQUEST));
		const thread = first.find((event) => event.kind === "thread");
		const abandoned = thread?.kind === "thread" ? thread.threadId : "";

		for (let i = 0; i < 80; i++) {
			await collect(byok.runMessage(BASE_REQUEST));
		}

		await expect(
			collect(byok.runMessage({ ...BASE_REQUEST, thread_id: abandoned })),
		).rejects.toThrow(/Unknown conversation/);
	});
});

describe("Anthropic truncated tool calls", () => {
	function truncatedToolTurn(): string[] {
		return [
			JSON.stringify({
				type: "message_start",
				message: { usage: { input_tokens: 10 } },
			}),
			JSON.stringify({
				type: "content_block_start",
				index: 0,
				content_block: { type: "tool_use", id: "toolu_1", name: "read_file" },
			}),
			JSON.stringify({
				type: "content_block_delta",
				index: 0,
				// Cut off mid-JSON by the output limit.
				delta: { type: "input_json_delta", partial_json: '{"path": "/repo/a' },
			}),
			JSON.stringify({ type: "content_block_stop", index: 0 }),
			JSON.stringify({
				type: "message_delta",
				delta: { stop_reason: "max_tokens" },
				usage: { output_tokens: 5 },
			}),
			JSON.stringify({ type: "message_stop" }),
		];
	}

	// `tool_ready` is what starts read-only tools running ahead of the round, so
	// a call built from half-parsed arguments must never be offered.
	it("never offers a call whose arguments were cut off", async () => {
		stubStream([truncatedToolTurn()]);
		const events = await collect(client().runMessage(BASE_REQUEST));

		expect(events.some((event) => event.kind === "tool_ready")).toBe(false);
		expect(events.some((event) => event.kind === "requires_action")).toBe(
			false,
		);
	});

	it("reports the truncation instead of completing an empty turn", async () => {
		stubStream([truncatedToolTurn()]);
		const events = await collect(client().runMessage(BASE_REQUEST));

		expect(events.at(-1)).toMatchObject({
			kind: "failed",
			retryable: true,
		});
	});
});

describe("BYOK durable retry behavior", () => {
	function partialRetryableTurn(): string[] {
		return [
			JSON.stringify({
				type: "message_start",
				message: { usage: { input_tokens: 10 } },
			}),
			JSON.stringify({
				type: "content_block_start",
				index: 0,
				content_block: { type: "text" },
			}),
			JSON.stringify({
				type: "content_block_delta",
				index: 0,
				delta: { type: "text_delta", text: "discard me" },
			}),
			JSON.stringify({ type: "content_block_stop", index: 0 }),
			JSON.stringify({
				type: "content_block_start",
				index: 1,
				content_block: { type: "tool_use", id: "toolu_1", name: "read_file" },
			}),
			JSON.stringify({
				type: "content_block_delta",
				index: 1,
				delta: {
					type: "input_json_delta",
					partial_json: '{"path": "/repo/a',
				},
			}),
			JSON.stringify({ type: "content_block_stop", index: 1 }),
			JSON.stringify({
				type: "message_delta",
				delta: { stop_reason: "max_tokens" },
				usage: { output_tokens: 5 },
			}),
			JSON.stringify({ type: "message_stop" }),
		];
	}

	it("rolls back the user message and partial assistant on a retryable attempt", async () => {
		const captured = stubStream([partialRetryableTurn(), anthropicFinalTurn()]);
		const byok = client();
		const first = await collect(byok.runMessage(BASE_REQUEST));
		const thread = first.find((event) => event.kind === "thread");
		expect(first.at(-1)).toMatchObject({ kind: "failed", retryable: true });

		await collect(
			byok.runMessage({
				...BASE_REQUEST,
				thread_id: thread?.kind === "thread" ? thread.threadId : "",
			}),
		);

		const messages = captured[1]?.body.messages as
			| Array<{ role: string; content: unknown }>
			| undefined;
		expect(messages).toHaveLength(1);
		expect(messages?.[0]?.role).toBe("user");
		expect(JSON.stringify(messages)).not.toContain("discard me");
	});

	it("warns without failing a completed response when persistence fails", async () => {
		class FailingStore extends ByokConversationStore {
			override async save(): Promise<number> {
				throw new Error("disk full");
			}
		}
		stubStream([anthropicFinalTurn()]);
		const byok = new ByokClient(
			() => "sk-ant-test",
			undefined,
			new FailingStore("/tmp/byok-failing-store"),
		);
		const events = await collect(
			byok.runMessage(BASE_REQUEST, {
				durableSession: {
					sessionId: "sess_fail",
					sessionRoot: "/tmp/byok-failing-store/sess_fail",
				},
			}),
		);

		expect(events.some((event) => event.kind === "completed")).toBe(true);
		expect(events.find((event) => event.kind === "warning")).toMatchObject({
			kind: "warning",
			message: expect.stringContaining("disk full"),
		});
	});
});

describe("BYOK cancellation consistency", () => {
	const partialFrames = [
		JSON.stringify({
			type: "message_start",
			message: { usage: { input_tokens: 10 } },
		}),
		JSON.stringify({
			type: "content_block_start",
			index: 0,
			content_block: { type: "text" },
		}),
		JSON.stringify({
			type: "content_block_delta",
			index: 0,
			delta: { type: "text_delta", text: "partial answer" },
		}),
	];

	it("keeps a cancelled user message and partial answer in provider context", async () => {
		const abort = new AbortController();
		stubAbortableStream(partialFrames);
		const byok = client();
		const events: ProviderEvent[] = [];
		let resolvePartial: () => void = () => undefined;
		const sawPartial = new Promise<void>((resolve) => {
			resolvePartial = resolve;
		});
		const interrupted = (async () => {
			try {
				for await (const event of byok.runMessage(BASE_REQUEST, {
					signal: abort.signal,
				})) {
					events.push(event);
					if (event.kind === "assistant_delta") resolvePartial();
				}
			} catch {
				// Expected abort.
			}
		})();
		await sawPartial;
		abort.abort();
		await interrupted;
		const thread = events.find((event) => event.kind === "thread");

		const captured = stubStream([anthropicFinalTurn()]);
		await collect(
			byok.runMessage({
				...BASE_REQUEST,
				content: "continue",
				thread_id: thread?.kind === "thread" ? thread.threadId : "",
			}),
		);

		expect(JSON.stringify(captured[0]?.body.messages)).toContain(
			"partial answer",
		);
		expect(JSON.stringify(captured[0]?.body.messages)).toContain("read a.ts");
	});

	it("keeps tool results paired when the continuation is cancelled", async () => {
		stubStream([anthropicToolTurn()]);
		const byok = client();
		const initial = await collect(byok.runMessage(BASE_REQUEST));
		const thread = initial.find((event) => event.kind === "thread");
		const abort = new AbortController();
		const { started } = stubAbortableStream(partialFrames);
		const continuation = collect(
			byok.runToolOutputs(
				{
					thread_id: thread?.kind === "thread" ? thread.threadId : "",
					tool_outputs: [{ tool_call_id: "toolu_1", output: "file contents" }],
					tools: TOOLS,
				},
				{ signal: abort.signal },
			),
		).catch(() => []);
		await started;
		abort.abort();
		await continuation;

		const captured = stubStream([anthropicFinalTurn()]);
		await collect(
			byok.runMessage({
				...BASE_REQUEST,
				content: "continue",
				thread_id: thread?.kind === "thread" ? thread.threadId : "",
			}),
		);
		const messages = JSON.stringify(captured[0]?.body.messages);
		expect(messages).toContain("toolu_1");
		expect(messages).toContain("file contents");
	});

	it("emits cancellation persistence warnings on the originating stream", async () => {
		class FailingStore extends ByokConversationStore {
			override async save(): Promise<number> {
				throw new Error("cancel save failed");
			}
		}
		const abort = new AbortController();
		stubAbortableStream(partialFrames);
		const byok = new ByokClient(
			() => "sk-ant-test",
			undefined,
			new FailingStore("/tmp/byok-cancel-failing-store"),
		);
		const events: ProviderEvent[] = [];
		let resolvePartial: () => void = () => undefined;
		const sawPartial = new Promise<void>((resolve) => {
			resolvePartial = resolve;
		});
		const interrupted = (async () => {
			try {
				for await (const event of byok.runMessage(BASE_REQUEST, {
					signal: abort.signal,
					durableSession: {
						sessionId: "sess_cancel_fail",
						sessionRoot: "/tmp/byok-cancel-failing-store/sess_cancel_fail",
					},
				})) {
					events.push(event);
					if (event.kind === "assistant_delta") resolvePartial();
				}
			} catch {
				// Expected abort.
			}
		})();
		await sawPartial;
		abort.abort();
		await interrupted;

		expect(events.find((event) => event.kind === "warning")).toMatchObject({
			kind: "warning",
			message: expect.stringContaining("cancel save failed"),
		});
	});

	it("repairs an in-memory pending tool call before the next user turn", async () => {
		stubStream([anthropicToolTurn()]);
		const byok = client();
		const initial = await collect(byok.runMessage(BASE_REQUEST));
		const thread = initial.find((event) => event.kind === "thread");

		const captured = stubStream([anthropicFinalTurn()]);
		await collect(
			byok.runMessage({
				...BASE_REQUEST,
				content: "skip that tool",
				thread_id: thread?.kind === "thread" ? thread.threadId : "",
			}),
		);

		expect(JSON.stringify(captured[0]?.body.messages)).not.toContain("toolu_1");
	});

	it("preserves a failed retry input for the next provider request", async () => {
		stubStream([anthropicFinalTurn()]);
		const byok = client();
		const initial = await collect(byok.runMessage(BASE_REQUEST));
		const thread = initial.find((event) => event.kind === "thread");
		const threadId = thread?.kind === "thread" ? thread.threadId : "";

		await byok.preserveFailedMessage({
			...BASE_REQUEST,
			content: "visible failed request",
			thread_id: threadId,
		});

		const captured = stubStream([anthropicFinalTurn()]);
		await collect(
			byok.runMessage({
				...BASE_REQUEST,
				content: "continue",
				thread_id: threadId,
			}),
		);

		expect(JSON.stringify(captured[0]?.body.messages)).toContain(
			"visible failed request",
		);
	});

	it("preserves executed tool results when their continuation fails", async () => {
		stubStream([anthropicToolTurn()]);
		const byok = client();
		const initial = await collect(byok.runMessage(BASE_REQUEST));
		const thread = initial.find((event) => event.kind === "thread");
		const threadId = thread?.kind === "thread" ? thread.threadId : "";

		await byok.preserveFailedToolOutputs({
			thread_id: threadId,
			tool_outputs: [
				{ tool_call_id: "toolu_1", output: "executed file contents" },
			],
			tools: TOOLS,
		});

		const captured = stubStream([anthropicFinalTurn()]);
		await collect(
			byok.runMessage({
				...BASE_REQUEST,
				content: "continue",
				thread_id: threadId,
			}),
		);
		const messages = JSON.stringify(captured[0]?.body.messages);
		expect(messages).toContain("toolu_1");
		expect(messages).toContain("executed file contents");
	});
});
