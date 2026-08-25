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
import type { ByokStreamRequest } from "../src/providers/byok/ByokTypes.ts";

const originalFetch = globalThis.fetch;
const originalDateNow = Date.now;

afterEach(() => {
	globalThis.fetch = originalFetch;
	Date.now = originalDateNow;
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
		if (String(url).endsWith("/models/user") && init?.method !== "POST") {
			return Response.json({
				data: [
					{
						id: "anthropic/claude-sonnet-4.6",
						context_length: 200_000,
						supported_parameters: ["tools", "reasoning"],
					},
				],
			});
		}
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

function client(key = "sk-or-v1-test-key-value-long-enough"): ByokClient {
	return new ByokClient((provider) => (provider === "openrouter" ? key : null));
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

	it("does not cancel a shared catalog load when one caller aborts", async () => {
		const captured: CapturedRequest[] = [];
		let resolveResponse: ((response: Response) => void) | undefined;
		globalThis.fetch = (async (url: string, init?: RequestInit) => {
			captured.push({
				url: String(url),
				headers: (init?.headers ?? {}) as Record<string, string>,
				body: {},
			});
			return await new Promise<Response>((resolve) => {
				resolveResponse = resolve;
			});
		}) as unknown as typeof fetch;
		const key = "sk-or-v1-abort-test-key-value-long-enough";
		const controller = new AbortController();

		const modelsPromise = openRouterAdapter.listModels(key, controller.signal);
		const thinkingPromise = openRouterAdapter.supportsThinking(
			"openai/gpt-oss-20b:free",
			key,
		);
		controller.abort();
		resolveResponse?.(
			Response.json({
				data: [
					{
						id: "openai/gpt-oss-20b:free",
						supported_parameters: ["tools", "reasoning"],
					},
				],
			}),
		);

		await expect(modelsPromise).rejects.toBeDefined();
		await expect(thinkingPromise).resolves.toBe(true);
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
	it("loads cold image capability before messaging a text-only model", async () => {
		const captured: CapturedRequest[] = [];
		const image = "aW1hZ2U=";
		globalThis.fetch = (async (url: string, init?: RequestInit) => {
			if (String(url).endsWith("/models/user")) {
				return Response.json({
					data: [
						{
							id: "openai/text-only-cold",
							supported_parameters: ["tools"],
							architecture: {
								input_modalities: ["text"],
								output_modalities: ["text"],
							},
						},
					],
				});
			}
			const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
			captured.push({
				url: String(url),
				headers: (init?.headers ?? {}) as Record<string, string>,
				body,
			});
			return new Response(
				`data: ${JSON.stringify({
					choices: [{ delta: { content: "Done." }, finish_reason: "stop" }],
				})}\n\ndata: [DONE]\n\n`,
				{ headers: { "Content-Type": "text/event-stream" } },
			);
		}) as unknown as typeof fetch;
		const streamRequest: ByokStreamRequest = {
			model: "openai/text-only-cold",
			systemPrompt: "sys",
			tools: [],
			messages: [
				{
					role: "user",
					content: "inspect",
					attachments: [
						{
							path: "image.png",
							mediaType: "image/png",
							base64: image,
						},
					],
				},
			],
		};
		await collect(
			openRouterAdapter.stream(
				streamRequest,
				"sk-or-v1-cold-image-capability-key",
			),
		);
		expect(JSON.stringify(captured[0]?.body)).not.toContain(image);
		expect(JSON.stringify(captured[0]?.body)).toContain(
			"does not accept images",
		);
	});

	it("does not silently omit images when the capability catalog fails", async () => {
		let chatRequests = 0;
		globalThis.fetch = (async (url: string) => {
			if (String(url).endsWith("/models/user")) {
				return new Response("catalog unavailable", { status: 503 });
			}
			chatRequests++;
			throw new Error("chat request should not be sent");
		}) as unknown as typeof fetch;
		const streamRequest: ByokStreamRequest = {
			model: "openai/vision-model",
			systemPrompt: "sys",
			tools: [],
			messages: [
				{
					role: "user",
					content: "inspect",
					attachments: [
						{
							path: "image.png",
							mediaType: "image/png",
							base64: "aW1hZ2U=",
						},
					],
				},
			],
		};
		await expect(
			collect(
				openRouterAdapter.stream(
					streamRequest,
					"sk-or-v1-catalog-failure-image-key",
				),
			),
		).rejects.toThrow("503");
		expect(chatRequests).toBe(0);
	});

	it("uses stale image capability when a catalog refresh fails", async () => {
		let now = 1_000_000;
		Date.now = () => now;
		let catalogRequests = 0;
		const captured: CapturedRequest[] = [];
		globalThis.fetch = (async (url: string, init?: RequestInit) => {
			if (String(url).endsWith("/models/user")) {
				catalogRequests++;
				if (catalogRequests > 1) {
					return new Response("catalog unavailable", { status: 503 });
				}
				return Response.json({
					data: [
						{
							id: "openai/stale-vision",
							supported_parameters: ["tools"],
							architecture: {
								input_modalities: ["text", "image"],
								output_modalities: ["text"],
							},
						},
					],
				});
			}
			const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
			captured.push({
				url: String(url),
				headers: (init?.headers ?? {}) as Record<string, string>,
				body,
			});
			return new Response(
				`data: ${JSON.stringify({
					choices: [{ delta: { content: "Done." }, finish_reason: "stop" }],
				})}\n\ndata: [DONE]\n\n`,
				{ headers: { "Content-Type": "text/event-stream" } },
			);
		}) as unknown as typeof fetch;
		const key = "sk-or-v1-stale-image-capability-key";
		await openRouterAdapter.listModels(key);
		now += 5 * 60 * 1000 + 1;
		await collect(
			openRouterAdapter.stream(
				{
					model: "openai/stale-vision",
					systemPrompt: "sys",
					tools: [],
					messages: [
						{
							role: "user",
							content: "inspect",
							attachments: [
								{
									path: "image.png",
									mediaType: "image/png",
									base64: "aW1hZ2U=",
								},
							],
						},
					],
				},
				key,
			),
		);
		expect(catalogRequests).toBe(2);
		expect(JSON.stringify(captured[0]?.body)).toContain("aW1hZ2U=");
	});

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
				contextLimit: 200_000,
			},
		});
	});

	it("omits reasoning for an empty provider-default config", async () => {
		const captured = stubStreams([finalTurn()]);
		const input = request();
		input.thinking = {};

		await collect(client().runMessage(input));

		expect(captured[0]?.body.reasoning).toBeUndefined();
	});

	it("does not delay a completed turn for a slow catalog lookup", async () => {
		let catalogRequested = false;
		globalThis.fetch = (async (url: string, init?: RequestInit) => {
			if (String(url).endsWith("/models/user")) {
				catalogRequested = true;
				return await new Promise<Response>(() => {});
			}
			if (typeof init?.body !== "string") {
				throw new Error("Expected a JSON request body.");
			}
			return new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(
							new TextEncoder().encode(
								`data: ${JSON.stringify({
									choices: [
										{
											delta: { content: "Done." },
											finish_reason: "stop",
										},
									],
								})}\n\n`,
							),
						);
						controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
						controller.close();
					},
				}),
			);
		}) as unknown as typeof fetch;

		const events = await collect(
			client("sk-or-v1-slow-catalog-test-key-value-long-enough").runMessage(
				request(),
			),
		);

		expect(catalogRequested).toBe(true);
		expect(events.at(-1)).toMatchObject({ kind: "completed" });
	});

	it("merges unindexed reasoning fragments by stable stream position", async () => {
		const captured = stubStreams([
			[
				JSON.stringify({
					choices: [
						{
							delta: {
								reasoning_details: [
									{
										type: "reasoning.text",
										text: "opaque ",
										format: "anthropic-claude-v1",
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
									},
								],
							},
							finish_reason: null,
						},
					],
				}),
				JSON.stringify({
					choices: [{ delta: {}, finish_reason: "tool_calls" }],
				}),
				"[DONE]",
			],
		]);

		const events = await collect(client().runMessage(request()));
		const action = events.find((event) => event.kind === "requires_action");

		expect(captured).toHaveLength(1);
		expect(
			action?.kind === "requires_action"
				? JSON.parse(action.providerMetadata ?? "")
				: null,
		).toEqual([
			{
				type: "reasoning.text",
				text: "opaque reasoning",
				format: "anthropic-claude-v1",
				signature: "opaque-signature",
			},
		]);
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

	it("marks streamed OpenRouter gateway errors retryable", async () => {
		stubStreams([
			[
				JSON.stringify({
					error: { code: 503, message: "Provider unavailable" },
				}),
				"[DONE]",
			],
		]);

		const events = await collect(client().runMessage(request()));

		expect(events.at(-1)).toEqual({
			kind: "failed",
			error: "Provider unavailable",
			retryable: true,
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
