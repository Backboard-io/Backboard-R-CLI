import { createHash } from "node:crypto";
import type { ThinkingConfig } from "../../../config/defaults.ts";
import type {
	ModelCatalogItem,
	ProviderEvent,
	ProviderToolCall,
} from "../../backboard/types.ts";
import {
	providerErrorMessage,
	unexpectedStreamEndMessage,
} from "../ByokError.ts";
import type {
	ByokMessage,
	ByokStreamRequest,
	ProviderAdapter,
} from "../ByokTypes.ts";
import { getJson, postSseJson } from "../httpStream.ts";
import {
	imageDataUri,
	planToolImages,
	renderToolResult,
	TOOL_IMAGE_NOTE,
} from "../toolImages.ts";
import {
	OPENROUTER_API_BASE,
	OPENROUTER_APP_TITLE,
	OPENROUTER_APP_URL,
	OPENROUTER_CATALOG_TTL_MS,
	OPENROUTER_REASONING_PARAMETERS,
	OPENROUTER_REQUIRED_MODEL_PARAMETERS,
} from "./OpenRouterAdapter.constants.ts";

interface OpenRouterModelsResponse {
	data?: OpenRouterModel[];
}

interface OpenRouterModel {
	id?: string;
	created?: number;
	context_length?: number;
	top_provider?: { max_completion_tokens?: number | null };
	supported_parameters?: string[];
	architecture?: {
		input_modalities?: string[];
		output_modalities?: string[];
	};
}

interface PendingToolCall {
	id: string;
	name: string;
	args: string;
	announced: boolean;
}

interface OpenRouterCatalog {
	models: ModelCatalogItem[];
	imageInputModels: Set<string>;
}

interface CachedOpenRouterCatalog {
	credentialId: string;
	expiresAt: number;
	value?: OpenRouterCatalog;
	pending?: Promise<OpenRouterCatalog>;
}

let cachedCatalog: CachedOpenRouterCatalog | null = null;

export const openRouterAdapter: ProviderAdapter = {
	id: "openrouter",
	label: "OpenRouter",
	consoleUrl: "https://openrouter.ai/settings/keys",
	keyHint: "sk-or-v1-...",

	looksLikeKey(key) {
		return /^sk-or-v1-[\w-]{20,}$/.test(key.trim());
	},

	async validateKey(key, signal) {
		await getJson<unknown>(
			`${OPENROUTER_API_BASE}/key`,
			headers(key),
			"openrouter",
			signal,
		);
	},

	async listModels(key, signal) {
		return (await waitForSignal(loadCatalog(key), signal)).models;
	},

	async supportsThinking(model, key) {
		const catalog = await loadCatalog(key);
		return (
			catalog.models.find((candidate) => candidate.name === model)
				?.supports_thinking === true
		);
	},

	stream(request, key) {
		return streamOpenRouter(request, key);
	},
};

export function isOpenRouterChatModel(model: OpenRouterModel): boolean {
	if (!model.id) return false;
	const parameters = new Set(model.supported_parameters ?? []);
	if (
		!OPENROUTER_REQUIRED_MODEL_PARAMETERS.every((parameter) =>
			parameters.has(parameter),
		)
	) {
		return false;
	}
	const input = model.architecture?.input_modalities;
	const output = model.architecture?.output_modalities;
	return (
		(input?.includes("text") ?? true) && (output?.includes("text") ?? true)
	);
}

export function supportsOpenRouterThinking(
	supportedParameters: readonly string[] | undefined,
): boolean {
	return supportsReasoningParameter(supportedParameters);
}

