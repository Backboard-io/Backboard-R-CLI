import { BACKBOARD_STREAM_EVENTS } from "./constants.ts";
import { isRetryableStreamServerErrorMessage } from "./streamRetry.ts";
import type {
	BackboardContextUsage,
	BackboardStreamPayload,
	ContentDeltaResult,
	ProviderEvent,
	ProviderToolCall,
	RawToolCall,
	StreamMappingResult,
} from "./types.ts";

export function parseArguments(raw: string): unknown {
	if (!raw) return {};
	try {
		return JSON.parse(raw);
	} catch {
		return { __raw: raw };
	}
}

export function mapToolCall(call: RawToolCall): ProviderToolCall {
	return {
		id: call.id,
		name: call.function.name,
		input: parseArguments(call.function.arguments),
	};
}

export class BackboardStreamEventMapper {
	private accumulatedContent = "";

	map(payload: unknown): ProviderEvent[] {
		const result = mapStreamPayload(payload, this.accumulatedContent);
		this.accumulatedContent = result.accumulatedContent;
		return result.events;
	}
}

export function mapStreamPayloadToEvents(payload: unknown): ProviderEvent[] {
	return mapStreamPayload(payload, "").events;
}

function mapStreamPayload(
	payload: unknown,
	previousAccumulatedContent: string,
): StreamMappingResult {
	if (!isBackboardStreamPayload(payload)) {
		return {
			events: [failedEvent("Backboard stream sent a non-object event")],
			accumulatedContent: previousAccumulatedContent,
		};
	}

	const events: ProviderEvent[] = [];
	let accumulatedContent = previousAccumulatedContent;
	const threadId = stringField(payload, "thread_id");
	if (threadId) {
		events.push({ kind: "thread", threadId });
	}

	switch (payload.type) {
		case BACKBOARD_STREAM_EVENTS.userMessage:
			return { events, accumulatedContent };
		case BACKBOARD_STREAM_EVENTS.contentStreaming: {
			const content = normalizeContentDelta(payload, accumulatedContent);
			accumulatedContent = content.accumulatedContent;
			const text = content.text;
			if (text) events.push({ kind: "assistant_delta", text });
			return { events, accumulatedContent };
		}
		case BACKBOARD_STREAM_EVENTS.toolCallStart: {
			// Advisory early-render event; malformed frames are dropped, never fatal.
			const id = stringField(payload, "tool_call_id");
			const name = stringField(payload, "name");
			if (id && name) events.push({ kind: "tool_started", id, name });
			return { events, accumulatedContent };
		}
		case BACKBOARD_STREAM_EVENTS.toolCallReady: {
			// Advisory early-execution event; malformed frames are dropped.
			const rawCall = (payload as Record<string, unknown>).tool_call;
			if (isRawToolCall(rawCall)) {
				events.push({ kind: "tool_ready", call: mapToolCall(rawCall) });
			}
			return { events, accumulatedContent };
		}
		case BACKBOARD_STREAM_EVENTS.toolSubmitRequired: {
			const rawCalls: unknown[] = Array.isArray(payload.tool_calls)
				? payload.tool_calls
				: [];
			const calls = rawCalls
				.filter(isRawToolCall)
				.map((call) => mapToolCall(call));
			if (calls.length === 0) {
				events.push(
					failedEvent("Backboard requested tool outputs without tool calls"),
				);
			} else {
				// Tool-call legs carry provider usage too (each leg is a billed
				// LLM inference); emit it so per-call telemetry isn't limited to
				// completed runs.
				addUsageEvent(events, payload);
				events.push({
					kind: "requires_action",
					runId: stringField(payload, "run_id") ?? null,
					calls,
				});
			}
			return { events, accumulatedContent };
		}
		case BACKBOARD_STREAM_EVENTS.runEnded:
		case BACKBOARD_STREAM_EVENTS.messageComplete: {
			if (!isCompletedStatus(stringField(payload, "status"))) {
				events.push(
					failedEvent(
						stringField(payload, "error") ??
							stringField(payload, "message") ??
							"Backboard run did not complete",
					),
				);
				return { events, accumulatedContent };
			}
			addUsageEvent(events, payload);
			const contextUsage = contextUsageField(payload);
			const usage = usageFromPayload(payload);
			events.push({
				kind: "completed",
				finalText:
					stringField(payload, "final_content") ??
					stringField(payload, "content") ??
					undefined,
				...(usage ? { usage } : {}),
				...(contextUsage ? { contextUsage } : {}),
			});
			return { events, accumulatedContent };
		}
		case BACKBOARD_STREAM_EVENTS.runFailed:
			events.push(
				failedEvent(
					stringField(payload, "error") ??
						stringField(payload, "message") ??
						"Backboard run failed",
				),
			);
			return { events, accumulatedContent };
		case BACKBOARD_STREAM_EVENTS.runCancelled:
			events.push({ kind: "failed", error: "Backboard run was cancelled" });
			return { events, accumulatedContent };
		case BACKBOARD_STREAM_EVENTS.error:
			events.push(
				failedEvent(
					stringField(payload, "error") ??
						stringField(payload, "message") ??
						"Backboard stream failed",
				),
			);
			return { events, accumulatedContent };
		default:
			return { events, accumulatedContent };
	}
}

