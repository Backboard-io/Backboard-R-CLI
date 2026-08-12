import { describe, expect, it } from "bun:test";
import type { ThinkingConfig } from "../src/config/thinking.types.ts";
import {
	applyAnthropicThinking,
	maxOutputTokensFor,
} from "../src/providers/byok/adapters/AnthropicAdapter.ts";
import {
	googleThinkingConfig,
	isGoogleChatModel,
	renderGoogleContents,
	supportsGoogleThinking,
} from "../src/providers/byok/adapters/GoogleAdapter.ts";
import type {
	ByokMessage,
	ByokStreamRequest,
} from "../src/providers/byok/ByokTypes.ts";

function body(
	model: string,
	thinking: ThinkingConfig | null,
	maxTokens = 32_000,
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	const request: ByokStreamRequest = {
		model,
		thinking,
		messages: [],
		tools: [],
		systemPrompt: "",
	};
	applyAnthropicThinking(out, request, maxTokens);
	return out;
}

describe("Anthropic thinking payload", () => {
	// Claude 5 and Opus 4.7+ hard-400 on the legacy shape: "thinking.type.enabled
	// is not supported for this model".
	it("sends adaptive thinking with output_config.effort for Claude 5", () => {
		const out = body("claude-opus-5", { effort: "low" });

		expect(out.thinking).toEqual({ type: "adaptive" });
		expect(out.output_config).toEqual({ effort: "low" });
		expect(out.temperature).toBe(1);
	});

	it("keeps the full effort scale, including max", () => {
		expect(body("claude-opus-5", { effort: "max" }).output_config).toEqual({
			effort: "max",
		});
	});

	it("buckets a token budget into an effort rather than dropping it", () => {
		expect(
			body("claude-opus-5", { budget_tokens: 16_000 }).output_config,
		).toEqual({ effort: "high" });
	});

	it("asks for adaptive with no effort when thinking is on but unspecified", () => {
		const out = body("claude-opus-5", {});

		expect(out.thinking).toEqual({ type: "adaptive" });
		expect(out.output_config).toBeUndefined();
	});

	it("still sends the legacy budget shape for older models", () => {
		const out = body("claude-opus-4-5-20251101", { effort: "medium" });

		expect(out.thinking).toEqual({ type: "enabled", budget_tokens: 8_192 });
		expect(out.output_config).toBeUndefined();
	});

	it("clamps a legacy budget so there is room left to answer", () => {
		const out = body(
			"claude-sonnet-4-5-20250929",
			{ budget_tokens: 60_000 },
			8_000,
		);

		expect(out.thinking).toEqual({ type: "enabled", budget_tokens: 3_904 });
	});

	it("omits thinking entirely when none was requested", () => {
		expect(body("claude-opus-5", null)).toEqual({});
	});
});

describe("Gemini thinking payload", () => {
	function google(model: string, thinking: ThinkingConfig | null) {
		return googleThinkingConfig({
			model,
			thinking,
			messages: [],
			tools: [],
			systemPrompt: "",
		});
	}

	it("drives Gemini 3 with a named level, not a token budget", () => {
		expect(google("gemini-3-flash-preview", { effort: "high" })).toEqual({
			thinkingLevel: "high",
		});
	});

	// The API rejects "max" outright: invalid value for thinking_level.
	it("clamps max down to high, which is the ceiling Gemini accepts", () => {
		expect(google("gemini-3-flash-preview", { effort: "max" })).toEqual({
			thinkingLevel: "high",
		});
	});

	it("keeps the token budget for pre-3 models", () => {
		expect(google("gemini-2.5-flash", { effort: "medium" })).toEqual({
			thinkingBudget: 4096,
		});
	});

	it("sends nothing when thinking was not requested", () => {
		expect(google("gemini-3-flash-preview", null)).toBeNull();
	});
});

