import { joinProviderUrl } from "../../../config/providers.ts";
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
import { compatibleOpenAITools } from "../openAIToolSchemas.ts";
import { thinkingEffort } from "../thinking.ts";
import {
	planToolImages,
	renderToolResult,
	TOOL_IMAGE_NOTE,
} from "../toolImages.ts";
import type { ConfigurableAdapterOptions } from "./ConfigurableAdapterTypes.ts";
import {
	configurableModelsUrl,
	configuredOpenAIModel,
	effortThinkingControls,
	type OpenAICompatibleModelsResponse,
	openAICompatibleHeaders,
} from "./OpenAICompatibleShared.ts";

export type OpenAIResponsesAdapterOptions = ConfigurableAdapterOptions;

interface PendingCall {
	id: string;
	name: string;
	args: string;
	announced: boolean;
}

export function createOpenAIResponsesAdapter(
	options: OpenAIResponsesAdapterOptions,
): ProviderAdapter {
	return {
		id: options.id,
		label: options.label,
		consoleUrl: options.consoleUrl ?? options.baseUrl,
		keyHint: options.keyHint ?? "API key (optional for keyless endpoints)",
		requiresKey: options.requiresKey ?? true,
		looksLikeKey(key) {
			return Boolean(key.trim()) || options.requiresKey === false;
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
				if (!id || !isResponsesModel(id)) continue;
				models.set(id.toLowerCase(), {
					name: id,
					provider: options.id,
					model_type: "llm",
					last_updated:
						typeof model.created === "number" ? model.created * 1000 : null,
					context_limit: contextWindowFor({
						provider: options.id,
						model: id,
					}),
					supports_thinking: true,
					thinking_controls: effortThinkingControls(),
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
			return streamResponses(request, key, options);
		},
	};
}

async function* streamResponses(
	request: ByokStreamRequest,
	key: string,
	options: OpenAIResponsesAdapterOptions,
): AsyncIterable<ProviderEvent> {
	const modelConfig = options.models?.find(
		(entry) => entry.id === request.model,
	);
	const body: Record<string, unknown> = {
		...options.extraArgs,
		...modelConfig?.extraArgs,
		model: request.model,
		instructions: request.systemPrompt,
		input: toResponsesInput(
			request.messages,
			modelConfig?.noImageSupport !== true,
			options.id,
		),
		stream: true,
	};
	if (request.tools.length > 0) {
		body.tools = toResponsesTools(request.tools);
		body.tool_choice = "auto";
		body.parallel_tool_calls = true;
	}
	const effort = thinkingEffort(request.thinking);
	if (effort) body.reasoning = { effort };
	const maxOutputTokens =
		request.maxOutputTokens ?? modelConfig?.maxOutputTokens;
	if (maxOutputTokens) body.max_output_tokens = maxOutputTokens;
	if (request.cacheKey) body.prompt_cache_key = request.cacheKey;

	const pending = new Map<string, PendingCall>();
	const itemToCall = new Map<string, string>();
	const metadata: unknown[] = [];
	let terminal = false;
	let usage = emptyUsage();

	const sseRequest: Parameters<typeof postSseJson>[0] = {
		url: joinProviderUrl(options.baseUrl, "responses"),
		headers: openAICompatibleHeaders(key, options),
		body,
		provider: options.id,
	};
	if (request.signal) sseRequest.signal = request.signal;

	for await (const event of postSseJson(sseRequest)) {
		const type = typeof event.type === "string" ? event.type : "";
		if (!type && (event.object === "response" || Array.isArray(event.output))) {
			terminal = true;
			usage = readUsage(objectOf(event.usage));
			for (const raw of arrayOf(event.output)) {
				const item = objectOf(raw);
				if (item?.type === "message") {
					for (const content of arrayOf(item.content)) {
						const block = objectOf(content);
						if (block?.type === "output_text" && stringOf(block.text)) {
							yield {
								kind: "assistant_delta",
								text: stringOf(block.text) as string,
							};
						}
						if (block?.type === "refusal" && stringOf(block.refusal)) {
							yield {
								kind: "assistant_delta",
								text: stringOf(block.refusal) as string,
							};
						}
					}
				}
				if (item?.type === "reasoning") metadata.push(item);
				if (item?.type !== "function_call") continue;
				const id = stringOf(item.call_id) ?? stringOf(item.id) ?? "call_0";
				pending.set(id, {
					id,
					name: stringOf(item.name) ?? "",
					args: stringOf(item.arguments) ?? "",
					announced: false,
				});
			}
			continue;
		}
		if (type === "error" || type === "response.failed") {
			terminal = true;
			const error = (event.error ??
				(event.response as Record<string, unknown> | undefined)?.error) as
				| { message?: string }
				| undefined;
			yield {
				kind: "failed",
				error: error?.message ?? `${options.label} returned a failed response`,
			};
			return;
		}
		if (type === "response.output_text.delta") {
			const delta = typeof event.delta === "string" ? event.delta : "";
			if (delta) yield { kind: "assistant_delta", text: delta };
			continue;
		}
		if (type === "response.refusal.delta") {
			const delta = typeof event.delta === "string" ? event.delta : "";
			if (delta) yield { kind: "assistant_delta", text: delta };
			continue;
		}
		if (type === "response.output_item.added") {
			const item = objectOf(event.item);
			if (item?.type !== "function_call") continue;
			const id = stringOf(item.call_id) ?? stringOf(item.id) ?? "call_0";
			const itemId = stringOf(item.id);
			if (itemId) itemToCall.set(itemId, id);
			const call: PendingCall = {
				id,
				name: stringOf(item.name) ?? "",
				args: stringOf(item.arguments) ?? "",
				announced: false,
			};
			pending.set(id, call);
			if (call.name) {
				call.announced = true;
				yield { kind: "tool_started", id: call.id, name: call.name };
			}
			continue;
		}
		if (type === "response.function_call_arguments.delta") {
			const eventId =
				stringOf(event.call_id) ?? stringOf(event.item_id) ?? "call_0";
			const id = itemToCall.get(eventId) ?? eventId;
			const call = pending.get(id) ?? {
				id,
				name: stringOf(event.name) ?? "",
				args: "",
				announced: false,
			};
			call.args += stringOf(event.delta) ?? "";
			pending.set(id, call);
			if (!call.announced && call.name) {
				call.announced = true;
				yield { kind: "tool_started", id: call.id, name: call.name };
			}
			continue;
		}
		if (type === "response.output_item.done") {
			const item = objectOf(event.item);
			if (!item) continue;
			if (item.type === "reasoning") metadata.push(item);
			if (item.type !== "function_call") continue;
			const itemId = stringOf(item.id);
			const id =
				stringOf(item.call_id) ??
				(itemId ? itemToCall.get(itemId) : null) ??
				itemId ??
				"call_0";
			const call = pending.get(id) ?? {
				id,
				name: "",
				args: "",
				announced: false,
			};
			call.name = stringOf(item.name) ?? call.name;
			call.args = stringOf(item.arguments) ?? call.args;
			pending.set(id, call);
			continue;
		}
		if (type === "response.completed" || type === "response.incomplete") {
			terminal = true;
			const response = objectOf(event.response);
			usage = readUsage(objectOf(response?.usage));
			for (const raw of arrayOf(response?.output)) {
				const item = objectOf(raw);
				if (item?.type !== "function_call") continue;
				const id = stringOf(item.call_id) ?? stringOf(item.id) ?? "call_0";
				const call = pending.get(id) ?? {
					id,
					name: "",
					args: "",
					announced: false,
				};
				call.name = stringOf(item.name) ?? call.name;
				call.args = stringOf(item.arguments) ?? call.args;
				pending.set(id, call);
			}
			if (type === "response.incomplete" && pending.size > 0) {
				yield {
					kind: "failed",
					error:
						"The model hit its output limit while writing a tool call, so the call was incomplete.",
					retryable: true,
				};
				return;
			}
		}
	}

	if (!terminal) {
		yield {
			kind: "failed",
			error: unexpectedStreamEndMessage(options.label),
			retryable: true,
		};
		return;
	}

	const calls: ProviderToolCall[] = [];
	for (const call of pending.values()) {
		if (!call.name) continue;
		const input = parseArguments(call.args);
		if (input === null) {
			yield {
				kind: "failed",
				error: `The provider returned invalid JSON arguments for tool ${call.name}.`,
			};
			return;
		}
		const ready: ProviderToolCall = {
			id: call.id,
			name: call.name,
			input,
		};
		calls.push(ready);
	}
	for (const call of calls) {
		yield { kind: "tool_ready", call };
	}
	const finalUsage = {
		...usage,
		provider: options.id,
		model: request.model,
		...(modelConfig?.contextLimit
			? { contextLimit: modelConfig.contextLimit }
			: {}),
	};
	if (calls.length > 0) {
		yield { kind: "usage", usage: finalUsage };
		yield {
			kind: "requires_action",
			runId: null,
			calls,
			...(metadata.length > 0
				? {
						providerMetadata: JSON.stringify({
							provider: options.id,
							items: metadata,
						}),
					}
				: {}),
		};
		return;
	}
	yield { kind: "completed", usage: finalUsage };
}

function toResponsesInput(
	messages: readonly ByokMessage[],
	acceptsImages: boolean,
	providerId: string,
): unknown[] {
	const input: unknown[] = [];
	const imagePlan = acceptsImages
		? planToolImages(messages)
		: new Set<string>();
	for (const [messageIndex, message] of messages.entries()) {
		if (message.role === "user") {
			const content: unknown[] = [
				{ type: "input_text", text: message.content },
			];
			for (const attachment of message.attachments ?? []) {
				if (
					acceptsImages &&
					attachment.base64 &&
					attachment.mediaType.startsWith("image/")
				) {
					content.push({
						type: "input_image",
						image_url: `data:${attachment.mediaType};base64,${attachment.base64}`,
					});
				} else if (attachment.base64) {
					content.push({
						type: "input_text",
						text: `\n\n[Image attachment omitted because this model is configured without image support: ${attachment.path}]`,
					});
				} else if (attachment.text) {
					content.push({
						type: "input_text",
						text: `\n\n<attachment path="${attachment.path}">\n${attachment.text}\n</attachment>`,
					});
				}
			}
			input.push({ role: "user", content });
			continue;
		}
		if (message.role === "assistant") {
			const metadata = parseMetadata(message.providerMetadata, providerId);
			input.push(...metadata);
			if (message.content) {
				input.push({
					role: "assistant",
					content: [{ type: "output_text", text: message.content }],
				});
			}
			for (const call of message.toolCalls) {
				input.push({
					type: "function_call",
					call_id: call.id,
					name: call.name,
					arguments: JSON.stringify(call.input ?? {}),
				});
			}
			continue;
		}
		const images: Array<{ mediaType: string; base64: string }> = [];
		for (const [resultIndex, result] of message.results.entries()) {
			const rendered = renderToolResult(
				result.output,
				imagePlan.has(`${messageIndex}:${resultIndex}`),
				undefined,
				acceptsImages ? "older screenshot" : "model does not accept images",
			);
			input.push({
				type: "function_call_output",
				call_id: result.id,
				output: rendered.text || "(no output)",
			});
			images.push(...rendered.images);
		}
		if (images.length > 0) {
			input.push({
				role: "user",
				content: [
					{ type: "input_text", text: TOOL_IMAGE_NOTE },
					...images.map((image) => ({
						type: "input_image",
						image_url: `data:${image.mediaType};base64,${image.base64}`,
					})),
				],
			});
		}
	}
	return input;
}

function toResponsesTools(tools: readonly OpenAITool[]): unknown[] {
	return compatibleOpenAITools(tools).map((tool) => ({
		type: "function",
		name: tool.function.name,
		description: tool.function.description,
		parameters: tool.function.parameters,
	}));
}

function parseMetadata(
	value: string | undefined,
	providerId: string,
): unknown[] {
	if (!value) return [];
	try {
		const parsed = JSON.parse(value);
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			(parsed as { provider?: unknown }).provider === providerId &&
			Array.isArray((parsed as { items?: unknown }).items)
		) {
			return (parsed as { items: unknown[] }).items;
		}
		return [];
	} catch {
		return [];
	}
}

function parseArguments(value: string): unknown | null {
	if (!value.trim()) return {};
	try {
		return JSON.parse(value);
	} catch {
		return null;
	}
}

function isResponsesModel(id: string): boolean {
	return !/(?:embedding|whisper|tts|dall-e|moderation|audio|realtime|image|transcribe|search)/i.test(
		id,
	);
}

function readUsage(value: Record<string, unknown> | null): {
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
	cachedTokens: number;
} {
	const inputTokens = numberOf(value?.input_tokens);
	const outputTokens = numberOf(value?.output_tokens);
	const cachedTokens = numberOf(
		objectOf(value?.input_tokens_details)?.cached_tokens,
	);
	return {
		inputTokens,
		outputTokens,
		totalTokens: numberOf(value?.total_tokens) || inputTokens + outputTokens,
		cachedTokens,
	};
}

function emptyUsage(): ReturnType<typeof readUsage> {
	return { inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedTokens: 0 };
}

function objectOf(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function stringOf(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

function numberOf(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function arrayOf(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}
