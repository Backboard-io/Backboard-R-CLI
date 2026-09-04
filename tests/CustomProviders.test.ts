import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveAuth } from "../src/config/auth.ts";
import {
	clearBackboardCredential,
	readBackboardConfig,
	saveBackboardConfig,
} from "../src/config/backboardConfig.ts";
import { Config } from "../src/config/Config.ts";
import {
	joinProviderUrl,
	resolveEnvReferences,
} from "../src/config/providers.ts";
import { ProviderKeyController } from "../src/core/keys/ProviderKeyController.ts";
import { providerKeysPath } from "../src/core/keys/ProviderKeyStore.ts";
import type { ProviderEvent } from "../src/providers/backboard/types.ts";
import { createAnthropicAdapter } from "../src/providers/byok/adapters/AnthropicAdapter.ts";
import {
	createOpenAIChatAdapter,
	toOpenAIMessages,
} from "../src/providers/byok/adapters/OpenAIAdapter.ts";
import { createOpenAIResponsesAdapter } from "../src/providers/byok/adapters/OpenAIResponsesAdapter.ts";
import { ByokClient } from "../src/providers/byok/ByokClient.ts";
import { ProviderRegistry } from "../src/providers/byok/registry.ts";

const originalFetch = globalThis.fetch;
const TRACE_REFERENCE = "$" + "{TRACE_ID}";

afterEach(() => {
	globalThis.fetch = originalFetch;
});

async function home(): Promise<string> {
	return mkdtemp(path.join(os.tmpdir(), "custom-provider-"));
}