describe("Gemini BYOK model capabilities", () => {
	it("keeps text and tool-capable Gemini and Gemma models", () => {
		expect(isGoogleChatModel("gemini-3.5-flash")).toBe(true);
		expect(isGoogleChatModel("gemini-robotics-er-2-preview")).toBe(true);
		expect(isGoogleChatModel("gemma-4-31b-it")).toBe(true);
	});

	it("filters specialized models the coding-agent request shape cannot drive", () => {
		for (const model of [
			"antigravity-preview-05-2026",
			"deep-research-preview-04-2026",
			"gemini-2.5-computer-use-preview-10-2025",
			"gemini-2.5-flash-image",
			"gemini-omni-flash-preview",
			"lyria-3-pro-preview",
			"nano-banana-pro-preview",
		]) {
			expect(isGoogleChatModel(model)).toBe(false);
		}
	});

	it("reports thinking for Gemini but not Gemma", () => {
		expect(supportsGoogleThinking("gemini-2.5-flash")).toBe(true);
		expect(supportsGoogleThinking("gemini-3.6-flash")).toBe(true);
		expect(supportsGoogleThinking("gemini-flash-latest")).toBe(true);
		expect(supportsGoogleThinking("gemini-2.0-flash")).toBe(false);
		expect(supportsGoogleThinking("gemini-1.5-pro")).toBe(false);
		expect(supportsGoogleThinking("gemma-4-31b-it")).toBe(false);
	});
});

interface RenderedPart {
	functionCall?: { name: string; id?: string };
	functionResponse?: { name: string; id?: string };
	thoughtSignature?: string;
}

function render(messages: ByokMessage[]): Array<{ parts: RenderedPart[] }> {
	return renderGoogleContents(messages) as Array<{ parts: RenderedPart[] }>;
}

describe("Gemini function-call round-trip", () => {
	// Two calls to the same tool in one round are indistinguishable by name, and
	// Gemini 3 loses track of which result answers which - in practice ending the
	// turn with no text at all.
	it("echoes Gemini's own call id onto both the call and its result", () => {
		const rendered = render([
			{
				role: "assistant",
				content: "",
				toolCalls: [
					{
						id: "abc123",
						name: "execute",
						input: { command: "echo a" },
						signature: "sig",
					},
					{ id: "def456", name: "execute", input: { command: "echo b" } },
				],
			},
			{
				role: "tool",
				results: [
					{ id: "abc123", name: "execute", output: "a" },
					{ id: "def456", name: "execute", output: "b" },
				],
			},
		]);

		expect(rendered[0]?.parts[0]?.functionCall?.id).toBe("abc123");
		expect(rendered[0]?.parts[0]?.thoughtSignature).toBe("sig");
		expect(rendered[0]?.parts[1]?.functionCall?.id).toBe("def456");
		expect(rendered[1]?.parts[0]?.functionResponse?.id).toBe("abc123");
		expect(rendered[1]?.parts[1]?.functionResponse?.id).toBe("def456");
	});

	// Pre-3 Gemini sends no ids, so ours are local bookkeeping and must not leak.
	it("keeps locally minted ids off the wire", () => {
		const rendered = render([
			{
				role: "assistant",
				content: "",
				toolCalls: [{ id: "gemini_call_0", name: "execute", input: {} }],
			},
			{
				role: "tool",
				results: [{ id: "gemini_call_0", name: "execute", output: "a" }],
			},
		]);

		expect(rendered[0]?.parts[0]?.functionCall?.id).toBeUndefined();
		expect(rendered[0]?.parts[0]?.thoughtSignature).toBeUndefined();
		expect(rendered[1]?.parts[0]?.functionResponse?.id).toBeUndefined();
	});
});

describe("Anthropic output ceiling", () => {
	// Over a model's ceiling is a hard 400, not a clamp, and listModels surfaces
	// whatever the account can reach - including families capped well below the
	// default.
	it("caps legacy families to their own ceiling", () => {
		expect(maxOutputTokensFor("claude-3-5-haiku-20241022", 32_000)).toBe(8_192);
		expect(maxOutputTokensFor("claude-3-opus-20240229", 32_000)).toBe(4_096);
		expect(maxOutputTokensFor("claude-3-7-sonnet-20250219", 32_000)).toBe(
			32_000,
		);
	});

	it("leaves current models at the requested budget", () => {
		expect(maxOutputTokensFor("claude-opus-5", 32_000)).toBe(32_000);
		expect(maxOutputTokensFor("claude-sonnet-4-5-20250929", 32_000)).toBe(
			32_000,
		);
	});

	it("never raises a caller's lower request", () => {
		expect(maxOutputTokensFor("claude-3-opus-20240229", 1_000)).toBe(1_000);
	});
});
