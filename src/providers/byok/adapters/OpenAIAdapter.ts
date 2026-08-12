import { contextWindowFor } from "../../../core/context/ContextWindow.ts";
import type {
	ModelCatalogItem,
	ProviderEvent,
	ProviderToolCall,
} from "../../backboard/types.ts";
import { unexpectedStreamEndMessage } from "../ByokError.ts";
import type {
	ByokMessage,
	ByokStreamRequest,
	ProviderAdapter,
} from "../ByokTypes.ts";
import { getJson, postSseJson } from "../httpStream.ts";
import { thinkingEffort } from "../thinking.ts";
import {
	OPENAI_DISABLED_TOOL_REASONING_PATTERN,
	OPENAI_NON_CHAT_MODEL_PATTERNS,
} from "./OpenAIAdapter.constants.ts";

const API_BASE = "https://api.openai.com/v1";

interface OpenAIModelsResponse {
	data?: Array<{ id?: string; created?: number }>;
}

/** A tool call assembled across `delta.tool_calls` chunks, keyed by index. */
interface PendingToolCall {
	id: string;
	name: string;
	args: string;
	announced: boolean;
}

export const openaiAdapter: ProviderAdapter = {
	id: "openai",
	label: "OpenAI",
	consoleUrl: "https://platform.openai.com/api-keys",
	keyHint: "sk-...",

	looksLikeKey(key) {
		return /^sk-[\w-]{20,}$/.test(key.trim());
	},

	async validateKey(key, signal) {
		await getJson<OpenAIModelsResponse>(
			`${API_BASE}/models`,
			headers(key),
			"openai",
			signal,
		);
	},

	async listModels(key, signal) {
		const response = await getJson<OpenAIModelsResponse>(
			`${API_BASE}/models`,
			headers(key),
			"openai",
			signal,
		);
		const models: ModelCatalogItem[] = [];
		for (const model of response.data ?? []) {
			if (!model.id || !isChatModel(model.id)) continue;
			models.push({
				name: model.id,
				provider: "openai",
				model_type: "llm",
				// The models list reports epoch seconds; the catalog sorter wants ms.
				last_updated:
					typeof model.created === "number" ? model.created * 1000 : null,
				context_limit: contextWindowFor({
					provider: "openai",
					model: model.id,
				}),
			});
		}
		return models;
	},

	supportsThinking() {
		return true;
	},

	stream(request, key) {
		return streamOpenAI(request, key);
	},
};

function headers(key: string): Record<string, string> {
	return { Authorization: `Bearer ${key.trim()}` };
}

function isChatModel(id: string): boolean {
	const normalized = id.toLowerCase();
	return !OPENAI_NON_CHAT_MODEL_PATTERNS.some((pattern) =>
		normalized.includes(pattern),
	);
}

