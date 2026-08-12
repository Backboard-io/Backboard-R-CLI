import { describe, expect, it } from "bun:test";
import { buildContextReport } from "../src/core/context/ContextReport.ts";
import {
	contextWindowFor,
	DEFAULT_CONTEXT_WINDOW,
	resolveContextWindow,
} from "../src/core/context/ContextWindow.ts";
import { formatTokens } from "../src/core/context/tokens.ts";
import {
	assistantMessage,
	toolMessage,
	userMessage,
} from "../src/core/session/Message.ts";
import type { OpenAITool } from "../src/core/tools/schema.ts";

const TOOLS: OpenAITool[] = [
	{
		type: "function",
		function: {
			name: "read_file",
			description: "Read a file from disk",
			parameters: { type: "object", properties: { path: { type: "string" } } },
		},
	},
];

const BASE = {
	model: { provider: "anthropic", model: "claude-opus-5" },
	source: "byok",
	systemPrompt: "You are a coding agent.",
	tools: TOOLS,
	todos: [],
	reportedLimit: null,
	cachedTokens: 0,
	compactThresholdPercent: 85,
};

describe("context windows", () => {
	it("knows the major families", () => {
		expect(
			contextWindowFor({ provider: "anthropic", model: "claude-opus-5" }),
		).toBe(200_000);
		expect(contextWindowFor({ provider: "openai", model: "gpt-5.5" })).toBe(
			400_000,
		);
		expect(
			contextWindowFor({ provider: "google", model: "gemini-2.5-flash" }),
		).toBe(1_048_576);
		// gpt-4.1 is a 1M-token model, not a 400k one like gpt-5.
		expect(contextWindowFor({ provider: "openai", model: "gpt-4.1" })).toBe(
			1_047_576,
		);
		expect(contextWindowFor({ provider: "openai", model: "gpt-4o" })).toBe(
			128_000,
		);
		expect(
			contextWindowFor({
				provider: "openrouter",
				model: "anthropic/claude-sonnet-4.6",
			}),
		).toBe(200_000);
		expect(
			contextWindowFor({
				provider: "openrouter",
				model: "google/gemini-2.5-flash",
			}),
		).toBe(1_048_576);
	});

	it("falls back conservatively for an unknown model", () => {
		// Over-estimating would let a conversation sail past the real limit and
		// hard-fail mid-task, which is worse than compressing early.
		expect(
			contextWindowFor({ provider: "someone", model: "brand-new-model" }),
		).toBe(DEFAULT_CONTEXT_WINDOW);
	});

	it("prefers a backend-reported limit over the table", () => {
		expect(
			resolveContextWindow(
				{ provider: "anthropic", model: "claude-opus-5" },
				1_000_000,
			),
		).toBe(1_000_000);
		expect(
			resolveContextWindow(
				{ provider: "anthropic", model: "claude-opus-5" },
				0,
			),
		).toBe(200_000);
	});
});

describe("context report", () => {
	const messages = [
		userMessage("fix the bug"),
		assistantMessage("reading", [
			{ id: "c1", name: "read_file", input: { path: "/a.ts" } },
		]),
		toolMessage([
			{
				toolCallId: "c1",
				name: "read_file",
				output: "x".repeat(4000),
				isError: false,
			},
		]),
	];

	it("uses the measured total when a turn has reported usage", () => {
		const report = buildContextReport({
			...BASE,
			messages,
			usedTokens: 50_000,
		});

		expect(report.measured).toBe(true);
		expect(report.usedTokens).toBe(50_000);
		expect(report.percent).toBeCloseTo(25, 0);
	});

	it("falls back to the estimate before any turn is measured", () => {
		const report = buildContextReport({ ...BASE, messages, usedTokens: 0 });

		expect(report.measured).toBe(false);
		expect(report.usedTokens).toBe(report.estimatedTotal);
		expect(report.usedTokens).toBeGreaterThan(0);
	});

	it("attributes bulky tool output to the tool-results segment", () => {
		const report = buildContextReport({ ...BASE, messages, usedTokens: 0 });
		const toolResults = report.segments.find(
			(segment) => segment.label === "Tool results",
		);
		const userMessages = report.segments.find(
			(segment) => segment.label === "Your messages",
		);

		expect(toolResults?.tokens).toBeGreaterThan(900);
		expect(toolResults?.tokens).toBeGreaterThan(userMessages?.tokens ?? 0);
	});

	it("reports where the compression threshold sits", () => {
		const report = buildContextReport({
			...BASE,
			messages,
			usedTokens: 10_000,
		});

		expect(report.compactAtTokens).toBe(170_000);
		expect(report.compactThresholdPercent).toBe(85);
	});

	it("reports the cache share of the last request", () => {
		const report = buildContextReport({
			...BASE,
			messages,
			usedTokens: 100_000,
			cachedTokens: 90_000,
		});

		expect(report.cachedPercent).toBeCloseTo(90, 0);
	});

	it("includes the task list only when there is one", () => {
		const without = buildContextReport({ ...BASE, messages, usedTokens: 0 });
		expect(
			without.segments.some((segment) => segment.label === "Task list"),
		).toBe(false);

		const with_ = buildContextReport({
			...BASE,
			messages,
			usedTokens: 0,
			todos: [{ id: "1", content: "do the thing", status: "pending" }],
		});
		expect(
			with_.segments.some((segment) => segment.label === "Task list"),
		).toBe(true);
	});
});

describe("formatTokens", () => {
	it("scales the unit to the magnitude", () => {
		expect(formatTokens(950)).toBe("950");
		expect(formatTokens(1_200)).toBe("1.2k");
		expect(formatTokens(31_000)).toBe("31k");
		expect(formatTokens(1_048_576)).toBe("1.05M");
	});
});
