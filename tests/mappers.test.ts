import { describe, expect, it } from "bun:test";
import {
	BackboardStreamEventMapper,
	mapStreamPayloadToEvents,
} from "../src/providers/backboard/mappers.ts";
import type { ProviderEvent } from "../src/providers/backboard/types.ts";

function kinds(events: ProviderEvent[]): string[] {
	return events.map((e) => e.kind);
}

describe("mapStreamPayloadToEvents", () => {
	it("maps a completed stream response", () => {
		const events = mapStreamPayloadToEvents({
			type: "run_ended",
			thread_id: "thr_1",
			final_content: "hello world",
			input_tokens: 10,
			output_tokens: 5,
			total_tokens: 15,
			model_name: "gpt-5.5",
			context_usage: {
				used_tokens: 100,
				context_limit: 1000,
				percent: 10,
				summary_tokens: 0,
				model: "gpt-5.5",
			},
		});
		expect(kinds(events)).toEqual(["thread", "usage", "completed"]);
		expect(events.at(-1)).toEqual({
			kind: "completed",
			finalText: "hello world",
			usage: {
				inputTokens: 10,
				outputTokens: 5,
				totalTokens: 15,
				contextTokens: 100,
				contextLimit: 1000,
				model: "gpt-5.5",
				provider: undefined,
			},
			contextUsage: {
				used_tokens: 100,
				context_limit: 1000,
				percent: 10,
				summary_tokens: 0,
				model: "gpt-5.5",
			},
		});
	});

	it("maps content deltas", () => {
		const events = mapStreamPayloadToEvents({
			type: "content_streaming",
			content: "hello",
		});
		expect(events).toEqual([{ kind: "assistant_delta", text: "hello" }]);
	});

	it("normalizes accumulated content streaming into deltas", () => {
		const mapper = new BackboardStreamEventMapper();

		const first = mapper.map({
			type: "content_streaming",
			content: "She climbed the stairs",
			accumulated_content: "She climbed the stairs",
		});
		const second = mapper.map({
			type: "content_streaming",
			content: ", which spiraled up higher",
			accumulated_content: "She climbed the stairs, which spiraled up higher",
		});
		const cumulativeRetry = mapper.map({
			type: "content_streaming",
			content: "She climbed the stairs, which spiraled up higher than her shop",
			accumulated_content:
				"She climbed the stairs, which spiraled up higher than her shop",
		});

		expect(first).toEqual([
			{ kind: "assistant_delta", text: "She climbed the stairs" },
		]);
		expect(second).toEqual([
			{ kind: "assistant_delta", text: ", which spiraled up higher" },
		]);
		expect(cumulativeRetry).toEqual([
			{ kind: "assistant_delta", text: " than her shop" },
		]);
	});

	it("deduplicates content field when server sends full text without accumulated_content", () => {
		const mapper = new BackboardStreamEventMapper();

		const first = mapper.map({
			type: "content_streaming",
			content: "A fox found a lantern",
		});
		const second = mapper.map({
			type: "content_streaming",
			content: "A fox found a lantern glowing in the snow",
		});
		const third = mapper.map({
			type: "content_streaming",
			content: "A fox found a lantern glowing in the snow. Who left you here?",
		});

		expect(first).toEqual([
			{ kind: "assistant_delta", text: "A fox found a lantern" },
		]);
		expect(second).toEqual([
			{ kind: "assistant_delta", text: " glowing in the snow" },
		]);
		expect(third).toEqual([
			{ kind: "assistant_delta", text: ". Who left you here?" },
		]);
	});

	it("maps a tool request and parses tool arguments", () => {
		const events = mapStreamPayloadToEvents({
			type: "tool_submit_required",
			thread_id: "thr_2",
			run_id: "run_1",
			tool_calls: [
				{
					id: "call_1",
					type: "function",
					function: { name: "Read", arguments: '{"file_path":"a.ts"}' },
				},
			],
		});
		const action = events.find((e) => e.kind === "requires_action");
		expect(action).toBeDefined();
		if (action && action.kind === "requires_action") {
			expect(action.runId).toBe("run_1");
			expect(action.calls[0]?.name).toBe("Read");
			expect(action.calls[0]?.input).toEqual({ file_path: "a.ts" });
		}
	});

	it("emits usage for tool-call legs that carry provider usage", () => {
		const events = mapStreamPayloadToEvents({
			type: "tool_submit_required",
			run_id: "run_1",
			input_tokens: 1200,
			output_tokens: 40,
			total_tokens: 1240,
			cached_input_tokens: 900,
			cache_write_input_tokens: 100,
			cost_usd: 0.0123,
			tool_calls: [
				{
					id: "call_1",
					type: "function",
					function: { name: "Read", arguments: '{"file_path":"a.ts"}' },
				},
			],
		});
		expect(kinds(events)).toEqual(["usage", "requires_action"]);
		const usage = events.find((e) => e.kind === "usage");
		if (usage && usage.kind === "usage") {
			expect(usage.usage).toMatchObject({
				inputTokens: 1200,
				outputTokens: 40,
				cachedTokens: 900,
				cacheWriteTokens: 100,
				costUsd: 0.0123,
			});
		}
	});

	it("omits usage for tool-call legs without usage fields (older servers)", () => {
		const events = mapStreamPayloadToEvents({
			type: "tool_submit_required",
			tool_calls: [
				{
					id: "call_1",
					type: "function",
					function: { name: "Read", arguments: "{}" },
				},
			],
		});
		expect(kinds(events)).toEqual(["requires_action"]);
	});

	it("carries cache and cost fields on run_ended usage", () => {
		const events = mapStreamPayloadToEvents({
			type: "run_ended",
			final_content: "done",
			input_tokens: 50,
			output_tokens: 10,
			total_tokens: 60,
			cached_input_tokens: 30,
			cache_write_input_tokens: 5,
			cost_usd: 0.002,
			model_name: "claude-opus-4-8",
		});
		const usage = events.find((e) => e.kind === "usage");
		expect(usage).toBeDefined();
		if (usage && usage.kind === "usage") {
			expect(usage.usage).toMatchObject({
				cachedTokens: 30,
				cacheWriteTokens: 5,
				costUsd: 0.002,
			});
		}
	});

	it("handles malformed tool arguments gracefully", () => {
		const events = mapStreamPayloadToEvents({
			type: "tool_submit_required",
			tool_calls: [
				{
					id: "c",
					type: "function",
					function: { name: "X", arguments: "not-json" },
				},
			],
		});
		const action = events.find((e) => e.kind === "requires_action");
		if (action && action.kind === "requires_action") {
			expect(action.calls[0]?.input).toEqual({ __raw: "not-json" });
		}
	});

	it("maps run_failed events", () => {
		const events = mapStreamPayloadToEvents({
			type: "run_failed",
			error: "boom",
		});
		expect(events).toEqual([{ kind: "failed", error: "boom" }]);
	});

	it("does not complete run_ended events with failed statuses", () => {
		const events = mapStreamPayloadToEvents({
			type: "run_ended",
			status: "failed",
			error: "model failed",
		});

		expect(events).toEqual([{ kind: "failed", error: "model failed" }]);
	});

	it("marks retryable stream server errors", () => {
		const events = mapStreamPayloadToEvents({
			type: "error",
			error: "Upstream idle timeout exceeded",
		});

		expect(events).toEqual([
			{
				kind: "failed",
				error: "Upstream idle timeout exceeded",
				retryable: true,
			},
		]);
	});

	it("keeps semantic stream failures non-retryable", () => {
		const events = mapStreamPayloadToEvents({
			type: "tool_submit_required",
			tool_calls: [],
		});

		expect(events).toEqual([
			{
				kind: "failed",
				error: "Backboard requested tool outputs without tool calls",
			},
		]);
	});

	it("maps cancelled events as failures", () => {
		const events = mapStreamPayloadToEvents({ type: "run_cancelled" });
		expect(kinds(events)).toEqual(["failed"]);
	});

	it("ignores malformed thread ids", () => {
		const events = mapStreamPayloadToEvents({
			type: "content_streaming",
			thread_id: 123,
			content: "hello",
		});

		expect(events).toEqual([{ kind: "assistant_delta", text: "hello" }]);
	});
});