async function* streamOpenAI(
	request: ByokStreamRequest,
	key: string,
): AsyncIterable<ProviderEvent> {
	const body: Record<string, unknown> = {
		model: request.model,
		messages: toOpenAIMessages(request),
		stream: true,
		// Without this the final chunk carries no usage at all.
		stream_options: { include_usage: true },
	};
	if (request.tools.length > 0) {
		body.tools = request.tools;
		body.tool_choice = "auto";
	}
	// OpenAI caches automatically on the prompt prefix (>1024 tokens), but only
	// when a request lands on a machine that already holds it. The cache key
	// pins one conversation to one shard, which is what turns an incidental hit
	// rate into a reliable one across a long tool loop.
	if (request.cacheKey) body.prompt_cache_key = request.cacheKey;
	const effort = thinkingEffort(request.thinking);
	// Only sent when thinking was actually requested: non-reasoning models
	// reject the parameter outright. GPT-5.4 through GPT-5.6 also reject enabled
	// reasoning when function tools are present on Chat Completions unless it is
	// explicitly disabled.
	if (
		request.tools.length > 0 &&
		requiresDisabledToolReasoning(request.model)
	) {
		body.reasoning_effort = "none";
	} else if (effort) {
		body.reasoning_effort = effort;
	}

	const pending = new Map<number, PendingToolCall>();
	let finishReason: string | null = null;
	let usage = {
		inputTokens: 0,
		outputTokens: 0,
		totalTokens: 0,
		cachedTokens: 0,
	};

	const sseRequest: Parameters<typeof postSseJson>[0] = {
		url: `${API_BASE}/chat/completions`,
		headers: headers(key),
		body,
		provider: "openai",
	};
	if (request.signal) sseRequest.signal = request.signal;

	for await (const chunk of postSseJson(sseRequest)) {
		if (chunk.error) {
			const error = chunk.error as { message?: string };
			yield {
				kind: "failed",
				error: error.message ?? "OpenAI returned an error event",
			};
			return;
		}

		const chunkUsage = chunk.usage as Record<string, unknown> | undefined;
		if (chunkUsage) usage = readUsage(chunkUsage);

		const choice = (chunk.choices as unknown[] | undefined)?.[0] as
			| {
					delta?: {
						content?: string | null;
						tool_calls?: Array<{
							index?: number;
							id?: string;
							function?: { name?: string; arguments?: string };
						}>;
					};
					finish_reason?: string | null;
			  }
			| undefined;
		if (!choice) continue;
		if (choice.finish_reason) finishReason = choice.finish_reason;

		const delta = choice.delta;
		if (delta?.content) {
			yield { kind: "assistant_delta", text: delta.content };
		}
		for (const partial of delta?.tool_calls ?? []) {
			const index = partial.index ?? 0;
			const existing = pending.get(index) ?? {
				id: partial.id ?? `call_${index}`,
				name: "",
				args: "",
				announced: false,
			};
			if (partial.id) existing.id = partial.id;
			if (partial.function?.name) existing.name += partial.function.name;
			if (partial.function?.arguments) {
				existing.args += partial.function.arguments;
			}
			pending.set(index, existing);
			// Announce as soon as the name is known so the row renders while the
			// arguments are still streaming.
			if (!existing.announced && existing.name) {
				existing.announced = true;
				yield { kind: "tool_started", id: existing.id, name: existing.name };
			}
		}
	}

	if (finishReason === null) {
		yield {
			kind: "failed",
			error: unexpectedStreamEndMessage("openai"),
			retryable: true,
		};
		return;
	}

	// Truncation cuts the arguments mid-JSON, so these calls are not runnable.
	// They must not be offered: `tool_ready` is what starts read-only tools
	// running ahead of the round, and a call built from half-parsed arguments
	// would execute with the wrong input before the turn is discarded.
	const truncated = finishReason === "length";
	if (truncated && pending.size > 0) {
		// Silently completing here would end the turn having done nothing, with
		// no hint why. Retryable: the same request can succeed with more room.
		yield {
			kind: "failed",
			error:
				"The model hit its output limit while writing a tool call, so the call was incomplete.",
			retryable: true,
		};
		return;
	}
	const calls: ProviderToolCall[] = [];
	if (!truncated) {
		for (const partial of [...pending.entries()]
			.sort(([left], [right]) => left - right)
			.map(([, value]) => value)) {
			const call: ProviderToolCall = {
				id: partial.id,
				name: partial.name,
				input: parseArguments(partial.args),
			};
			calls.push(call);
			yield { kind: "tool_ready", call };
		}
	}

	const finalUsage = {
		...usage,
		provider: "openai",
		model: request.model,
	};

	// Some models report finish_reason "stop" alongside emitted tool calls;
	// trust the calls themselves, not the label.
	if (calls.length > 0) {
		yield { kind: "usage", usage: finalUsage };
		yield { kind: "requires_action", runId: null, calls };
		return;
	}
	yield { kind: "completed", usage: finalUsage };
}

export function requiresDisabledToolReasoning(model: string): boolean {
	return OPENAI_DISABLED_TOOL_REASONING_PATTERN.test(
		model.trim().toLowerCase(),
	);
}

function readUsage(usage: Record<string, unknown>): {
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
	cachedTokens: number;
} {
	const details = usage.prompt_tokens_details as
		| Record<string, unknown>
		| undefined;
	return {
		inputTokens: numberOf(usage.prompt_tokens),
		outputTokens: numberOf(usage.completion_tokens),
		totalTokens: numberOf(usage.total_tokens),
		cachedTokens: numberOf(details?.cached_tokens),
	};
}

function numberOf(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function parseArguments(args: string): unknown {
	const trimmed = args.trim();
	if (!trimmed) return {};
	try {
		return JSON.parse(trimmed);
	} catch {
		return {};
	}
}

function toOpenAIMessages(request: ByokStreamRequest): unknown[] {
	const out: unknown[] = [{ role: "system", content: request.systemPrompt }];
	for (const message of request.messages) {
		if (message.role === "user") {
			out.push({ role: "user", content: userContent(message) });
			continue;
		}
		if (message.role === "assistant") {
			const entry: Record<string, unknown> = {
				role: "assistant",
				content: message.content || null,
			};
			if (message.toolCalls.length > 0) {
				entry.tool_calls = message.toolCalls.map((call) => ({
					id: call.id,
					type: "function",
					function: {
						name: call.name,
						arguments: JSON.stringify(call.input ?? {}),
					},
				}));
			}
			out.push(entry);
			continue;
		}
		// Each tool result is its own message, matching one prior tool_call id.
		for (const result of message.results) {
			out.push({
				role: "tool",
				tool_call_id: result.id,
				content: result.output || "(no output)",
			});
		}
	}
	return out;
}

function userContent(
	message: Extract<ByokMessage, { role: "user" }>,
): string | unknown[] {
	const attachments = message.attachments ?? [];
	if (attachments.length === 0) return message.content;

	const parts: unknown[] = [];
	for (const attachment of attachments) {
		if (attachment.base64) {
			parts.push({
				type: "image_url",
				image_url: {
					url: `data:${attachment.mediaType};base64,${attachment.base64}`,
				},
			});
		} else if (attachment.text) {
			parts.push({
				type: "text",
				text: `Attached file ${attachment.path}:\n${attachment.text}`,
			});
		}
	}
	parts.push({ type: "text", text: message.content || "(empty message)" });
	return parts;
}
