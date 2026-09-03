import {
	type CustomModelDefinition,
	joinProviderUrl,
} from "../../../config/providers.ts";
import { contextWindowFor } from "../../../core/context/ContextWindow.ts";
import type { OpenAITool } from "../../../core/tools/schema.ts";
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
import {
	thinkingBudgetTokens,
	thinkingLevel,
	usesNativeAdaptiveThinking,
} from "../thinking.ts";
import { planToolImages, renderToolResult } from "../toolImages.ts";

const API_VERSION = "2023-06-01";
const DEFAULT_MAX_OUTPUT_TOKENS = 32_000;

/**
 * Per-family output ceilings, most specific first.
 *
 * `max_tokens` above a model's ceiling is a hard 400, not a clamp, and
 * `listModels` surfaces whatever the account can reach - including older
 * families whose ceiling is well below the default. Only families known to sit
 * below the default need an entry; anything newer keeps it.
 */
const MAX_OUTPUT_PATTERNS: ReadonlyArray<{ match: RegExp; tokens: number }> = [
	{ match: /^claude-3-7-sonnet/, tokens: 64_000 },
	{ match: /^claude-3-5-(?:sonnet|haiku)/, tokens: 8_192 },
	{ match: /^claude-3-(?:opus|sonnet|haiku)/, tokens: 4_096 },
];

export { toAnthropicMessages };

export function maxOutputTokensFor(model: string, requested: number): number {
	const name = model.trim().toLowerCase();
	for (const { match, tokens } of MAX_OUTPUT_PATTERNS) {
		if (match.test(name)) return Math.min(requested, tokens);
	}
	return requested;
}
/** Anthropic requires max_tokens > thinking.budget_tokens; keep room to answer. */
const MIN_ANSWER_TOKENS = 4_096;

/** Anthropic's cache breakpoint marker. Four are allowed per request. */
const EPHEMERAL = { type: "ephemeral" } as const;

interface AnthropicModelsResponse {
	data?: Array<{
		id?: string;
		display_name?: string;
		created_at?: string;
	}>;
}

/** One in-flight `tool_use` content block, assembled across input_json_deltas. */
interface PendingToolBlock {
	id: string;
	name: string;
	json: string;
}

export interface AnthropicAdapterOptions {
	id: string;
	label: string;
	baseUrl: string;
	consoleUrl?: string;
	keyHint?: string;
	requiresKey?: boolean;
	headers?: Record<string, string>;
	extraArgs?: Record<string, unknown>;
	modelsPath?: string;
	discoverModels?: boolean;
	models?: readonly CustomModelDefinition[];
}

const ANTHROPIC_OPTIONS: AnthropicAdapterOptions = {
	id: "anthropic",
	label: "Anthropic",
	baseUrl: "https://api.anthropic.com/v1",
	consoleUrl: "https://console.anthropic.com/settings/keys",
	keyHint: "sk-ant-...",
	requiresKey: true,
};

export const anthropicAdapter: ProviderAdapter =
	createAnthropicAdapter(ANTHROPIC_OPTIONS);