async function* streamOpenRouter(
	request: ByokStreamRequest,
	key: string,
): AsyncIterable<ProviderEvent> {
	let catalog = cachedCatalogValue(key);
	if (!catalog && requestContainsImages(request)) {
		catalog = await waitForSignal(loadCatalog(key), request.signal);
	}
	const modelMetadata: { value: ModelCatalogItem | null } = {
		value:
			catalog?.models.find((candidate) => candidate.name === request.model) ??
			null,
	};
	void loadCatalog(key)
		.then((loaded) => {
			modelMetadata.value =
				loaded.models.find((candidate) => candidate.name === request.model) ??
				null;
		})
		.catch(() => {});
	const acceptsImages = catalog?.imageInputModels.has(request.model) === true;
	const body: Record<string, unknown> = {
		model: request.model,
		messages: toOpenRouterMessages(request, acceptsImages),
		stream: true,
		stream_options: { include_usage: true },
	};
	if (request.tools.length > 0) {
		body.tools = request.tools;
		body.tool_choice = "auto";
		body.provider = { require_parameters: true };
	}
	const reasoning = openRouterReasoning(request.thinking);
	if (reasoning) body.reasoning = reasoning;
	if (request.maxOutputTokens) body.max_tokens = request.maxOutputTokens;

	const pending = new Map<number, PendingToolCall>();
	const reasoningDetails = new Map<string, Record<string, unknown>>();
	let finishReason: string | null = null;
	let usage = emptyUsage();

	const sseRequest: Parameters<typeof postSseJson>[0] = {
		url: `${OPENROUTER_API_BASE}/chat/completions`,
		headers: headers(key),
		body,
		provider: "openrouter",
	};
	if (request.signal) sseRequest.signal = request.signal;

	for await (const chunk of postSseJson(sseRequest)) {
		if (chunk.error) {
			const retryable = isRetryableOpenRouterError(chunk.error);
			yield {
				kind: "failed",
				error:
					providerErrorMessage(chunk) ?? "OpenRouter returned an error event",
				...(retryable ? { retryable: true } : {}),
			};
			return;
		}

		const chunkUsage = chunk.usage as Record<string, unknown> | undefined;
		if (chunkUsage) usage = readUsage(chunkUsage);

		const choice = (chunk.choices as unknown[] | undefined)?.[0] as
			| {
					delta?: {
						content?: string | null;
						reasoning_details?: unknown[];
						tool_calls?: Array<{
							index?: number;
							id?: string;
							function?: { name?: string; arguments?: string };
						}>;
					};
					finish_reason?: string | null;
					error?: { message?: string };
			  }
			| undefined;
		if (!choice) continue;
		if (choice.error) {
			const retryable = isRetryableOpenRouterError(choice.error);
			yield {
				kind: "failed",
				error:
					providerErrorMessage(choice) ?? "OpenRouter returned an error choice",
				...(retryable ? { retryable: true } : {}),
			};
			return;
		}
		if (choice.finish_reason) finishReason = choice.finish_reason;

		const delta = choice.delta;
		if (delta?.content) {
			yield { kind: "assistant_delta", text: delta.content };
		}
		if (Array.isArray(delta?.reasoning_details)) {
			mergeReasoningDetails(reasoningDetails, delta.reasoning_details);
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
			if (!existing.announced && existing.name) {
				existing.announced = true;
				yield { kind: "tool_started", id: existing.id, name: existing.name };
			}
		}
	}

	if (finishReason === null) {
		yield {
			kind: "failed",
			error: unexpectedStreamEndMessage("openrouter"),
			retryable: true,
		};
		return;
	}

	if (finishReason === "length" && pending.size > 0) {
		yield {
			kind: "failed",
			error:
				"The model hit its output limit while writing a tool call, so the call was incomplete.",
			retryable: true,
		};
		return;
	}

	const calls: ProviderToolCall[] = [];
	const collectedReasoning = [...reasoningDetails.values()];
	const providerMetadata =
		collectedReasoning.length > 0
			? JSON.stringify(collectedReasoning)
			: undefined;
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

	const contextLimit = modelMetadata.value?.context_limit ?? null;
	const finalUsage = {
		...usage,
		provider: "openrouter",
		model: request.model,
		...(contextLimit ? { contextLimit } : {}),
	};
	if (calls.length > 0) {
		yield { kind: "usage", usage: finalUsage };
		yield {
			kind: "requires_action",
			runId: null,
			calls,
			...(providerMetadata ? { providerMetadata } : {}),
		};
		return;
	}
	yield { kind: "completed", usage: finalUsage };
}