async function collect(
	stream: AsyncIterable<ProviderEvent>,
): Promise<ProviderEvent[]> {
	const events: ProviderEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

describe("custom provider configuration", () => {
	it("round-trips valid definitions without deleting malformed entries", async () => {
		const dir = await home();
		await Bun.write(
			path.join(dir, ".backboard", "config.json"),
			JSON.stringify({
				providers: [
					{
						id: "local-provider",
						name: "Local Provider",
						protocol: "openai-responses",
						baseUrl: "http://localhost:8000/v1/",
						auth: { type: "none" },
						headers: { "X-Trace": TRACE_REFERENCE },
						models: [
							{
								id: "gpt-5.6-sol",
								contextLimit: 400000,
								maxOutputTokens: 32768,
							},
						],
					},
					{
						id: "insecure",
						name: "Insecure",
						protocol: "openai-chat",
						baseUrl: "http://models.example/v1",
						auth: { type: "apiKey" },
					},
					{
						id: "insecure-header",
						name: "Insecure Header",
						protocol: "openai-chat",
						baseUrl: "http://models.example/v1",
						auth: { type: "none" },
						headers: { Authorization: `Bearer ${TRACE_REFERENCE}` },
					},
					{
						id: "insecure-catalog",
						name: "Insecure Catalog",
						protocol: "openai-chat",
						baseUrl: "https://models.example/v1",
						auth: { type: "apiKey" },
						modelsPath: "http://catalog.example/models",
					},
					{
						id: "openai",
						name: "Reserved",
						protocol: "openai-chat",
						baseUrl: "http://localhost:8002",
						auth: { type: "none" },
					},
					{ id: "BAD ID", name: "Bad", protocol: "wat", baseUrl: "file:///x" },
				],
			}),
		);

		expect(readBackboardConfig(dir).providers).toEqual([
			{
				id: "local-provider",
				name: "Local Provider",
				protocol: "openai-responses",
				baseUrl: "http://localhost:8000/v1",
				auth: { type: "none" },
				headers: { "X-Trace": TRACE_REFERENCE },
				models: [
					{
						id: "gpt-5.6-sol",
						contextLimit: 400000,
						maxOutputTokens: 32768,
					},
				],
			},
		]);
		await saveBackboardConfig(
			{ ...readBackboardConfig(dir), notify: true },
			dir,
		);
		const raw = (await Bun.file(
			path.join(dir, ".backboard", "config.json"),
		).json()) as { providers: Array<{ id: string }> };
		expect(raw.providers.map((provider) => provider.id)).toEqual([
			"local-provider",
			"insecure",
			"insecure-header",
			"insecure-catalog",
			"openai",
			"BAD ID",
		]);
		const openAIStatus = new ProviderKeyController({ homeDir: dir })
			.list()
			.find((status) => status.provider === "openai");
		expect(openAIStatus?.custom).toBeUndefined();
		expect(openAIStatus?.configured).toBe(false);
	});

	it("preserves the selected model when editing a disabled provider", async () => {
		const dir = await home();
		const provider = {
			id: "disabled-provider",
			name: "Disabled Provider",
			protocol: "openai-chat" as const,
			baseUrl: "http://localhost:8317/v1",
			enabled: false,
			auth: { type: "none" as const },
			discoverModels: false,
			models: [{ id: "fallback-model" }, { id: "selected-model" }],
		};
		await saveBackboardConfig(
			{
				providers: [provider],
				model: {
					provider: provider.id,
					model: "selected-model",
				},
			},
			dir,
		);

		await new ProviderKeyController({ homeDir: dir }).saveCustomProvider(
			provider,
			undefined,
			provider.id,
		);

		expect(readBackboardConfig(dir).model).toEqual({
			provider: provider.id,
			model: "selected-model",
		});
	});

	it("joins standard and absolute provider endpoints safely", () => {
		expect(joinProviderUrl("http://localhost:8000/v1/", "models")).toBe(
			"http://localhost:8000/v1/models",
		);
		expect(
			joinProviderUrl(
				"http://localhost:8000/v1",
				"http://localhost:9000/catalog",
			),
		).toBe("http://localhost:9000/catalog");
	});

	it("expands environment references and fails clearly when missing", () => {
		expect(
			resolveEnvReferences("Bearer $" + "{TOKEN}", "header", { TOKEN: "abc" }),
		).toBe("Bearer abc");
		expect(() => resolveEnvReferences("$" + "{MISSING}", "header", {})).toThrow(
			/MISSING/,
		);
	});

	it("treats a configured keyless provider as usable authentication", async () => {
		const dir = await home();
		await saveBackboardConfig(
			{
				providers: [
					{
						id: "local-provider",
						name: "Local Provider",
						protocol: "openai-chat",
						baseUrl: "http://localhost:8000/v1",
						auth: { type: "none" },
						discoverModels: false,
						models: [{ id: "gpt-5.6-sol" }],
					},
				],
			},
			dir,
		);
		const auth = resolveAuth({ homeDir: dir });
		expect(auth.providerKeys).toContainEqual({
			provider: "local-provider",
			key: "",
		});
		expect(auth.providerRegistry?.get("local-provider")?.requiresKey).toBe(
			false,
		);
	});

	it("preserves custom providers when Backboard credentials are cleared", async () => {
		const dir = await home();
		await saveBackboardConfig(
			{
				apiKey: "backboard-key",
				providers: [
					{
						id: "local",
						name: "Local",
						protocol: "openai-chat",
						baseUrl: "http://localhost:1234/v1",
						auth: { type: "none" },
						discoverModels: false,
						models: [{ id: "local-model" }],
					},
				],
			},
			dir,
		);

		expect((await clearBackboardCredential(dir)).removed).toBe(true);
		expect(readBackboardConfig(dir)).toMatchObject({
			apiKey: undefined,
			providers: [{ id: "local" }],
		});
	});

	it("saves custom definitions while keeping static secrets encrypted", async () => {
		const dir = await home();
		globalThis.fetch = (async () =>
			new Response(JSON.stringify({ data: [{ id: "model-a" }] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			})) as unknown as typeof fetch;
		const controller = new ProviderKeyController({ homeDir: dir });
		await controller.addCustomProvider(
			{
				id: "acme",
				name: "Acme",
				protocol: "openai-chat",
				baseUrl: "https://models.example/v1",
				auth: { type: "apiKey" },
			},
			"super-secret-token",
		);

		expect(readBackboardConfig(dir).providers?.[0]?.id).toBe("acme");
		expect(readBackboardConfig(dir).model).toEqual({
			provider: "acme",
			model: "model-a",
		});
		const raw = await Bun.file(providerKeysPath(dir)).text();
		expect(raw).not.toContain("super-secret-token");
		expect(
			controller.list().find((entry) => entry.provider === "acme"),
		).toMatchObject({
			custom: true,
			configured: true,
			enabled: true,
		});
	});

	it("rejects built-in provider ids before sending credentials anywhere", async () => {
		const dir = await home();
		let requests = 0;
		globalThis.fetch = (async () => {
			requests++;
			return new Response("{}", { status: 200 });
		}) as unknown as typeof fetch;

		const controller = new ProviderKeyController({ homeDir: dir });
		for (const id of ["openai", "gemini", "google-gemini"]) {
			await expect(
				controller.addCustomProvider(
					{
						id,
						name: "Not Built-in",
						protocol: "openai-chat",
						baseUrl: "https://proxy.example/v1",
						auth: { type: "apiKey" },
					},
					"custom-secret",
				),
			).rejects.toThrow(/reserved/);
		}
		expect(requests).toBe(0);
	});

	it("requires environment references for credential-bearing headers", () => {
		const registry = new ProviderRegistry([
			{
				id: "unsafe",
				name: "Unsafe",
				protocol: "openai-chat",
				baseUrl: "https://example.test/v1",
				auth: { type: "none" },
				headers: { "X-Auth": "plaintext-secret" },
			},
		]);
		expect(registry.get("unsafe")).toBeNull();
		expect(registry.error("unsafe")?.message).toMatch(/environment variable/);
	});

	it("clears a persisted model when its custom provider is removed", async () => {
		const dir = await home();
		await saveBackboardConfig(
			{
				model: { provider: "local", model: "local-model" },
				providers: [
					{
						id: "local",
						name: "Local",
						protocol: "openai-chat",
						baseUrl: "http://localhost:1234/v1",
						auth: { type: "none" },
						discoverModels: false,
						models: [{ id: "local-model" }],
					},
				],
			},
			dir,
		);

		await new ProviderKeyController({ homeDir: dir }).remove("local");
		expect(readBackboardConfig(dir).model).toBeUndefined();
	});

	it("replaces a persisted model that has no usable authentication", async () => {
		const dir = await home();
		await saveBackboardConfig(
			{
				apiKey: "backboard-key",
				model: { provider: "stale-custom", model: "stale-model" },
				providers: [
					{
						id: "stale-custom",
						name: "Stale Custom",
						protocol: "openai-chat",
						baseUrl: "https://stale.example/v1",
						auth: {
							type: "env",
							variable: "BACKBOARD_TEST_MISSING_CUSTOM_KEY",
						},
						discoverModels: false,
						models: [{ id: "stale-model" }],
					},
				],
			},
			dir,
		);
		expect(
			new Config({ argv: [], homeDir: dir }).hasBackendForCurrentModel,
		).toBe(false);

		await new ProviderKeyController({ homeDir: dir }).addCustomProvider({
			id: "local",
			name: "Local",
			protocol: "openai-chat",
			baseUrl: "http://localhost:1234/v1",
			auth: { type: "none" },
			discoverModels: false,
			models: [{ id: "local-model" }],
		});
		expect(readBackboardConfig(dir).model).toEqual({
			provider: "local",
			model: "local-model",
		});
	});
});

describe("custom provider adapters", () => {
	it("parameterizes Chat Completions URLs, auth, headers, args, and models", async () => {
		const requests: Array<{ url: string; body?: Record<string, unknown> }> = [];
		globalThis.fetch = (async (url: string, init?: RequestInit) => {
			requests.push({
				url: String(url),
				...(init?.body
					? { body: JSON.parse(String(init.body)) as Record<string, unknown> }
					: {}),
			});
			if (!init?.body) {
				return new Response(JSON.stringify({ data: [{ id: "gpt-live" }] }), {
					status: 200,
				});
			}
			return new Response(
				'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":1,"total_tokens":3}}\n\ndata: [DONE]\n\n',
				{ status: 200 },
			);
		}) as unknown as typeof fetch;
		const adapter = createOpenAIChatAdapter({
			id: "acme",
			label: "Acme",
			baseUrl: "https://models.example/v1",
			requiresKey: false,
			headers: { "X-Custom": "yes" },
			extraArgs: { temperature: 0.2 },
			models: [{ id: "manual", contextLimit: 200000 }],
		});

		const models = await adapter.listModels("");
		expect(models.map((model) => model.name)).toEqual(["gpt-live", "manual"]);
		expect(models[0]?.thinking_controls?.allowed_fields).toEqual(["effort"]);
		const events = await collect(
			adapter.stream(
				{
					model: "manual",
					systemPrompt: "system",
					tools: [],
					messages: [{ role: "user", content: "hello" }],
				},
				"",
			),
		);
		expect(requests[0]?.url).toBe("https://models.example/v1/models");
		expect(requests[1]?.url).toBe("https://models.example/v1/chat/completions");
		expect(requests[1]?.body).toMatchObject({
			model: "manual",
			temperature: 0.2,
			stream: true,
		});
		expect(events).toContainEqual({ kind: "assistant_delta", text: "ok" });
		expect(events.at(-1)).toMatchObject({ kind: "completed" });
	});

	it("keeps multiple non-stream Chat Completions tool calls separate", async () => {
		globalThis.fetch = (async () =>
			new Response(
				JSON.stringify({
					choices: [
						{
							message: {
								tool_calls: [
									{
										id: "call_1",
										extra_content: {
											google: { thought_signature: "signed-call" },
										},
										function: {
											name: "read",
											arguments: '{"path":"one.txt"}',
										},
									},
									{
										id: "call_2",
										function: {
											name: "read",
											arguments: '{"path":"two.txt"}',
										},
									},
								],
							},
							finish_reason: "tool_calls",
						},
					],
					usage: {},
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			)) as unknown as typeof fetch;
		const adapter = createOpenAIChatAdapter({
			id: "chat",
			label: "Chat",
			baseUrl: "https://models.example/v1",
			requiresKey: false,
			discoverModels: false,
			models: [{ id: "gpt-x" }],
		});

		const events = await collect(
			adapter.stream(
				{
					model: "gpt-x",
					systemPrompt: "system",
					tools: [],
					messages: [{ role: "user", content: "read both" }],
				},
				"",
			),
		);
		expect(
			events
				.filter((event) => event.kind === "tool_ready")
				.map((event) => event.call),
		).toEqual([
			{
				id: "call_1",
				name: "read",
				input: { path: "one.txt" },
				signature: "signed-call",
				signatureProvider: "chat",
			},
			{ id: "call_2", name: "read", input: { path: "two.txt" } },
		]);
	});

	it("replays OpenAI-compatible signed tool calls", () => {
		const request = {
			model: "gemini-compatible",
			systemPrompt: "system",
			tools: [],
			messages: [
				{
					role: "assistant" as const,
					content: "",
					toolCalls: [
						{
							id: "call_1",
							name: "read",
							input: { path: "proof.txt" },
							signature: "signed-call",
							signatureProvider: "gemini-compatible",
						},
					],
				},
			],
		};
		expect(
			toOpenAIMessages(request, undefined, "gemini-compatible"),
		).toContainEqual({
			role: "assistant",
			content: null,
			tool_calls: [
				{
					id: "call_1",
					type: "function",
					function: {
						name: "read",
						arguments: '{"path":"proof.txt"}',
					},
					extra_content: {
						google: { thought_signature: "signed-call" },
					},
				},
			],
		});
		expect(
			JSON.stringify(toOpenAIMessages(request, undefined, "other-provider")),
		).not.toContain("thought_signature");
	});

	it("maps Responses API text, tool calls, usage, and continuation metadata", async () => {
		globalThis.fetch = (async () =>
			new Response(
				[
					`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "checking" })}`,
					`data: ${JSON.stringify({ type: "response.output_item.added", item: { type: "function_call", call_id: "call_1", name: "read", arguments: "" } })}`,
					`data: ${JSON.stringify({ type: "response.function_call_arguments.delta", call_id: "call_1", delta: '{"path":"a.ts"}' })}`,
					`data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "reasoning", id: "rs_1" } })}`,
					`data: ${JSON.stringify({ type: "response.completed", response: { usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 } } })}`,
					"data: [DONE]",
				].join("\n\n"),
				{ status: 200 },
			)) as unknown as typeof fetch;
		const adapter = createOpenAIResponsesAdapter({
			id: "responses",
			label: "Responses",
			baseUrl: "https://models.example/v1",
			requiresKey: false,
			discoverModels: false,
			models: [{ id: "gpt-x" }],
		});
		const events = await collect(
			adapter.stream(
				{
					model: "gpt-x",
					systemPrompt: "system",
					tools: [],
					messages: [{ role: "user", content: "read" }],
				},
				"",
			),
		);
		expect(events).toContainEqual({
			kind: "assistant_delta",
			text: "checking",
		});
		expect(events).toContainEqual({
			kind: "tool_ready",
			call: { id: "call_1", name: "read", input: { path: "a.ts" } },
		});
		expect(events.at(-1)).toMatchObject({
			kind: "requires_action",
		});
		const finalEvent = events.at(-1);
		const metadata =
			finalEvent?.kind === "requires_action"
				? finalEvent.providerMetadata
				: undefined;
		expect(metadata ? JSON.parse(metadata) : null).toMatchObject({
			provider: "responses",
			items: [{ type: "reasoning", id: "rs_1" }],
		});
		const capturedBodies: Record<string, unknown>[] = [];
		globalThis.fetch = (async (
			_url: string | URL | Request,
			init?: RequestInit,
		) => {
			capturedBodies.push(
				JSON.parse(String(init?.body)) as Record<string, unknown>,
			);
			return new Response(
				[
					`data: ${JSON.stringify({ type: "response.completed", response: { usage: {} } })}`,
					"data: [DONE]",
				].join("\n\n"),
				{ status: 200 },
			);
		}) as unknown as typeof fetch;
		const continuation = {
			model: "gpt-x",
			systemPrompt: "system",
			tools: [],
			messages: [
				{
					role: "assistant" as const,
					content: "",
					toolCalls: [],
					providerMetadata: metadata,
				},
			],
		};
		await collect(adapter.stream(continuation, ""));
		const foreignAdapter = createOpenAIResponsesAdapter({
			id: "other-responses",
			label: "Other Responses",
			baseUrl: "https://other.example/v1",
			requiresKey: false,
			discoverModels: false,
			models: [{ id: "gpt-x" }],
		});
		await collect(foreignAdapter.stream(continuation, ""));
		expect(JSON.stringify(capturedBodies[0]?.input)).toContain("rs_1");
		expect(JSON.stringify(capturedBodies[1]?.input)).not.toContain("rs_1");
	});

	it("surfaces Responses refusals instead of completing with empty output", async () => {
		globalThis.fetch = (async () =>
			new Response(
				[
					`data: ${JSON.stringify({ type: "response.refusal.delta", delta: "I cannot do that." })}`,
					`data: ${JSON.stringify({ type: "response.completed", response: { usage: {} } })}`,
					"data: [DONE]",
				].join("\n\n"),
				{ status: 200 },
			)) as unknown as typeof fetch;
		const adapter = createOpenAIResponsesAdapter({
			id: "responses",
			label: "Responses",
			baseUrl: "https://models.example/v1",
			requiresKey: false,
			discoverModels: false,
			models: [{ id: "gpt-x" }],
		});

		const events = await collect(
			adapter.stream(
				{
					model: "gpt-x",
					systemPrompt: "system",
					tools: [],
					messages: [{ role: "user", content: "request" }],
				},
				"",
			),
		);
		expect(events).toContainEqual({
			kind: "assistant_delta",
			text: "I cannot do that.",
		});
		expect(events.at(-1)).toMatchObject({ kind: "completed" });
	});

	it("fails malformed Responses tool arguments without emitting runnable calls", async () => {
		globalThis.fetch = (async () =>
			new Response(
				[
					`data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "function_call", call_id: "call_bad", name: "write", arguments: '{"path":' } })}`,
					`data: ${JSON.stringify({ type: "response.completed", response: { usage: {} } })}`,
					"data: [DONE]",
				].join("\n\n"),
				{ status: 200 },
			)) as unknown as typeof fetch;
		const adapter = createOpenAIResponsesAdapter({
			id: "responses",
			label: "Responses",
			baseUrl: "https://models.example/v1",
			requiresKey: false,
			discoverModels: false,
			models: [{ id: "gpt-x" }],
		});

		const events = await collect(
			adapter.stream(
				{
					model: "gpt-x",
					systemPrompt: "system",
					tools: [],
					messages: [{ role: "user", content: "write" }],
				},
				"",
			),
		);
		expect(events.some((event) => event.kind === "tool_ready")).toBe(false);
		const failed = events.at(-1);
		expect(failed?.kind).toBe("failed");
		if (failed?.kind === "failed") {
			expect(failed.error).toContain("invalid JSON");
		}
	});

	it("keeps Responses-native Codex models in discovered catalogs", async () => {
		globalThis.fetch = (async () =>
			new Response(
				JSON.stringify({
					data: [
						{ id: "gpt-5.6-sol" },
						{ id: "gpt-5.3-codex-spark" },
						{ id: "text-embedding-3-large" },
					],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			)) as unknown as typeof fetch;
		const adapter = createOpenAIResponsesAdapter({
			id: "responses",
			label: "Responses",
			baseUrl: "https://models.example/v1",
			requiresKey: false,
		});

		expect((await adapter.listModels("")).map((model) => model.name)).toEqual([
			"gpt-5.6-sol",
			"gpt-5.3-codex-spark",
		]);
	});

	it("extracts tool screenshots into Responses image input blocks", async () => {
		let body: Record<string, unknown> | undefined;
		globalThis.fetch = (async (_url: string, init?: RequestInit) => {
			body = JSON.parse(String(init?.body)) as Record<string, unknown>;
			return new Response(
				[
					`data: ${JSON.stringify({ type: "response.completed", response: { usage: {} } })}`,
					"data: [DONE]",
				].join("\n\n"),
				{ status: 200 },
			);
		}) as unknown as typeof fetch;
		const adapter = createOpenAIResponsesAdapter({
			id: "responses",
			label: "Responses",
			baseUrl: "https://models.example/v1",
			requiresKey: false,
			discoverModels: false,
			models: [{ id: "gpt-x" }],
		});
		await collect(
			adapter.stream(
				{
					model: "gpt-x",
					systemPrompt: "system",
					tools: [],
					messages: [
						{
							role: "assistant",
							content: "",
							toolCalls: [{ id: "call_1", name: "computer", input: {} }],
						},
						{
							role: "tool",
							results: [
								{
									id: "call_1",
									name: "computer",
									output: JSON.stringify({
										screen: {
											__image_base64: "aGVsbG8=",
											__image_media_type: "image/png",
										},
									}),
								},
							],
						},
					],
				},
				"",
			),
		);

		const serialized = JSON.stringify(body?.input);
		expect(serialized).not.toContain("__image_base64");
		expect(serialized).toContain("data:image/png;base64,aGVsbG8=");
	});

	it("preserves Anthropic model endpoint query parameters", async () => {
		const urls: string[] = [];
		globalThis.fetch = (async (url: string) => {
			urls.push(String(url));
			return new Response(JSON.stringify({ data: [] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}) as unknown as typeof fetch;
		const adapter = createAnthropicAdapter({
			id: "anthropic-proxy",
			label: "Anthropic Proxy",
			baseUrl: "https://models.example/v1",
			modelsPath: "models?api-version=2024-06-01",
			requiresKey: false,
		});

		await adapter.validateKey("");
		await adapter.listModels("");
		expect(urls).toEqual([
			"https://models.example/v1/models?api-version=2024-06-01&limit=1",
			"https://models.example/v1/models?api-version=2024-06-01&limit=1000",
		]);
	});

	it("builds all configured protocol adapters in one registry", () => {
		const registry = new ProviderRegistry([
			{
				id: "chat",
				name: "Chat",
				protocol: "openai-chat",
				baseUrl: "https://example.test/v1",
				auth: { type: "none" },
			},
			{
				id: "responses",
				name: "Responses",
				protocol: "openai-responses",
				baseUrl: "https://example.test/v1",
				auth: { type: "none" },
			},
			{
				id: "messages",
				name: "Messages",
				protocol: "anthropic-messages",
				baseUrl: "https://example.test/v1",
				auth: { type: "none" },
			},
		]);
		expect(registry.get("chat")).not.toBeNull();
		expect(registry.get("responses")).not.toBeNull();
		expect(registry.get("messages")).not.toBeNull();
	});

	it("lists manual models from a keyless provider through ByokClient", async () => {
		const registry = new ProviderRegistry([
			{
				id: "local",
				name: "Local",
				protocol: "openai-chat",
				baseUrl: "http://localhost:1234/v1",
				auth: { type: "none" },
				discoverModels: false,
				models: [{ id: "local-model" }],
			},
		]);
		const client = new ByokClient(
			(provider) => (provider === "local" ? "" : null),
			undefined,
			undefined,
			() => registry,
		);

		expect(await client.listModels()).toMatchObject({
			total: 1,
			models: [{ provider: "local", name: "local-model" }],
		});
		expect(
			await client.getModelThinkingMetadata("local", "local-model"),
		).toMatchObject({
			provider: "local",
			model: "local-model",
			supports_thinking: true,
			thinking_controls: {
				allowed_fields: ["effort"],
				defaults_only: false,
			},
		});
	});

	it("treats environment authentication as credential-required", () => {
		const previous = process.env.CUSTOM_PROVIDER_TEST_KEY;
		const previousModelsUrl = process.env.CUSTOM_PROVIDER_TEST_MODELS_URL;
		process.env.CUSTOM_PROVIDER_TEST_KEY = "test-key";
		process.env.CUSTOM_PROVIDER_TEST_MODELS_URL =
			"  http://models.example/models";
		try {
			const registry = new ProviderRegistry([
				{
					id: "env-provider",
					name: "Environment Provider",
					protocol: "openai-chat",
					baseUrl: "https://example.test/v1",
					auth: { type: "env", variable: "CUSTOM_PROVIDER_TEST_KEY" },
					discoverModels: false,
					models: [{ id: "test-model" }],
				},
				{
					id: "insecure-env-endpoint",
					name: "Insecure Environment Endpoint",
					protocol: "openai-chat",
					baseUrl: "https://example.test/v1",
					auth: { type: "env", variable: "CUSTOM_PROVIDER_TEST_KEY" },
					modelsPath: "$" + "{CUSTOM_PROVIDER_TEST_MODELS_URL}",
				},
			]);
			expect(registry.get("env-provider")?.requiresKey).toBe(true);
			expect(registry.get("insecure-env-endpoint")).toBeNull();
			expect(registry.error("insecure-env-endpoint")?.message).toContain(
				"must use HTTPS",
			);
		} finally {
			if (previous === undefined) {
				delete process.env.CUSTOM_PROVIDER_TEST_KEY;
			} else {
				process.env.CUSTOM_PROVIDER_TEST_KEY = previous;
			}
			if (previousModelsUrl === undefined) {
				delete process.env.CUSTOM_PROVIDER_TEST_MODELS_URL;
			} else {
				process.env.CUSTOM_PROVIDER_TEST_MODELS_URL = previousModelsUrl;
			}
		}
	});
});