function failedEvent(
	error: string,
): Extract<ProviderEvent, { kind: "failed" }> {
	const retryable = isRetryableStreamServerErrorMessage(error);
	return {
		kind: "failed",
		error,
		...(retryable ? { retryable: true } : {}),
	};
}

function normalizeContentDelta(
	payload: BackboardStreamPayload,
	previousAccumulatedContent: string,
): ContentDeltaResult {
	const text = stringField(payload, "content");
	const accumulatedContent = stringField(payload, "accumulated_content");
	if (accumulatedContent === null) {
		if (text?.startsWith(previousAccumulatedContent)) {
			const delta = text.slice(previousAccumulatedContent.length);
			return { text: delta || null, accumulatedContent: text };
		}
		return {
			text,
			accumulatedContent: previousAccumulatedContent + (text ?? ""),
		};
	}
	if (accumulatedContent.startsWith(previousAccumulatedContent)) {
		return {
			text: accumulatedContent.slice(previousAccumulatedContent.length),
			accumulatedContent,
		};
	}
	return {
		text: text ?? accumulatedContent,
		accumulatedContent,
	};
}

function addUsageEvent(
	events: ProviderEvent[],
	payload: Record<string, unknown>,
) {
	const usage = usageFromPayload(payload);
	if (!usage) return;
	events.push({ kind: "usage", usage });
}

function usageFromPayload(
	payload: Record<string, unknown>,
): Extract<ProviderEvent, { kind: "usage" }>["usage"] | null {
	const contextUsage = contextUsageField(payload);
	if (
		payload.input_tokens == null &&
		payload.output_tokens == null &&
		payload.total_tokens == null &&
		payload.model_name == null &&
		contextUsage === undefined
	) {
		return null;
	}
	return {
		inputTokens: numberField(payload, "input_tokens"),
		outputTokens: numberField(payload, "output_tokens"),
		totalTokens: numberField(payload, "total_tokens"),
		cachedTokens: numberField(payload, "cached_input_tokens"),
		cacheWriteTokens: numberField(payload, "cache_write_input_tokens"),
		costUsd: numberField(payload, "cost_usd"),
		contextTokens: contextUsage?.used_tokens,
		contextLimit: contextUsage?.context_limit,
		provider: stringField(payload, "model_provider") ?? undefined,
		model: stringField(payload, "model_name") ?? undefined,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isBackboardStreamPayload(
	value: unknown,
): value is BackboardStreamPayload {
	return isRecord(value) && typeof value.type === "string";
}

export function isRawToolCall(value: unknown): value is RawToolCall {
	if (!isRecord(value) || value.type !== "function") return false;
	const fn = value.function;
	return (
		typeof value.id === "string" &&
		isRecord(fn) &&
		typeof fn.name === "string" &&
		typeof fn.arguments === "string"
	);
}

function stringField(
	record: Record<string, unknown>,
	key: string,
): string | null {
	const value = record[key];
	return typeof value === "string" ? value : null;
}

function numberField(
	record: Record<string, unknown>,
	key: string,
): number | undefined {
	const value = record[key];
	return typeof value === "number" ? value : undefined;
}

function contextUsageField(
	record: Record<string, unknown>,
): BackboardContextUsage | undefined {
	const value = record.context_usage;
	if (!isRecord(value)) return undefined;
	return {
		...(typeof value.used_tokens === "number"
			? { used_tokens: value.used_tokens }
			: {}),
		...(typeof value.context_limit === "number"
			? { context_limit: value.context_limit }
			: {}),
		...(typeof value.percent === "number" ? { percent: value.percent } : {}),
		...(typeof value.summary_tokens === "number"
			? { summary_tokens: value.summary_tokens }
			: {}),
		...(typeof value.model === "string" ? { model: value.model } : {}),
	};
}

function isCompletedStatus(status: string | null): boolean {
	return status === null || status.toLowerCase() === "completed";
}