function headers(key: string): Record<string, string> {
	return {
		Authorization: `Bearer ${key.trim()}`,
		"HTTP-Referer": OPENROUTER_APP_URL,
		"X-OpenRouter-Title": OPENROUTER_APP_TITLE,
	};
}

function supportsReasoningParameter(
	supportedParameters: readonly string[] | undefined,
): boolean {
	const parameters = new Set(supportedParameters ?? []);
	return OPENROUTER_REASONING_PARAMETERS.some((parameter) =>
		parameters.has(parameter),
	);
}

async function loadCatalog(key: string): Promise<OpenRouterCatalog> {
	const normalizedKey = key.trim();
	const credentialId = createHash("sha256").update(normalizedKey).digest("hex");
	if (cachedCatalog?.credentialId === credentialId) {
		if (cachedCatalog.value && cachedCatalog.expiresAt > Date.now()) {
			return cachedCatalog.value;
		}
		if (cachedCatalog.pending) return cachedCatalog.pending;
	}

	const pending = fetchCatalog(normalizedKey);
	cachedCatalog = {
		credentialId,
		expiresAt: 0,
		...(cachedCatalog?.credentialId === credentialId && cachedCatalog.value
			? { value: cachedCatalog.value }
			: {}),
		pending,
	};
	try {
		const value = await pending;
		if (cachedCatalog?.pending === pending) {
			cachedCatalog = {
				credentialId,
				expiresAt: Date.now() + OPENROUTER_CATALOG_TTL_MS,
				value,
			};
		}
		return value;
	} catch (error) {
		if (cachedCatalog?.pending === pending) {
			const stale = cachedCatalog.value;
			if (stale !== undefined) {
				cachedCatalog = {
					credentialId,
					expiresAt: Date.now() + OPENROUTER_CATALOG_TTL_MS,
					value: stale,
				};
				return stale;
			}
			cachedCatalog = null;
		}
		throw error;
	}
}

function requestContainsImages(request: ByokStreamRequest): boolean {
	return (
		request.messages.some(
			(message) =>
				message.role === "user" &&
				message.attachments?.some((attachment) => attachment.base64) === true,
		) || planToolImages(request.messages, 1).size > 0
	);
}

function cachedCatalogValue(key: string): OpenRouterCatalog | null {
	const credentialId = createHash("sha256").update(key.trim()).digest("hex");
	return cachedCatalog?.credentialId === credentialId &&
		cachedCatalog.value &&
		cachedCatalog.expiresAt > Date.now()
		? cachedCatalog.value
		: null;
}

async function fetchCatalog(
	key: string,
	signal?: AbortSignal,
): Promise<OpenRouterCatalog> {
	const response = await getJson<OpenRouterModelsResponse>(
		`${OPENROUTER_API_BASE}/models/user`,
		headers(key),
		"openrouter",
		signal,
	);
	const models: ModelCatalogItem[] = [];
	const imageInputModels = new Set<string>();
	for (const model of response.data ?? []) {
		if (!isOpenRouterChatModel(model)) continue;
		const id = model.id as string;
		const supportsThinking = supportsReasoningParameter(
			model.supported_parameters,
		);
		const inputModalities = model.architecture?.input_modalities;
		if (!inputModalities || inputModalities.includes("image")) {
			imageInputModels.add(id);
		}
		models.push({
			name: id,
			provider: "openrouter",
			model_type: "llm",
			last_updated:
				typeof model.created === "number" ? model.created * 1000 : null,
			context_limit: positiveNumber(model.context_length),
			max_output_tokens: positiveNumber(
				model.top_provider?.max_completion_tokens,
			),
			supports_thinking: supportsThinking,
		});
	}
	return { models, imageInputModels };
}

function positiveNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? value
		: null;
}

function openRouterReasoning(
	thinking: ThinkingConfig | null | undefined,
): Record<string, unknown> | null {
	if (!thinking) return null;
	if ("max_tokens" in thinking) {
		return { max_tokens: thinking.max_tokens };
	}
	if ("budget_tokens" in thinking) {
		return { max_tokens: thinking.budget_tokens };
	}
	if (!("effort" in thinking)) return null;
	return {
		effort: thinking.effort === "max" ? "high" : thinking.effort,
	};
}

