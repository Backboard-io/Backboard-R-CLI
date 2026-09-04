import { joinProviderUrl } from "../../../config/providers.ts";
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
import { compatibleOpenAITools } from "../openAIToolSchemas.ts";
import { thinkingEffort } from "../thinking.ts";
import {
	imageDataUri,
	planToolImages,
	renderToolResult,
	TOOL_IMAGE_NOTE,
} from "../toolImages.ts";
import type { ConfigurableAdapterOptions } from "./ConfigurableAdapterTypes.ts";
import {
	OPENAI_DISABLED_TOOL_REASONING_PATTERN,
	OPENAI_NON_CHAT_MODEL_PATTERNS,
} from "./OpenAIAdapter.constants.ts";
import {
	configurableModelsUrl,
	configuredOpenAIModel,
	effortThinkingControls,
	type OpenAICompatibleModelsResponse,
	openAICompatibleHeaders,
} from "./OpenAICompatibleShared.ts";

/** A tool call assembled across `delta.tool_calls` chunks, keyed by index. */
interface PendingToolCall {
	id: string;
	name: string;
	args: string;
	announced: boolean;
	signature?: string;
}

export type OpenAIChatAdapterOptions = ConfigurableAdapterOptions;

const OPENAI_OPTIONS: OpenAIChatAdapterOptions = {
	id: "openai",
	label: "OpenAI",
	baseUrl: "https://api.openai.com/v1",
	consoleUrl: "https://platform.openai.com/api-keys",
	keyHint: "sk-...",
	requiresKey: true,
};

export const openaiAdapter: ProviderAdapter =
	createOpenAIChatAdapter(OPENAI_OPTIONS);

export function createOpenAIChatAdapter(
	options: OpenAIChatAdapterOptions,
): ProviderAdapter {
	return {
		id: options.id,
		label: options.label,
		consoleUrl: options.consoleUrl ?? options.baseUrl,
		keyHint: options.keyHint ?? "API key (optional for keyless endpoints)",
		requiresKey: options.requiresKey ?? true,

		looksLikeKey(key) {
			return options.id === "openai"
				? /^sk-[\w-]{20,}$/.test(key.trim())
				: Boolean(key.trim()) || options.requiresKey === false;
		},

		async validateKey(key, signal) {
			if (options.discoverModels === false) return;
			await getJson<OpenAICompatibleModelsResponse>(
				configurableModelsUrl(options),
				openAICompatibleHeaders(key, options),
				options.id,
				signal,
			);
		},

		async listModels(key, signal) {
			const response =
				options.discoverModels === false
					? { data: [] }
					: await getJson<OpenAICompatibleModelsResponse>(
							configurableModelsUrl(options),
							openAICompatibleHeaders(key, options),
							options.id,
							signal,
						);
			const models = new Map<string, ModelCatalogItem>();
			for (const model of response.data ?? response.models ?? []) {
				const id = model.id ?? model.name;
				if (!id || !isOpenAIChatModel(id)) continue;
				models.set(id.toLowerCase(), {
					name: id,
					provider: options.id,
					model_type: "llm",
					...(options.id === "openai"
						? {}
						: {
								supports_thinking: true,
								thinking_controls: effortThinkingControls(),
							}),
					// The models list reports epoch seconds; the catalog sorter wants ms.
					last_updated:
						typeof model.created === "number" ? model.created * 1000 : null,
					context_limit: contextWindowFor({
						provider: options.id,
						model: id,
					}),
				});
			}
			for (const model of options.models ?? []) {
				if (model.enabled === false) {
					models.delete(model.id.toLowerCase());
					continue;
				}
				models.set(
					model.id.toLowerCase(),
					configuredOpenAIModel(options.id, model),
				);
			}
			return [...models.values()];
		},

		supportsThinking(model) {
			const configured = options.models?.find((entry) => entry.id === model);
			return configured?.supportsThinking ?? true;
		},

		thinkingControls(model) {
			const configured = options.models?.find((entry) => entry.id === model);
			return configured?.supportsThinking === false
				? undefined
				: effortThinkingControls();
		},

		stream(request, key) {
			return streamOpenAI(request, key, options);
		},
	};
}

export function isOpenAIChatModel(id: string): boolean {
	const normalized = id.toLowerCase();
	return !OPENAI_NON_CHAT_MODEL_PATTERNS.some((pattern) =>
		normalized.includes(pattern),
	);
}

export function openAIModelAcceptsImages(model: string): boolean {
	const normalized = model.startsWith("ft:")
		? (model.split(":")[1] ?? model)
		: model;
	return !/^(?:gpt-3\.5(?:-|$)|gpt-4(?:-32k)?(?:$|-(?:0314|0613)$)|gpt-4-(?:0125|1106)-preview$|gpt-4-turbo-preview$|o1-(?:mini|preview)(?:-|$)|o3-mini(?:-|$))/i.test(
		normalized,
	);
}

