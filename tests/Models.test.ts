import { afterEach, describe, expect, it } from "bun:test";
import { BackboardClient } from "../src/providers/backboard/BackboardClient.ts";
import { fetchModels } from "../src/providers/backboard/models.ts";
import type { ModelsListResponse } from "../src/providers/backboard/types.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("Backboard model catalog", () => {
	it("requests targeted thinking metadata without catalog fanout", async () => {
		const requestedUrls: string[] = [];
		globalThis.fetch = (async (input, _init) => {
			requestedUrls.push(String(input));
			return new Response(
				JSON.stringify({
					provider: "openrouter",
					model: "z-ai/glm-5.2",
					max_output_tokens: 65536,
					supports_thinking: true,
					thinking_controls: {
						supported: true,
						allowed_fields: ["max_tokens"],
						defaults_only: false,
					},
				}),
				{ status: 200 },
			);
		}) as typeof fetch;

		const client = new BackboardClient({
			apiKey: "test-key",
			apiUrl: "https://api.backboard.test",
		});

		const result = await client.getModelThinkingMetadata(
			"openrouter",
			"z-ai/glm-5.2",
		);

		expect(result).toEqual({
			provider: "openrouter",
			model: "z-ai/glm-5.2",
			max_output_tokens: 65536,
			supports_thinking: true,
			thinking_controls: {
				supported: true,
				allowed_fields: ["max_tokens"],
				defaults_only: false,
			},
		});
		expect(requestedUrls).toHaveLength(1);
		const url = new URL(requestedUrls[0] ?? "");
		expect(url.pathname).toBe("/models/thinking-metadata");
		expect(url.searchParams.get("provider")).toBe("openrouter");
		expect(url.searchParams.get("model")).toBe("z-ai/glm-5.2");
	});

	it("requests provider model pages in parallel", async () => {
		const requestedUrls: string[] = [];
		let requestedInit: RequestInit | undefined;
		globalThis.fetch = (async (input, init) => {
			requestedUrls.push(String(input));
			requestedInit = init;
			const url = new URL(String(input));
			if (url.pathname === "/models/providers") {
				return new Response(
					JSON.stringify({
						providers: ["openai", "anthropic", "featherless"],
						total: 3,
					}),
					{ status: 200 },
				);
			}

			const skip = Number(url.searchParams.get("skip") ?? "0");
			const provider = url.pathname.split("/").at(-1) ?? "";
			const page: ModelsListResponse = (() => {
				if (provider === "openai" && skip === 0) {
					return {
						models: Array.from({ length: 2 }, (_, index) => ({
							name: `gpt-${index}`,
							provider: "openai",
							model_type: "llm",
						})),
						total: 3,
					};
				}
				if (provider === "openai") {
					return {
						models: [
							{
								name: "gpt-final",
								provider: "openai",
								model_type: "llm",
							},
						],
						total: 3,
					};
				}
				return {
					models: [
						{
							name: "claude-sonnet",
							provider: "anthropic",
							model_type: "llm",
						},
					],
					total: 1,
				};
			})();
			return new Response(JSON.stringify(page), { status: 200 });
		}) as typeof fetch;

		const client = new BackboardClient({
			apiKey: "test-key",
			apiUrl: "https://api.backboard.test",
		});

		const result = await client.listModels();

		expect(result.models).toHaveLength(4);
		expect(result.total).toBe(4);
		expect(requestedUrls).toHaveLength(4);
		expect(
			requestedUrls.some(
				(url) => new URL(url).pathname === "/models/providers",
			),
		).toBe(true);
		const modelRequests = requestedUrls
			.map((url) => new URL(url))
			.filter((url) => url.pathname.startsWith("/models/provider/"));
		expect(modelRequests.map((url) => url.pathname).sort()).toEqual([
			"/models/provider/anthropic",
			"/models/provider/openai",
			"/models/provider/openai",
		]);
		expect(
			modelRequests.some(
				(url) => url.pathname === "/models/provider/featherless",
			),
		).toBe(false);
		expect(modelRequests.map((url) => url.searchParams.get("limit"))).toEqual([
			"500",
			"500",
			"500",
		]);
		expect(
			modelRequests
				.filter((url) => url.pathname === "/models/provider/openai")
				.map((url) => url.searchParams.get("skip"))
				.sort(),
		).toEqual(["0", "2"]);
		expect(requestedInit?.method).toBe("GET");
	});

	it("caches normalized results per client", async () => {
		let listCalls = 0;
		const client = {
			listModels: async () => {
				listCalls += 1;
				return {
					models: [
						{ name: "gpt-5.5", provider: "openai", model_type: "llm" },
						{ name: "gemini-2.5-pro", provider: "google", model_type: "llm" },
						{
							name: "claude-sonnet-4.5",
							provider: "anthropic",
							model_type: "llm",
						},
						{ name: "grok-4", provider: "xai", model_type: "llm" },
						{
							name: "command-a-03-2025",
							provider: "cohere",
							model_type: "llm",
						},
						{
							name: "llama-4-scout-17b",
							provider: "cerebras",
							model_type: "llm",
						},
						{
							name: "anthropic/claude-opus-4.1",
							provider: "openrouter",
							model_type: "llm",
						},
						{
							name: "us.anthropic.claude-opus-4-1",
							provider: "aws-bedrock",
							model_type: "llm",
						},
					],
					total: 8,
				};
			},
		};

		const first = await fetchModels(client);
		const second = await fetchModels(client);

		expect(first).toEqual(second);
		expect(first).toHaveLength(8);
		expect(listCalls).toBe(1);
	});

	it("normalizes catalog models and filters non-LLM rows", async () => {
		const client = {
			listModels: async () => ({
				models: [
					{ name: "gpt-5.5", provider: "openai", model_type: "llm" },
					{ name: "gpt-image-1", provider: "openai", model_type: "image" },
					{
						name: "claude-sonnet-4.5",
						provider: "anthropic",
						model_type: "llm",
					},
				],
				total: 3,
			}),
		};

		expect(await fetchModels(client)).toEqual([
			{
				id: "openai/gpt-5.5",
				provider: "openai",
				model: "gpt-5.5",
				label: "openai/gpt-5.5",
			},
			{
				id: "anthropic/claude-sonnet-4.5",
				provider: "anthropic",
				model: "claude-sonnet-4.5",
				label: "anthropic/claude-sonnet-4.5",
			},
		]);
	});

	it("preserves thinking metadata from model catalog entries", async () => {
		const client = {
			listModels: async () => ({
				models: [
					{
						name: "gpt-5.5",
						provider: "openai",
						model_type: "llm",
						max_output_tokens: 32768,
						supports_thinking: true,
						thinking_controls: {
							supported: true,
							allowed_fields: ["effort"],
							defaults_only: false,
						},
					},
				],
				total: 1,
			}),
		};

		expect(await fetchModels(client)).toEqual([
			{
				id: "openai/gpt-5.5",
				provider: "openai",
				model: "gpt-5.5",
				label: "openai/gpt-5.5",
				max_output_tokens: 32768,
				supports_thinking: true,
				thinking_controls: {
					supported: true,
					allowed_fields: ["effort"],
					defaults_only: false,
				},
			},
		]);
	});

	it("sorts provider models by newest-looking release first", async () => {
		const client = {
			listModels: async () => ({
				models: [
					{ name: "gpt-4.1", provider: "openai", model_type: "llm" },
					{ name: "gpt-5.4", provider: "openai", model_type: "llm" },
					{ name: "gpt-5.5-pro", provider: "openai", model_type: "llm" },
					{ name: "gpt-5.5", provider: "openai", model_type: "llm" },
					{ name: "gpt-5.1-codex", provider: "openai", model_type: "llm" },
					{
						name: "claude-3-5-sonnet-20241022",
						provider: "anthropic",
						model_type: "llm",
					},
					{
						name: "claude-sonnet-4.5",
						provider: "anthropic",
						model_type: "llm",
					},
				],
				total: 7,
			}),
		};

		expect((await fetchModels(client)).map((model) => model.label)).toEqual([
			"openai/gpt-5.5",
			"openai/gpt-5.5-pro",
			"openai/gpt-5.4",
			"openai/gpt-5.1-codex",
			"openai/gpt-4.1",
			"anthropic/claude-sonnet-4.5",
			"anthropic/claude-3-5-sonnet-20241022",
		]);
	});

	it("filters non-chat providers from model results", async () => {
		const client = {
			listModels: async () => ({
				models: [
					{ name: "gpt-5.5", provider: "openai", model_type: "llm" },
					{ name: "llama-3.3-70b", provider: "featherless", model_type: "llm" },
					{
						name: "eleven_multilingual_v2",
						provider: "elevenlabs",
						model_type: "llm",
					},
				],
				total: 3,
			}),
		};

		expect((await fetchModels(client)).map((model) => model.provider)).toEqual([
			"openai",
		]);
	});

	it("uses release timestamps before model-name release keys when present", async () => {
		const client = {
			listModels: async () => ({
				models: [
					{
						name: "gpt-5.5",
						provider: "openai",
						model_type: "llm",
						last_updated: "2026-01-01T00:00:00Z",
					},
					{
						name: "gpt-5.4",
						provider: "openai",
						model_type: "llm",
						last_updated: "2026-02-01T00:00:00Z",
					},
				],
				total: 2,
			}),
		};

		expect((await fetchModels(client)).map((model) => model.label)).toEqual([
			"openai/gpt-5.4",
			"openai/gpt-5.5",
		]);
	});

	it("keeps epoch release timestamps", async () => {
		const client = {
			listModels: async () => ({
				models: [
					{
						name: "gpt-epoch",
						provider: "openai",
						model_type: "llm",
						last_updated: 0,
					},
				],
				total: 1,
			}),
		};

		expect((await fetchModels(client))[0]?.releaseTimestamp).toBe(0);
	});

	it("ignores invalid release date tokens", async () => {
		const client = {
			listModels: async () => ({
				models: [
					{
						name: "release-2025-99-99",
						provider: "openai",
						model_type: "llm",
					},
					{
						name: "release-2024-12-31",
						provider: "openai",
						model_type: "llm",
					},
				],
				total: 2,
			}),
		};

		expect((await fetchModels(client)).map((model) => model.label)).toEqual([
			"openai/release-2024-12-31",
			"openai/release-2025-99-99",
		]);
	});
});
