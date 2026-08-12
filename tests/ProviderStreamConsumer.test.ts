import { describe, expect, it } from "bun:test";
import type { AssistantAccumulator } from "../src/core/agent/AssistantAccumulator.ts";
import { ProviderStreamConsumer } from "../src/core/agent/ProviderStreamConsumer.ts";
import { EventBus } from "../src/core/bus/EventBus.ts";
import { Session } from "../src/core/session/Session.ts";
import { AbortError } from "../src/core/tools/ToolAbort.ts";
import type { EarlyToolSink } from "../src/core/tools/ToolScheduler.ts";
import type { ProviderEvent } from "../src/providers/backboard/types.ts";

function stubAssistant(): AssistantAccumulator {
	return {
		appendDelta: () => {},
		finalize: () => {},
		discardPartial: () => {},
	} as unknown as AssistantAccumulator;
}

class RecordingSink implements EarlyToolSink {
	announced: string[] = [];
	resets = 0;
	announce(id: string): void {
		this.announced.push(id);
	}
	offer(): void {}
	reset(): void {
		this.resets++;
	}
}

async function* streamOf(
	events: ProviderEvent[],
): AsyncIterable<ProviderEvent> {
	for (const event of events) yield event;
}

describe("ProviderStreamConsumer", () => {
	it("resets the early round on a terminal (non-retryable) stream failure", async () => {
		const consumer = new ProviderStreamConsumer(
			new EventBus(),
			new Session("sess_test"),
		);
		const sink = new RecordingSink();
		let preserved = 0;
		await expect(
			consumer.consumeWithRetry(
				() =>
					streamOf([
						{ kind: "tool_started", id: "call_1", name: "Read" },
						{ kind: "failed", error: "boom", retryable: false },
					]),
				stubAssistant(),
				new AbortController().signal,
				sink,
				async () => {
					preserved++;
					return null;
				},
			),
		).rejects.toThrow("boom");
		// Without this reset the announced row would strand as pending: the
		// caller never reaches process(), whose finally is the usual cleanup.
		expect(sink.announced).toEqual(["call_1"]);
		expect(sink.resets).toBe(1);
		expect(preserved).toBe(1);
	});

	it("resets the early round when the stream aborts", async () => {
		const consumer = new ProviderStreamConsumer(
			new EventBus(),
			new Session("sess_test"),
		);
		const sink = new RecordingSink();
		const abort = new AbortController();
		async function* abortingStream(): AsyncIterable<ProviderEvent> {
			yield { kind: "tool_started", id: "call_1", name: "Read" };
			abort.abort();
			throw new AbortError();
		}
		await expect(
			consumer.consumeWithRetry(
				() => abortingStream(),
				stubAssistant(),
				abort.signal,
				sink,
			),
		).rejects.toThrow();
		expect(sink.resets).toBe(1);
	});

	it("resets between retries and not terminally on eventual success", async () => {
		const consumer = new ProviderStreamConsumer(
			new EventBus(),
			new Session("sess_test"),
		);
		const sink = new RecordingSink();
		let attempt = 0;
		const result = await consumer.consumeWithRetry(
			() => {
				attempt++;
				return attempt === 1
					? streamOf([{ kind: "failed", error: "hiccup", retryable: true }])
					: streamOf([{ kind: "completed", finalText: "ok" }]);
			},
			stubAssistant(),
			new AbortController().signal,
			sink,
		);
		expect(result).toBeNull();
		expect(sink.resets).toBe(1);
	});

	it("retries a stream that closes without a terminal event", async () => {
		const consumer = new ProviderStreamConsumer(
			new EventBus(),
			new Session("sess_test"),
		);
		const sink = new RecordingSink();
		let attempt = 0;
		const result = await consumer.consumeWithRetry(
			() => {
				attempt++;
				return attempt === 1
					? streamOf([{ kind: "assistant_delta", text: "partial" }])
					: streamOf([{ kind: "completed", finalText: "complete" }]);
			},
			stubAssistant(),
			new AbortController().signal,
			sink,
		);

		expect(result).toBeNull();
		expect(attempt).toBe(2);
		expect(sink.resets).toBe(1);
	});

	it("preserves the failed input when cancellation interrupts retry backoff", async () => {
		const consumer = new ProviderStreamConsumer(
			new EventBus(),
			new Session("sess_test"),
		);
		const abort = new AbortController();
		let preserved = 0;
		setTimeout(() => abort.abort(), 10);

		await expect(
			consumer.consumeWithRetry(
				() =>
					streamOf([{ kind: "failed", error: "retry later", retryable: true }]),
				stubAssistant(),
				abort.signal,
				undefined,
				async () => {
					preserved++;
					return null;
				},
			),
		).rejects.toThrow();

		expect(preserved).toBe(1);
	});
});