async function* streamOpenAI(
	request: ByokStreamRequest,
	key: string,
	options: OpenAIChatAdapterOptions = OPENAI_OPTIONS,
): AsyncIterable<ProviderEvent> {
	const modelConfig = options.models?.find(
		(entry) => entry.id === request.model,
	);
	const body: Record<string, unknown> = {
		...options.extraArgs,
		...modelConfig?.extraArgs,
		model: request.model,
		messages: toOpenAIMessages(
			request,
			modelConfig?.noImageSupport === true ? false : undefined,
			options.id,
		),
		stream: true,
	};
	// Official OpenAI needs this to emit usage. Some compatible servers reject
	// the option, so custom providers opt in through extraArgs instead.
	if (options.id === "openai") {
		body.stream_options = { include_usage: true };
	}
	if (request.tools.length > 0) {
		body.tools = compatibleOpenAITools(request.tools);
		body.tool_choice = "auto";
	}
	// OpenAI caches automatically on the prompt prefix (>1024 tokens), but only
	// when a request lands on a machine that already holds it. The cache key
	// pins one conversation to one shard, which is what turns an incidental hit
	// rate into a reliable one across a long tool loop.
	if (request.cacheKey && options.id === "openai") {
		body.prompt_cache_key = request.cacheKey;
	}
	const maxOutputTokens =
		request.maxOutputTokens ?? modelConfig?.maxOutputTokens;
	if (maxOutputTokens) {
		if (
			modelConfig?.supportsThinking === true ||
			/^(?:gpt-5|o[1-9])(?:$|[-.])/i.test(request.model)
		) {
			body.max_completion_tokens = maxOutputTokens;
		} else {
			body.max_tokens = maxOutputTokens;
		}
	}
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
		url: joinProviderUrl(options.baseUrl, "chat/completions"),
		headers: openAICompatibleHeaders(key, options),
		body,
		provider: options.id,
	};
	if (request.signal) sseRequest.signal = request.signal;

	for await (const chunk of postSseJson(sseRequest)) {
		if (chunk.error) {
			const error = chunk.error as { message?: string };
			yield {
				kind: "failed",
				error: error.message ?? `${options.label} returned an error event`,
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
							extra_content?: {
								google?: { thought_signature?: string };
							};
						}>;
					};
					message?: {
						content?: string | null;
						tool_calls?: Array<{
							index?: number;
							id?: string;
							function?: { name?: string; arguments?: string };
							extra_content?: {
								google?: { thought_signature?: string };
							};
						}>;
					};
					finish_reason?: string | null;
			  }
			| undefined;
		if (!choice) continue;
		if (choice.finish_reason) finishReason = choice.finish_reason;

		const delta = choice.delta ?? choice.message;
		if (delta?.content) {
			yield { kind: "assistant_delta", text: delta.content };
		}
		for (const [position, partial] of (delta?.tool_calls ?? []).entries()) {
			const index = partial.index ?? position;
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
			const signature = partial.extra_content?.google?.thought_signature;
			if (signature) existing.signature = signature;
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
			error: unexpectedStreamEndMessage(options.label),
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
				...(partial.signature
					? {
							signature: partial.signature,
							signatureProvider: options.id,
						}
					: {}),
			};
			calls.push(call);
			yield { kind: "tool_ready", call };
		}
	}

	const finalUsage = {
		...usage,
		provider: options.id,
		model: request.model,
		...(modelConfig?.contextLimit
			? { contextLimit: modelConfig.contextLimit }
			: {}),
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

export function toOpenAIMessages(
	request: ByokStreamRequest,
	imageSupport?: boolean,
	providerId?: string,
): unknown[] {
	const out: unknown[] = [{ role: "system", content: request.systemPrompt }];
	const acceptsImages = imageSupport ?? openAIModelAcceptsImages(request.model);
	const imagePlan = acceptsImages
		? planToolImages(request.messages)
		: new Set<string>();
	for (const [messageIndex, message] of request.messages.entries()) {
		if (message.role === "user") {
			out.push({
				role: "user",
				content: userContent(message, acceptsImages),
			});
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
					...(call.signature &&
					call.signatureProvider &&
					call.signatureProvider === providerId
						? {
								extra_content: {
									google: { thought_signature: call.signature },
								},
							}
						: {}),
				}));
			}
			out.push(entry);
			continue;
		}
		// Each tool result is its own message, matching one prior tool_call id.
		// Chat tool messages are text-only, so images ride in a user message
		// that follows the batch of results.
		const imageParts: unknown[] = [];
		for (const [resultIndex, result] of message.results.entries()) {
			const rendered = renderToolResult(
				result.output,
				imagePlan.has(`${messageIndex}:${resultIndex}`),
				undefined,
				acceptsImages ? "older screenshot" : "model does not accept images",
			);
			out.push({
				role: "tool",
				tool_call_id: result.id,
				content: rendered.text || "(no output)",
			});
			for (const image of rendered.images) {
				imageParts.push({
					type: "image_url",
					image_url: { url: imageDataUri(image) },
				});
			}
		}
		if (imageParts.length > 0) {
			out.push({
				role: "user",
				content: [{ type: "text", text: TOOL_IMAGE_NOTE }, ...imageParts],
			});
		}
	}
	return out;
}

function userContent(
	message: Extract<ByokMessage, { role: "user" }>,
	withImages = true,
): string | unknown[] {
	const attachments = message.attachments ?? [];
	if (attachments.length === 0) return message.content;

	const parts: unknown[] = [];
	for (const attachment of attachments) {
		if (attachment.base64) {
			parts.push(
				withImages
					? {
							type: "image_url",
							image_url: {
								url: `data:${attachment.mediaType};base64,${attachment.base64}`,
							},
						}
					: {
							type: "text",
							text: `Attached image ${attachment.path} omitted because this model does not accept images.`,
						},
			);
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
