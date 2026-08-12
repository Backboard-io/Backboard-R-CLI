import { afterEach, describe, expect, it } from "bun:test";
import type { OpenAITool } from "../src/core/tools/schema.ts";
import type {
	ProviderEvent,
	SendMessageRequest,
} from "../src/providers/backboard/types.ts";
import {
	isOpenRouterChatModel,
	openRouterAdapter,
	supportsOpenRouterThinking,
} from "../src/providers/byok/adapters/OpenRouterAdapter.ts";
import { ByokClient } from "../src/providers/byok/ByokClient.ts";

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

function stubJson(body: unknown): CapturedRequest[] {
	const captured: CapturedRequest[] = [];
	globalThis.fetch = (async (url: string, init?: RequestInit) => {
		captured.push({
			url: String(url),
			headers: (init?.headers ?? {}) as Record<string, string>,
			body: {},
		});
		return Response.json(body);
	}) as unknown as typeof fetch;
	return captured;
}

function stubStreams(scripts: string[][]): CapturedRequest[] {
	const captured: CapturedRequest[] = [];
	let call = 0;
	globalThis.fetch = (async (url: string, init?: RequestInit) => {
		if (typeof init?.body !== "string") {
			throw new Error("Expected a JSON request body.");
		}
		captured.push({
			url: String(url),
			headers: (init.headers ?? {}) as Record<string, string>,
			body: JSON.parse(init.body) as Record<string, unknown>,
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

async function collect(
	stream: AsyncIterable<ProviderEvent>,
): Promise<ProviderEvent[]> {
	const events: ProviderEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

function client(): ByokClient {
	return new ByokClient((provider) =>
		provider === "openrouter" ? "sk-or-v1-test-key-value-long-enough" : null,
	);
}

function request(): SendMessageRequest {
	return {
		content: "read a.ts",
		llm_provider: "openrouter",
		model_name: "anthropic/claude-sonnet-4.6",
		system_prompt: "You are a coding agent.",
		tools: TOOLS,
		thinking: { max_tokens: 4096 },
	};
}

function toolTurn(): string[] {
	return [
		JSON.stringify({
			choices: [
				{
					delta: {
						content: "Reading it.",
						reasoning_details: [
							{
								type: "reasoning.text",
								text: "opaque ",
								format: "anthropic-claude-v1",
								index: 0,
							},
						],
						tool_calls: [
							{
								index: 0,
								id: "call_1",
								function: {
									name: "read_file",
									arguments: '{"path":"a.ts"}',
								},
							},
						],
					},
					finish_reason: null,
				},
			],
		}),
		JSON.stringify({
			choices: [
				{
					delta: {
						reasoning_details: [
							{
								type: "reasoning.text",
								text: "reasoning",
								signature: "opaque-signature",
								format: "anthropic-claude-v1",
								index: 0,
							},
						],
					},
					finish_reason: null,
				},
			],
		}),
		JSON.stringify({
			choices: [{ delta: {}, finish_reason: "tool_calls" }],
			usage: {
				prompt_tokens: 100,
				completion_tokens: 20,
				total_tokens: 120,
				prompt_tokens_details: { cached_tokens: 40 },
				cost: 0.0012,
			},
		}),
		"[DONE]",
	];
}

function finalTurn(): string[] {
	return [
		JSON.stringify({
			choices: [{ delta: { content: "Done." }, finish_reason: "stop" }],
			usage: { prompt_tokens: 130, completion_tokens: 5, total_tokens: 135 },
		}),
		"[DONE]",
	];
}

describe("OpenRouter catalog", () => {
	it("validates keys through the current-key endpoint", async () => {
		const captured = stubJson({ data: { label: "test" } });

		await openRouterAdapter.validateKey("sk-or-v1-test-key-value-long-enough");

		expect(captured[0]?.url).toBe("https://openrouter.ai/api/v1/key");
		expect(captured[0]?.headers.Authorization).toBe(
			"Bearer sk-or-v1-test-key-value-long-enough",
		);
		expect(captured[0]?.headers["HTTP-Referer"]).toBe("https://backboard.io");
		expect(captured[0]?.headers["X-OpenRouter-Title"]).toBe("Backboard R-CLI");
	});

	it("uses the authenticated catalog and keeps text tool models", async () => {
		const captured = stubJson({
			data: [
				{
					id: "anthropic/claude-sonnet-4.6",
					created: 1_700_000_000,
					context_length: 200_000,
					top_provider: { max_completion_tokens: 64_000 },
					supported_parameters: ["tools", "reasoning"],
					architecture: {
						input_modalities: ["text", "image"],
						output_modalities: ["text"],
					},
				},
				{
					id: "openai/text-only",
					supported_parameters: ["temperature"],
					architecture: {
						input_modalities: ["text"],
						output_modalities: ["text"],
					},
				},
				{
					id: "openai/image-output",
					supported_parameters: ["tools"],
					architecture: {
						input_modalities: ["text"],
						output_modalities: ["image"],
					},
				},
			],
		});

		const models = await openRouterAdapter.listModels(
			"sk-or-v1-test-key-value-long-enough",
		);

		expect(captured[0]?.url).toBe("https://openrouter.ai/api/v1/models/user");
		expect(models).toEqual([
			{
				name: "anthropic/claude-sonnet-4.6",
				provider: "openrouter",
				model_type: "llm",
				last_updated: 1_700_000_000_000,
				context_limit: 200_000,
				max_output_tokens: 64_000,
				supports_thinking: true,
			},
		]);
		await expect(
			openRouterAdapter.supportsThinking(
				"anthropic/claude-sonnet-4.6",
				"sk-or-v1-test-key-value-long-enough",
			),
		).resolves.toBe(true);
		expect(captured).toHaveLength(1);
	});

	it("resolves thinking support without listing models first", async () => {
		const captured = stubJson({
			data: [
				{
					id: "openai/gpt-oss-20b:free",
					supported_parameters: ["tools", "reasoning"],
				},
			],
		});
		const byok = new ByokClient((provider) =>
			provider === "openrouter"
				? "sk-or-v1-headless-test-key-value-long-enough"
				: null,
		);

		await expect(
			byok.getModelThinkingMetadata("openrouter", "openai/gpt-oss-20b:free"),
		).resolves.toMatchObject({ supports_thinking: true });

		expect(captured).toHaveLength(1);
		expect(captured[0]?.url).toBe("https://openrouter.ai/api/v1/models/user");
	});

	it("does not reuse catalog capabilities after the key changes", async () => {
		const captured = stubJson({ data: [] });

		await expect(
			openRouterAdapter.supportsThinking(
				"openai/gpt-oss-20b:free",
				"sk-or-v1-different-test-key-value-long-enough",
			),
		).resolves.toBe(false);

		expect(captured).toHaveLength(1);
	});

	it("shares an authenticated catalog request across concurrent lookups", async () => {
		const captured = stubJson({
			data: [
				{
					id: "openai/gpt-oss-20b:free",
					supported_parameters: ["tools", "reasoning"],
				},
			],
		});
		const key = "sk-or-v1-concurrent-test-key-value-long-enough";

		const [models, supportsThinking] = await Promise.all([
			openRouterAdapter.listModels(key),
			openRouterAdapter.supportsThinking("openai/gpt-oss-20b:free", key),
		]);

		expect(models).toHaveLength(1);
		expect(supportsThinking).toBe(true);
		expect(captured).toHaveLength(1);
	});

	it("requires tools and text output for coding-agent models", () => {
		expect(
			isOpenRouterChatModel({
				id: "anthropic/claude-sonnet-4.6",
				supported_parameters: ["tools"],
				architecture: {
					input_modalities: ["text"],
					output_modalities: ["text"],
				},
			}),
		).toBe(true);
		expect(
			isOpenRouterChatModel({
				id: "openai/gpt-image",
				supported_parameters: ["tools"],
				architecture: {
					input_modalities: ["text"],
					output_modalities: ["image"],
				},
			}),
		).toBe(false);
		expect(
			isOpenRouterChatModel({
				id: "meta/llama",
				supported_parameters: ["temperature"],
			}),
		).toBe(false);
	});

	it("reports reasoning only when the catalog declares its controls", () => {
		expect(supportsOpenRouterThinking(["tools", "reasoning"])).toBe(true);
		expect(supportsOpenRouterThinking(["tools", "include_reasoning"])).toBe(
			true,
		);
		expect(supportsOpenRouterThinking(["tools"])).toBe(false);
	});
});

describe("OpenRouter streaming", () => {
	it("sends tools, attribution, routing requirements, and reasoning", async () => {
		const captured = stubStreams([toolTurn()]);

		const events = await collect(client().runMessage(request()));

		expect(captured[0]?.url).toBe(
			"https://openrouter.ai/api/v1/chat/completions",
		);
		expect(captured[0]?.headers.Authorization).toStartWith("Bearer sk-or-v1-");
		expect(captured[0]?.headers["HTTP-Referer"]).toBe("https://backboard.io");
		expect(captured[0]?.headers["X-OpenRouter-Title"]).toBe("Backboard R-CLI");
		expect(captured[0]?.body).toMatchObject({
			model: "anthropic/claude-sonnet-4.6",
			stream: true,
			stream_options: { include_usage: true },
			tool_choice: "auto",
			provider: { require_parameters: true },
			reasoning: { max_tokens: 4096 },
		});
		expect(events).toContainEqual({
			kind: "assistant_delta",
			text: "Reading it.",
		});
		expect(events).toContainEqual({
			kind: "tool_ready",
			call: {
				id: "call_1",
				name: "read_file",
				input: { path: "a.ts" },
			},
		});
		const action = events.find((event) => event.kind === "requires_action");
		expect(
			action?.kind === "requires_action"
				? JSON.parse(action.providerMetadata ?? "")
				: null,
		).toEqual([
			{
				type: "reasoning.text",
				text: "opaque reasoning",
				format: "anthropic-claude-v1",
				index: 0,
				signature: "opaque-signature",
			},
		]);
		expect(events.find((event) => event.kind === "usage")).toMatchObject({
			usage: {
				inputTokens: 100,
				outputTokens: 20,
				totalTokens: 120,
				cachedTokens: 40,
				costUsd: 0.0012,
				provider: "openrouter",
			},
		});
	});

	it("replays reasoning details across a tool continuation", async () => {
		const captured = stubStreams([toolTurn(), finalTurn()]);
		const byok = client();

		const first = await collect(byok.runMessage(request()));
		const thread = first.find((event) => event.kind === "thread");
		if (thread?.kind !== "thread") throw new Error("no thread event");

		await collect(
			byok.runToolOutputs({
				thread_id: thread.threadId,
				tool_outputs: [{ tool_call_id: "call_1", output: "file body" }],
				tools: TOOLS,
				thinking: { max_tokens: 4096 },
			}),
		);

		const messages = captured[1]?.body.messages as Array<
			Record<string, unknown>
		>;
		expect(messages[2]).toMatchObject({
			role: "assistant",
			reasoning_details: [
				{
					type: "reasoning.text",
					text: "opaque reasoning",
					signature: "opaque-signature",
					format: "anthropic-claude-v1",
					index: 0,
				},
			],
			tool_calls: [
				{
					id: "call_1",
					type: "function",
					function: {
						name: "read_file",
						arguments: '{"path":"a.ts"}',
					},
				},
			],
		});
		expect(messages[3]).toEqual({
			role: "tool",
			tool_call_id: "call_1",
			name: "read_file",
			content: "file body",
		});
	});

	it("surfaces an in-stream OpenRouter error", async () => {
		stubStreams([
			[
				JSON.stringify({
					error: { code: 429, message: "Provider rate limited" },
				}),
				"[DONE]",
			],
		]);

		const events = await collect(client().runMessage(request()));

		expect(events.at(-1)).toEqual({
			kind: "failed",
			error: "Provider rate limited",
		});
	});

	it("fails when the stream closes before a finish reason", async () => {
		stubStreams([
			[
				JSON.stringify({
					choices: [{ delta: { content: "partial" }, finish_reason: null }],
				}),
			],
		]);

		const events = await collect(client().runMessage(request()));

		expect(events.at(-1)).toMatchObject({
			kind: "failed",
			error: expect.stringContaining("OpenRouter stream closed unexpectedly"),
			retryable: true,
		});
	});
});
