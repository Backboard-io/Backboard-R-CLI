import { describe, expect, it } from "bun:test";
import type { ThinkingModelMetadata } from "../src/config/defaults.ts";
import { parseThinking, resolveThinking } from "../src/config/defaults.ts";
import { createRuntimeThinkingResolver } from "../src/config/thinkingRuntime.ts";

const model = { provider: "test", model: "model" };

function metadata(
	allowedFields: string[],
	extra: Partial<ThinkingModelMetadata> = {},
): ThinkingModelMetadata {
	return {
		provider: "test",
		model: "model",
		supports_thinking: true,
		thinking_controls: {
			supported: allowedFields.length > 0,
			allowed_fields: allowedFields,
			defaults_only: false,
		},
		...extra,
	};
}

describe("thinking config", () => {
	it("parses semantic thinking intent", () => {
		expect(parseThinking("off")).toBeNull();
		expect(parseThinking("low")).toEqual({ kind: "level", level: "low" });
		expect(parseThinking("maximum")).toEqual({
			kind: "level",
			level: "max",
		});
		expect(parseThinking("4096")).toEqual({ kind: "budget", tokens: 4096 });
		expect(() => parseThinking("on")).toThrow();
	});

	it("resolves level intent using allowed fields", () => {
		expect(
			resolveThinking({
				intent: { kind: "level", level: "high" },
				model,
				metadata: metadata(["effort"]),
			}),
		).toEqual({ effort: "high" });
		expect(
			resolveThinking({
				intent: { kind: "level", level: "high" },
				model,
				metadata: metadata(["budget_tokens"]),
			}),
		).toEqual({ budget_tokens: 8192 });
		expect(
			resolveThinking({
				intent: { kind: "level", level: "high" },
				model,
				metadata: metadata(["max_tokens"]),
			}),
		).toEqual({ max_tokens: 8192 });
	});

	it("uses provider profiles when metadata is missing", () => {
		expect(
			resolveThinking({
				intent: { kind: "level", level: "max" },
				model: { provider: "google", model: "gemini-3-pro" },
			}),
		).toEqual({ effort: "high" });
		expect(
			resolveThinking({
				intent: { kind: "level", level: "max" },
				model: { provider: "anthropic", model: "claude-sonnet-4-5" },
			}),
		).toEqual({ budget_tokens: 16384 });
		expect(
			resolveThinking({
				intent: { kind: "level", level: "high" },
				model: { provider: "openrouter", model: "deepseek" },
			}),
		).toEqual({ max_tokens: 8192 });
	});

	it("uses provider-supplied budget policies for custom provider ids", () => {
		expect(
			resolveThinking({
				intent: { kind: "level", level: "medium" },
				model: { provider: "custom-anthropic", model: "claude-sonnet-4-5" },
				metadata: metadata(["budget_tokens"], {
					thinking_controls: {
						supported: true,
						allowed_fields: ["budget_tokens"],
						defaults_only: false,
						budget_policy: "anthropicLegacy",
					},
				}),
			}),
		).toEqual({ budget_tokens: 8192 });
	});

	it("routes numeric budgets only to token fields", () => {
		expect(
			resolveThinking({
				intent: { kind: "budget", tokens: 4096 },
				model,
				metadata: metadata(["max_tokens"]),
			}),
		).toEqual({ max_tokens: 4096 });
		expect(() =>
			resolveThinking({
				intent: { kind: "budget", tokens: 4096 },
				model,
				metadata: metadata(["effort"]),
			}),
		).toThrow("explicit token budgets");
	});

	it("honors defaults-only and unsupported metadata", () => {
		expect(
			resolveThinking({
				intent: { kind: "level", level: "low" },
				model,
				metadata: metadata([], {
					thinking_controls: {
						supported: false,
						allowed_fields: [],
						defaults_only: true,
					},
				}),
			}),
		).toEqual({});
		expect(() =>
			resolveThinking({
				intent: { kind: "level", level: "low" },
				model,
				metadata: metadata([], { supports_thinking: false }),
			}),
		).toThrow("not supported");
	});

	it("runtime resolver fetches targeted thinking metadata only", async () => {
		let metadataCalls = 0;
		let listCalls = 0;
		const client = {
			getModelThinkingMetadata: async (provider: string, name: string) => {
				metadataCalls += 1;
				return metadata(["max_tokens"], {
					provider,
					model: name,
					max_output_tokens: 65536,
				});
			},
			listModels: async () => {
				listCalls += 1;
				return { models: [], total: 0 };
			},
		};
		const resolver = await createRuntimeThinkingResolver(
			{
				model: { provider: "openrouter", model: "z-ai/glm-5.2" },
				thinkingIntent: { kind: "level", level: "medium" },
			},
			client,
		);

		expect(metadataCalls).toBe(1);
		expect(listCalls).toBe(0);
		expect(resolver.resolve()).toEqual({ max_tokens: 4096 });
	});

	it("runtime resolver skips metadata lookup when thinking is off", async () => {
		let metadataCalls = 0;
		const resolver = await createRuntimeThinkingResolver(
			{
				model: { provider: "openrouter", model: "z-ai/glm-5.2" },
				thinkingIntent: null,
			},
			{
				getModelThinkingMetadata: async () => {
					metadataCalls += 1;
					return metadata(["max_tokens"]);
				},
			},
		);

		expect(metadataCalls).toBe(0);
		expect(resolver.resolve()).toBeNull();
	});

	it("runtime resolver falls back when targeted metadata fails", async () => {
		const resolver = await createRuntimeThinkingResolver(
			{
				model: { provider: "openrouter", model: "z-ai/glm-5.2" },
				thinkingIntent: { kind: "level", level: "medium" },
			},
			{
				getModelThinkingMetadata: async () => {
					throw new Error("metadata unavailable");
				},
			},
		);

		expect(resolver.resolve()).toEqual({ max_tokens: 4096 });
	});
});