function emptyUsage(): {
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
	cachedTokens: number;
	costUsd: number;
} {
	return {
		inputTokens: 0,
		outputTokens: 0,
		totalTokens: 0,
		cachedTokens: 0,
		costUsd: 0,
	};
}

function readUsage(
	usage: Record<string, unknown>,
): ReturnType<typeof emptyUsage> {
	const details = usage.prompt_tokens_details as
		| Record<string, unknown>
		| undefined;
	return {
		inputTokens: numberOf(usage.prompt_tokens),
		outputTokens: numberOf(usage.completion_tokens),
		totalTokens: numberOf(usage.total_tokens),
		cachedTokens: numberOf(details?.cached_tokens),
		costUsd: numberOf(usage.cost),
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

export function toOpenRouterMessages(
	request: ByokStreamRequest,
	withImages = true,
): unknown[] {
	const out: unknown[] = [{ role: "system", content: request.systemPrompt }];
	const imagePlan = withImages
		? planToolImages(request.messages)
		: new Set<string>();
	for (const [messageIndex, message] of request.messages.entries()) {
		if (message.role === "user") {
			out.push({ role: "user", content: userContent(message, withImages) });
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
				const reasoningDetails = readReasoningDetails(message.providerMetadata);
				if (reasoningDetails) entry.reasoning_details = reasoningDetails;
			}
			out.push(entry);
			continue;
		}
		// Chat tool messages are text-only, so images ride in a user message
		// that follows the batch of results.
		const imageParts: unknown[] = [];
		for (const [resultIndex, result] of message.results.entries()) {
			const rendered = renderToolResult(
				result.output,
				imagePlan.has(`${messageIndex}:${resultIndex}`),
				undefined,
				withImages ? "older screenshot" : "model does not accept images",
			);
			out.push({
				role: "tool",
				tool_call_id: result.id,
				name: result.name,
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

function isRetryableOpenRouterError(error: unknown): boolean {
	if (typeof error !== "object" || error === null) return false;
	const rawCode = (error as Record<string, unknown>).code;
	const code =
		typeof rawCode === "number"
			? rawCode
			: typeof rawCode === "string"
				? Number(rawCode)
				: Number.NaN;
	return code === 502 || code === 503 || code === 504;
}

function readReasoningDetails(signature: string | undefined): unknown[] | null {
	if (!signature) return null;
	try {
		const parsed: unknown = JSON.parse(signature);
		return Array.isArray(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

function mergeReasoningDetails(
	pending: Map<string, Record<string, unknown>>,
	details: readonly unknown[],
): void {
	for (const [position, detail] of details.entries()) {
		if (
			typeof detail !== "object" ||
			detail === null ||
			Array.isArray(detail)
		) {
			continue;
		}
		const incoming = detail as Record<string, unknown>;
		const type = typeof incoming.type === "string" ? incoming.type : "unknown";
		const key =
			typeof incoming.id === "string" && incoming.id
				? `id:${incoming.id}:${type}`
				: typeof incoming.index === "number" && Number.isFinite(incoming.index)
					? `index:${incoming.index}:${type}`
					: `position:${position}:${type}`;
		const existing = pending.get(key) ?? {};
		const merged = { ...existing, ...incoming };
		if (typeof incoming.text === "string") {
			merged.text =
				typeof existing.text === "string"
					? `${existing.text}${incoming.text}`
					: incoming.text;
		}
		pending.set(key, merged);
	}
}

function waitForSignal<T>(
	promise: Promise<T>,
	signal?: AbortSignal,
): Promise<T> {
	if (!signal) return promise;
	if (signal.aborted) return Promise.reject(abortReason(signal));
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(abortReason(signal));
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

function abortReason(signal: AbortSignal): unknown {
	return (
		signal.reason ??
		new DOMException("The operation was aborted.", "AbortError")
	);
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