export function createAnthropicAdapter(
	options: AnthropicAdapterOptions,
): ProviderAdapter {
	return {
		id: options.id,
		label: options.label,
		consoleUrl: options.consoleUrl ?? options.baseUrl,
		keyHint: options.keyHint ?? "API key (optional for keyless endpoints)",
		requiresKey: options.requiresKey ?? true,

		looksLikeKey(key) {
			return options.id === "anthropic"
				? /^sk-ant-[\w-]{20,}$/.test(key.trim())
				: Boolean(key.trim()) || options.requiresKey === false;
		},

		async validateKey(key, signal) {
			if (options.discoverModels === false) return;
			// A models list is the cheapest authenticated GET: it costs no tokens
			// and still fails closed on a bad key.
			await getJson<AnthropicModelsResponse>(
				modelsUrlWithLimit(options, 1),
				requestHeaders(key, options),
				options.id,
				signal,
			);
		},

		async listModels(key, signal) {
			const response =
				options.discoverModels === false
					? { data: [] }
					: await getJson<AnthropicModelsResponse>(
							modelsUrlWithLimit(options, 1000),
							requestHeaders(key, options),
							options.id,
							signal,
						);
			const models = new Map<string, ModelCatalogItem>();
			for (const model of response.data ?? []) {
				if (!model.id) continue;
				models.set(model.id.toLowerCase(), {
					name: model.id,
					display_name: model.display_name,
					provider: options.id,
					model_type: "llm",
					last_updated: model.created_at ?? null,
					supports_thinking: true,
					thinking_controls: anthropicThinkingControls(model.id),
					context_limit: contextWindowFor({
						provider: options.id,
						model: model.id,
					}),
				});
			}
			for (const model of options.models ?? []) {
				if (model.enabled === false) {
					models.delete(model.id.toLowerCase());
					continue;
				}
				models.set(model.id.toLowerCase(), configuredModel(options.id, model));
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
				: anthropicThinkingControls(model);
		},

		stream(request, key) {
			return streamAnthropic(request, key, options);
		},
	};
}

function requestHeaders(
	key: string,
	options: AnthropicAdapterOptions,
): Record<string, string> {
	return {
		...(key.trim() ? { "x-api-key": key.trim() } : {}),
		"anthropic-version": API_VERSION,
		...options.headers,
	};
}

function modelsUrl(options: AnthropicAdapterOptions): string {
	return joinProviderUrl(options.baseUrl, options.modelsPath ?? "models");
}

function modelsUrlWithLimit(
	options: AnthropicAdapterOptions,
	limit: number,
): string {
	const url = new URL(modelsUrl(options));
	url.searchParams.set("limit", String(limit));
	return url.toString();
}

function configuredModel(
	provider: string,
	model: CustomModelDefinition,
): ModelCatalogItem {
	return {
		name: model.id,
		provider,
		model_type: "llm",
		...(model.name ? { display_name: model.name } : {}),
		...(model.contextLimit ? { context_limit: model.contextLimit } : {}),
		...(model.maxOutputTokens
			? { max_output_tokens: model.maxOutputTokens }
			: {}),
		...(typeof model.supportsThinking === "boolean"
			? { supports_thinking: model.supportsThinking }
			: { supports_thinking: true }),
		...(model.supportsThinking === false
			? {}
			: { thinking_controls: anthropicThinkingControls(model.id) }),
	};
}

function anthropicThinkingControls(
	model: string,
): NonNullable<ModelCatalogItem["thinking_controls"]> {
	return {
		supported: true,
		...(usesNativeAdaptiveThinking("anthropic", model)
			? { allowed_fields: ["effort"] }
			: {
					allowed_fields: ["budget_tokens"],
					budget_policy: "anthropicLegacy" as const,
				}),
		defaults_only: false,
	};
}

async function* streamAnthropic(
	request: ByokStreamRequest,
	key: string,
	options: AnthropicAdapterOptions = ANTHROPIC_OPTIONS,
): AsyncIterable<ProviderEvent> {
	const modelConfig = options.models?.find(
		(entry) => entry.id === request.model,
	);
	const maxTokens = maxOutputTokensFor(
		request.model,
		request.maxOutputTokens ??
			modelConfig?.maxOutputTokens ??
			DEFAULT_MAX_OUTPUT_TOKENS,
	);

	const body: Record<string, unknown> = {
		...options.extraArgs,
		...modelConfig?.extraArgs,
		model: request.model,
		max_tokens: maxTokens,
		// Blocks, not a bare string, so the prefix can carry a cache breakpoint.
		system: [
			{
				type: "text",
				text: request.systemPrompt,
				cache_control: EPHEMERAL,
			},
		],
		messages: toAnthropicMessages(
			request.messages,
			modelConfig?.noImageSupport !== true,
		),
		stream: true,
	};
	if (request.tools.length > 0) body.tools = toAnthropicTools(request.tools);
	applyAnthropicThinking(body, request, maxTokens);

	const blocks = new Map<number, PendingToolBlock>();
	const toolCalls: ProviderToolCall[] = [];
	let inputTokens = 0;
	let outputTokens = 0;
	let cachedTokens = 0;
	let cacheWriteTokens = 0;
	let truncatedCall = false;
	let messageStopped = false;

	const sseRequest: Parameters<typeof postSseJson>[0] = {
		url: joinProviderUrl(options.baseUrl, "messages"),
		headers: requestHeaders(key, options),
		body,
		provider: options.id,
	};
	if (request.signal) sseRequest.signal = request.signal;

	for await (const event of postSseJson(sseRequest)) {
		const type = event.type;

		if (type === "error") {
			const error = event.error as { message?: string } | undefined;
			yield {
				kind: "failed",
				error: error?.message ?? `${options.label} returned an error event`,
			};
			return;
		}

		if (type === "message_start") {
			const usage = usageOf(event.message);
			inputTokens = usage.input;
			cachedTokens = usage.cacheRead;
			cacheWriteTokens = usage.cacheWrite;
			continue;
		}

		if (type === "content_block_start") {
			const index = numberOf(event.index);
			const block = event.content_block as
				| { type?: string; id?: string; name?: string }
				| undefined;
			if (index === null || block?.type !== "tool_use") continue;
			const pending: PendingToolBlock = {
				id: block.id ?? `toolu_${index}`,
				name: block.name ?? "",
				json: "",
			};
			blocks.set(index, pending);
			yield { kind: "tool_started", id: pending.id, name: pending.name };
			continue;
		}

		if (type === "content_block_delta") {
			const index = numberOf(event.index);
			const delta = event.delta as
				| { type?: string; text?: string; partial_json?: string }
				| undefined;
			if (!delta) continue;
			if (delta.type === "text_delta" && delta.text) {
				yield { kind: "assistant_delta", text: delta.text };
				continue;
			}
			// thinking_delta / signature_delta carry reasoning the CLI does not
			// render; they are intentionally dropped rather than shown as text.
			if (delta.type === "input_json_delta" && index !== null) {
				const pending = blocks.get(index);
				if (pending) pending.json += delta.partial_json ?? "";
			}
			continue;
		}

		if (type === "content_block_stop") {
			const index = numberOf(event.index);
			if (index === null) continue;
			const pending = blocks.get(index);
			if (!pending) continue;
			blocks.delete(index);
			const input = parseToolInput(pending.json);
			// A block cut short by the output limit holds half-written JSON.
			// `tool_ready` is what starts read-only tools running ahead of the
			// round, so offering one would execute it on the wrong input. The
			// stop reason only arrives later, in message_delta - unparsable
			// arguments are the signal available here.
			if (input === null) {
				truncatedCall = true;
				continue;
			}
			const call: ProviderToolCall = {
				id: pending.id,
				name: pending.name,
				input,
			};
			toolCalls.push(call);
			yield { kind: "tool_ready", call };
			continue;
		}

		if (type === "message_delta") {
			const usage = usageOf(event);
			if (usage.output) outputTokens = usage.output;
			continue;
		}

		if (type === "message_stop") {
			messageStopped = true;
		}
	}

	if (!messageStopped) {
		yield {
			kind: "failed",
			error: unexpectedStreamEndMessage(options.label),
			retryable: true,
		};
		return;
	}

	// Anthropic reports `input_tokens` as *uncached* input only; the cached
	// portions are billed separately and reported separately. The prompt the
	// model actually saw is the sum, so anything reasoning about context size
	// (the /context readout, the auto-compression threshold) must add them back
	// or it under-reports a well-cached conversation by an order of magnitude.
	const promptTokens = inputTokens + cachedTokens + cacheWriteTokens;
	const usage = {
		inputTokens: promptTokens,
		outputTokens,
		totalTokens: promptTokens + outputTokens,
		cachedTokens,
		cacheWriteTokens,
		provider: options.id,
		model: request.model,
		...(modelConfig?.contextLimit
			? { contextLimit: modelConfig.contextLimit }
			: {}),
	};

	if (truncatedCall) {
		// Only a truncated *call* fails the turn. Text cut short at the limit
		// still answers something, so it completes as usual - but a tool call
		// that never finished leaves the turn with nothing to do and no hint
		// why. Retryable: the same request can succeed with more room.
		yield {
			kind: "failed",
			error:
				"The model hit its output limit while writing a tool call, so the call was incomplete.",
			retryable: true,
		};
		return;
	}

	// Trust the calls themselves rather than the stop reason: a turn that ran
	// out of room after emitting complete calls still has work to schedule.
	if (toolCalls.length > 0) {
		yield { kind: "usage", usage };
		yield { kind: "requires_action", runId: null, calls: toolCalls };
		return;
	}
	yield { kind: "completed", usage };
}

/**
 * Anthropic has two mutually exclusive thinking dialects, and sending the wrong
 * one is a hard 400 rather than a degraded answer:
 *
 *   - legacy   `thinking: {type:"enabled", budget_tokens}`
 *   - adaptive `thinking: {type:"adaptive"}` + top-level `output_config.effort`
 *
 * Claude 5 (and Opus 4.7+) accept only the adaptive form.
 */
export function applyAnthropicThinking(
	body: Record<string, unknown>,
	request: ByokStreamRequest,
	maxTokens: number,
): void {
	if (!request.thinking) return;

	if (usesNativeAdaptiveThinking("anthropic", request.model)) {
		const effort = thinkingLevel(request.thinking);
		body.thinking = { type: "adaptive" };
		// Effort is optional: omitting it leaves the model on its own default
		// rather than forcing a level the caller never asked for.
		if (effort) body.output_config = { effort };
		body.temperature = 1;
		return;
	}

	const rawBudget = thinkingBudgetTokens(
		request.thinking,
		"anthropicLegacy",
		maxTokens,
	);
	if (rawBudget === null) return;
	// Clamp rather than reject: an over-large budget is a caller mistake that
	// should degrade to "think as much as fits", not fail the turn.
	const budget = Math.min(
		rawBudget,
		Math.max(maxTokens - MIN_ANSWER_TOKENS, 1_024),
	);
	if (budget <= 0) return;
	body.thinking = { type: "enabled", budget_tokens: budget };
	// Extended thinking requires an unconstrained sampler.
	body.temperature = 1;
}

function usageOf(source: unknown): {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
} {
	const usage =
		typeof source === "object" && source !== null
			? ((source as Record<string, unknown>).usage as
					| Record<string, unknown>
					| undefined)
			: undefined;
	return {
		input: numberOf(usage?.input_tokens) ?? 0,
		output: numberOf(usage?.output_tokens) ?? 0,
		cacheRead: numberOf(usage?.cache_read_input_tokens) ?? 0,
		cacheWrite: numberOf(usage?.cache_creation_input_tokens) ?? 0,
	};
}

function numberOf(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** `null` means the arguments were cut off mid-JSON and cannot be trusted. */
function parseToolInput(json: string): unknown | null {
	const trimmed = json.trim();
	// Anthropic sends no input_json_delta at all for a no-argument tool.
	if (!trimmed) return {};
	try {
		return JSON.parse(trimmed);
	} catch {
		return null;
	}
}

/**
 * Tool definitions sit at the very front of the prompt and change only when the
 * tool set does, so a breakpoint on the last one caches the whole block.
 */
function toAnthropicTools(tools: readonly OpenAITool[]): unknown[] {
	return tools.map((tool, index) => ({
		name: tool.function.name,
		description: tool.function.description,
		input_schema: tool.function.parameters,
		...(index === tools.length - 1 ? { cache_control: EPHEMERAL } : {}),
	}));
}

/**
 * Renders the neutral transcript as Anthropic content blocks. Tool results are
 * `user` messages holding `tool_result` blocks - Anthropic has no tool role.
 *
 * The last block gets a rolling cache breakpoint. Without it only the static
 * prefix (tools + system) would ever be cached, and a long tool loop - which
 * resends the entire growing history on every leg - would bill the whole
 * transcript at full input price each time. With it, each leg writes only the
 * delta past the previous breakpoint and reads everything before it.
 */
function toAnthropicMessages(
	messages: readonly ByokMessage[],
	acceptsImages = true,
): unknown[] {
	const rendered = renderMessages(messages, acceptsImages);
	const last = rendered.at(-1);
	if (last) {
		const lastBlock = last.content.at(-1);
		if (lastBlock) lastBlock.cache_control = EPHEMERAL;
	}
	return rendered;
}

interface RenderedMessage {
	role: "user" | "assistant";
	content: Array<Record<string, unknown>>;
}

function renderMessages(
	messages: readonly ByokMessage[],
	acceptsImages: boolean,
): RenderedMessage[] {
	const out: RenderedMessage[] = [];
	const imagePlan = acceptsImages
		? planToolImages(messages)
		: new Set<string>();
	for (const [messageIndex, message] of messages.entries()) {
		if (message.role === "user") {
			out.push({
				role: "user",
				content: userContent(message, acceptsImages),
			});
			continue;
		}
		if (message.role === "assistant") {
			const content: Array<Record<string, unknown>> = [];
			if (message.content)
				content.push({ type: "text", text: message.content });
			for (const call of message.toolCalls) {
				content.push({
					type: "tool_use",
					id: call.id,
					name: call.name,
					input: call.input ?? {},
				});
			}
			// An assistant turn with neither text nor calls would be rejected as
			// an empty content array.
			if (content.length > 0) out.push({ role: "assistant", content });
			continue;
		}
		out.push({
			role: "user",
			content: message.results.map((result, resultIndex) => {
				const rendered = renderToolResult(
					result.output,
					imagePlan.has(`${messageIndex}:${resultIndex}`),
				);
				if (rendered.images.length === 0) {
					return {
						type: "tool_result",
						tool_use_id: result.id,
						content: rendered.text || "(no output)",
					};
				}
				return {
					type: "tool_result",
					tool_use_id: result.id,
					content: [
						{ type: "text", text: rendered.text || "(no output)" },
						...rendered.images.map((image) => ({
							type: "image",
							source: {
								type: "base64",
								media_type: image.mediaType,
								data: image.base64,
							},
						})),
					],
				};
			}),
		});
	}
	return out;
}

function userContent(
	message: Extract<ByokMessage, { role: "user" }>,
	acceptsImages: boolean,
): Array<Record<string, unknown>> {
	const content: Array<Record<string, unknown>> = [];
	for (const attachment of message.attachments ?? []) {
		if (attachment.base64 && acceptsImages) {
			content.push({
				type: "image",
				source: {
					type: "base64",
					media_type: attachment.mediaType,
					data: attachment.base64,
				},
			});
		} else if (attachment.base64) {
			content.push({
				type: "text",
				text: `[Image attachment omitted because this model is configured without image support: ${attachment.path}]`,
			});
		} else if (attachment.text) {
			content.push({
				type: "text",
				text: `Attached file ${attachment.path}:\n${attachment.text}`,
			});
		}
	}
	content.push({ type: "text", text: message.content || "(empty message)" });
	return content;
}
